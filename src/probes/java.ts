/**
 * The one structural-parse dependency (#5, point 4).
 *
 * Three of #5's eight discovery probes genuinely need a parse tree - sealed
 * hierarchies, throw-vs-return and dependency asymmetry - because the questions
 * they ask are about structure rather than text. The other five stay grep-class,
 * because #5 is explicit that no probe should be forced through a parse tree that
 * a scan answers: the discovery report's "trivial grep, valuable because someone
 * framed the question" finding stands. The Flow producer's two Java entry
 * adapters (#35) also read structure, and route through this same module; its
 * TypeScript client adapter reads lexically and never touches this parser.
 *
 * The grammar is a vendored WASM asset rather than a package dependency. The
 * only npm package shipping a prebuilt Java grammar bundles about forty of them
 * at 50 MB, for one 430 KB file, which is not a defensible footprint for a tool
 * distributed with npx - the same reasoning that put Graphviz behind WASM rather
 * than a native binary. `web-tree-sitter` is pinned to the ABI the vendored
 * grammar was built against; the two move together or not at all.
 */
import { readFileSync } from "node:fs";
import Parser from "web-tree-sitter";

const GRAMMAR = new URL("../../assets/tree-sitter-java.wasm", import.meta.url);

type AnyParser = {
  setLanguage: (lang: unknown) => void;
  parse: (source: string) => { rootNode: SyntaxNode };
};

/** The subset of tree-sitter's node surface these probes use. */
export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  namedChildCount: number;
  child: (i: number) => SyntaxNode | null;
  namedChild: (i: number) => SyntaxNode | null;
  childForFieldName: (name: string) => SyntaxNode | null;
  parent: SyntaxNode | null;
}

let parserPromise: Promise<AnyParser> | null = null;

const load = async (): Promise<AnyParser> => {
  if (parserPromise) return parserPromise;
  parserPromise = (async () => {
    const P = Parser as unknown as {
      init: () => Promise<void>;
      new (): AnyParser;
      Language: { load: (b: Uint8Array) => Promise<unknown> };
    };
    await P.init();
    const language = await P.Language.load(readFileSync(GRAMMAR));
    const parser = new P();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
};

export const parseJava = async (source: string): Promise<SyntaxNode> =>
  (await load()).parse(source).rootNode;

/** Depth-first walk. Probes read structure; none of them mutate the tree. */
export const walk = (node: SyntaxNode, visit: (n: SyntaxNode) => void): void => {
  visit(node);
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child) walk(child, visit);
  }
};

export const findAll = (root: SyntaxNode, type: string): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  walk(root, (n) => {
    if (n.type === type) out.push(n);
  });
  return out;
};

export const nameOf = (node: SyntaxNode): string | null =>
  node.childForFieldName("name")?.text ?? null;

/**
 * The declared parameter types of a method, in order.
 *
 * Two overloads share a name; their signatures do not. This is the semantic
 * discriminator that keeps a candidate id unique within one file when a class
 * carries `add(E)` and `add(int, E)` both refusing outright.
 */
export const paramTypesOf = (method: SyntaxNode): string[] => {
  const params = method.childForFieldName("parameters");
  if (!params) return [];
  const out: string[] = [];
  for (let i = 0; i < params.namedChildCount; i += 1) {
    const p = params.namedChild(i);
    const type = p?.childForFieldName("type")?.text;
    if (type) out.push(type);
  }
  return out;
};

const TYPE_DECLARATION = /^(class|interface|record|enum|annotation_type)_declaration$/;

/**
 * The names of the type declarations enclosing a node, outermost first.
 *
 * Two nested types can share a simple name across different enclosing types in
 * one file (`A.X` and `B.X`); the enclosing path is what tells them apart.
 */
export const enclosingTypeNames = (node: SyntaxNode): string[] => {
  const names: string[] = [];
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (TYPE_DECLARATION.test(cur.type)) {
      const name = nameOf(cur);
      if (name) names.unshift(name);
    }
  }
  return names;
};

/**
 * The simple names of every type declaration in a parse tree.
 *
 * A sibling comparison keys on shared supertypes, but a supertype is only a
 * shape the subject itself designed when the subject declares it. A JDK or
 * third-party interface (`Comparable`, `Runnable`) is shared by types that
 * decided nothing together, so callers intersect a supertype set with this to
 * keep only the supertypes the tree actually defines.
 */
export const declaredTypeNames = (root: SyntaxNode): string[] => {
  const names: string[] = [];
  walk(root, (n) => {
    if (TYPE_DECLARATION.test(n.type)) {
      const name = nameOf(n);
      if (name) names.push(name);
    }
  });
  return names;
};

/** The nearest enclosing type declaration of a node, or null if it is top-level. */
export const enclosingTypeNode = (node: SyntaxNode): SyntaxNode | null => {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (TYPE_DECLARATION.test(cur.type)) return cur;
  }
  return null;
};

/** The simple name of a type node, stripping generic arguments and package path. */
const baseTypeName = (type: SyntaxNode): string | null => {
  if (type.type === "type_identifier") return type.text;
  if (type.type === "scoped_type_identifier") {
    const parts = type.text.split(".");
    return parts[parts.length - 1] ?? null;
  }
  if (type.type === "generic_type") {
    const base = type.namedChild(0);
    return base ? baseTypeName(base) : null;
  }
  return null;
};

const SUPERTYPE_CLAUSES = new Set(["superclass", "super_interfaces", "extends_interfaces"]);

/**
 * The simple names of the types a declaration extends or implements.
 *
 * Reads the `superclass`, `super_interfaces` and `extends_interfaces` clauses,
 * so `class A extends Base implements Runner` yields {Base, Runner}. Generic and
 * package-qualified supertypes collapse to their simple name (`Comparable`, not
 * `java.lang.Comparable<A>`), which is what a sibling comparison keys on.
 */
export const supertypeNamesOf = (type: SyntaxNode): Set<string> => {
  const names = new Set<string>();
  for (let i = 0; i < type.namedChildCount; i += 1) {
    const clause = type.namedChild(i);
    if (!clause || !SUPERTYPE_CLAUSES.has(clause.type)) continue;
    for (let j = 0; j < clause.namedChildCount; j += 1) {
      const child = clause.namedChild(j);
      if (!child) continue;
      const types =
        child.type === "type_list"
          ? Array.from({ length: child.namedChildCount }, (_, k) => child.namedChild(k))
          : [child];
      for (const t of types) {
        const name = t ? baseTypeName(t) : null;
        if (name) names.add(name);
      }
    }
  }
  return names;
};

/**
 * The directory a file sits in - the peer set two structural probes agree on.
 *
 * A repo-root file has no slash; `lastIndexOf` returns -1 and a bare slice would
 * drop the final character, stranding each root class in its own bogus one-member
 * directory instead of the shared root. Both `dependency-asymmetry` and
 * `throw-where-siblings-return` compare "siblings", and they must not quietly
 * disagree about what a directory sibling is, so the definition lives here once.
 */
export const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

/** 1-based line of a node, for evidence line ranges. */
export const lineOf = (node: SyntaxNode): number => node.startPosition.row + 1;

export const endLineOf = (node: SyntaxNode): number => node.endPosition.row + 1;
