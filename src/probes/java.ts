/**
 * The one structural-parse dependency (#5, point 4).
 *
 * Three probes genuinely need a parse tree - sealed hierarchies, throw-vs-return
 * and dependency asymmetry - because the questions they ask are about structure
 * rather than text. The other five stay grep-class, because #5 is explicit that
 * no probe should be forced through a parse tree that a scan answers: the
 * discovery report's "trivial grep, valuable because someone framed the
 * question" finding stands.
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

/** 1-based line of a node, for evidence line ranges. */
export const lineOf = (node: SyntaxNode): number => node.startPosition.row + 1;

export const endLineOf = (node: SyntaxNode): number => node.endPosition.row + 1;
