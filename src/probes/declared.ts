/**
 * One definition of "what Java types this subject declares".
 *
 * The three boundary probes added for #22's probe-coverage gap all ask the same
 * question first - which types are here, what package each sits in, what each
 * one holds and what each one extends - and then ask three different questions
 * about the answer. Sharing the index is the same discipline `manifests.ts`
 * applies to "declared dependency" and `sql.ts` to "a read": if two probes drew
 * their own type inventories they could quietly disagree about whether a record
 * component counts as a held collaborator, and two boundaries drawn on the same
 * subject would then rest on two different readings of it.
 *
 * Everything here is a parse-tree production - a `package` clause, a type
 * declaration's name and kind, a `permits` list, an enum's constants, a field or
 * record component's declared type - so a probe built on it can declare
 * `reading: "direct"` and mean it (#28). Nothing is inferred and nothing is
 * matched against prose: a type this index does not carry is a type the subject
 * does not declare, and a probe reading it never has to guess.
 *
 * TOP-LEVEL AND NESTED TYPES ARE BOTH INDEXED, because the reference subject's
 * most load-bearing enum is a nested one (`Verdict.Outcome`), but they are told
 * apart by `qualified`: a nested type carries its enclosing path, so a probe
 * that compares peers can compare peers and one that needs the nested case can
 * reach it. `holds` is the type's OWN body only, never its inner types', for the
 * reason `dependency-asymmetry` records: attributing an inner helper's fields to
 * its enclosing class invents a collaborator the enclosing class never held.
 */
import { isTestPath } from "../harvest/tree.js";
import {
  enclosingTypeNames,
  endLineOf,
  findAll,
  lineOf,
  nameOf,
  supertypeNamesOf,
  type SyntaxNode,
} from "./java.js";
import type { ProbeContext } from "./types.js";

export type TypeKind = "class" | "interface" | "record" | "enum";

export interface DeclaredType {
  path: string;
  /**
   * The `package` clause the file declares, or `""` when it declares none. Read
   * from the clause rather than derived from the directory: a package is what
   * the compiler goes by, and the two can differ.
   */
  pkg: string;
  /** Simple name, as written. */
  name: string;
  /** Enclosing path plus the name, so `Verdict.Outcome` is not confused with a top-level `Outcome`. */
  qualified: string;
  kind: TypeKind;
  /** True for a type declared inside another type. */
  nested: boolean;
  /** True when the declaring file sits on a test path (`isTestPath`, the one shared definition). */
  test: boolean;
  /** Simple names of the types this one extends or implements. */
  supertypes: Set<string>;
  /**
   * Simple names of the types this one HOLDS: its own field declarations and, for
   * a record, its own components. Generic arguments are stripped to the base
   * name, the same reduction `dependency-asymmetry` makes, so `List<Grader>`
   * holds a `List` rather than a `Grader` - a collection of them is not the same
   * relationship as holding one, and this index does not blur the two.
   */
  holds: Set<string>;
  /** The `permits` list, in declaration order; empty when the type is not sealed. */
  permits: string[];
  /** Enum constants, in declaration order; empty when the type is not an enum. */
  constants: string[];
  line: [number, number];
}

const KIND_OF: Record<string, TypeKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  record_declaration: "record",
  enum_declaration: "enum",
};

/** The base simple name of a declared type, with generic arguments and any package path removed. */
const baseName = (text: string): string =>
  (text.replace(/<.*$/s, "").trim().split(".").pop() ?? "").trim();

/** The `package` clause, or `""` when the file declares none. */
const packageOf = (root: SyntaxNode): string => {
  for (const decl of findAll(root, "package_declaration")) {
    return decl.text.replace(/^package\s*/, "").replace(/;\s*$/, "").trim();
  }
  return "";
};

/** The simple names of the types a declaration holds in its OWN body, plus record components. */
const heldTypes = (decl: SyntaxNode): Set<string> => {
  const held = new Set<string>();
  const body = decl.childForFieldName("body");
  for (let i = 0; body && i < body.namedChildCount; i += 1) {
    const child = body.namedChild(i);
    if (child?.type !== "field_declaration") continue;
    const type = child.childForFieldName("type")?.text;
    if (type) held.add(baseName(type));
  }
  const params = decl.childForFieldName("parameters");
  for (let i = 0; params && i < params.namedChildCount; i += 1) {
    const type = params.namedChild(i)?.childForFieldName("type")?.text;
    if (type) held.add(baseName(type));
  }
  return held;
};

/** The `permits` list, in declaration order; empty when the type is not sealed. */
const permittedTypes = (decl: SyntaxNode): string[] => {
  const permits = decl.childForFieldName("permits");
  if (!permits) return [];
  return permits.text
    .replace(/^permits\s*/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

/** An enum's constants, in declaration order; empty when the type is not an enum. */
const enumConstants = (decl: SyntaxNode): string[] => {
  const body = decl.childForFieldName("body");
  if (!body) return [];
  const out: string[] = [];
  for (let i = 0; i < body.namedChildCount; i += 1) {
    const child = body.namedChild(i);
    if (child?.type !== "enum_constant") continue;
    const name = nameOf(child);
    if (name) out.push(name);
  }
  return out;
};

/**
 * Every Java type this subject declares at the pinned SHA.
 *
 * Parses every `.java` path through `ctx.parse`, which is memoised, so a second
 * probe asking for this index joins the first probe's parses rather than
 * reparsing the tree.
 */
export const declaredTypes = async (ctx: ProbeContext): Promise<DeclaredType[]> => {
  const out: DeclaredType[] = [];
  for (const path of ctx.paths.filter((p) => p.endsWith(".java"))) {
    const root = await ctx.parse(path);
    if (root === null) continue;
    const pkg = packageOf(root);
    const test = isTestPath(path);
    for (const [nodeType, kind] of Object.entries(KIND_OF)) {
      for (const decl of findAll(root, nodeType)) {
        const name = nameOf(decl);
        if (name === null) continue;
        const enclosing = enclosingTypeNames(decl);
        out.push({
          path,
          pkg,
          name,
          qualified: [...enclosing, name].join("."),
          kind,
          nested: enclosing.length > 0,
          test,
          supertypes: supertypeNamesOf(decl),
          holds: heldTypes(decl),
          permits: permittedTypes(decl),
          constants: kind === "enum" ? enumConstants(decl) : [],
          line: [lineOf(decl), endLineOf(decl)],
        });
      }
    }
  }
  // Stable order, so an id minted from "the first carrier" or "the first
  // implementation" does not churn between runs on an unchanged tree.
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.qualified.localeCompare(b.qualified));
};
