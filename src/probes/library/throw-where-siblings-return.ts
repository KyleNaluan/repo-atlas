/**
 * A method that deliberately throws where its siblings return.
 *
 * The judgement encoded: when one implementation of a shared shape throws
 * UnsupportedOperationException while the others return a value, that is not an
 * oversight - it is someone deciding that this case must fail loudly rather
 * than pretend. The asymmetry IS the design, and it is invisible unless you
 * compare siblings.
 *
 * Structural, so tree-sitter: "does this method body throw rather than return"
 * is a question about a body, and a grep for `throw` cannot tell a guard clause
 * from a method whose entire contract is to refuse.
 */
import type { Candidate, Probe } from "../types.js";
import { pathSlug, slug } from "../id.js";
import {
  declaredTypeNames,
  directoryOf,
  enclosingTypeNames,
  enclosingTypeNode,
  endLineOf,
  findAll,
  lineOf,
  nameOf,
  paramTypesOf,
  supertypeNamesOf,
  type SyntaxNode,
} from "../java.js";

const REFUSAL = /UnsupportedOperationException|NotImplementedException|AssertionError/;

/**
 * Encode array-ness and varargs into a parameter type BEFORE it is slugged.
 *
 * `slug` strips `[]` and `...`, so `slug("byte[]")` and `slug("byte")` both
 * collapse to "byte". Two legal overloads that differ only in array/varargs-ness
 * - `write(byte)` and `write(byte[])` - would then mint the same signature and
 * the same id, and the run-level uniqueness guard would crash on an otherwise
 * valid subject. Turning the marker into a readable word keeps distinct erasures
 * distinct once slugged.
 */
const encodeType = (type: string): string =>
  type.replace(/\.\.\./g, " varargs").replace(/\[\s*\]/g, " array");

/** A body whose only statement is a throw, rather than one carrying a guard. */
const isOutrightRefusal = (body: SyntaxNode): boolean => {
  let statements = 0;
  let throws = 0;
  for (let i = 0; i < body.namedChildCount; i += 1) {
    const child = body.namedChild(i);
    if (!child) continue;
    statements += 1;
    if (child.type === "throw_statement" && REFUSAL.test(child.text)) throws += 1;
  }
  return statements === 1 && throws === 1;
};

/**
 * The enclosing type of a method, as the probe needs to know it to bound siblings.
 *
 * `key` identifies the type uniquely (a class in two files, or two same-named
 * nested types in one file, are different types); `supertypes` are what it
 * extends or implements; `directory` is the file it lives in.
 */
interface OwnerScope {
  key: string;
  supertypes: Set<string>;
  directory: string;
}

const ownerScopeOf = (method: SyntaxNode, path: string): OwnerScope => {
  const type = enclosingTypeNode(method);
  return {
    key: `${path}::${enclosingTypeNames(method).join(".")}`,
    supertypes: type ? supertypeNamesOf(type) : new Set<string>(),
    directory: directoryOf(path),
  };
};

/**
 * Whether a returning method belongs to a sibling of the refusing type.
 *
 * The judgement this probe encodes - one implementation of a shared shape refuses
 * where the others return - is only true between siblings, so the sibling set is
 * bounded rather than "any same-named method anywhere":
 *
 * - Where the refusing type declares a supertype THE SUBJECT ITSELF DECLARES,
 *   its siblings are the other types declaring that same supertype: the shared
 *   shape is what makes the asymmetry a design rather than a coincidence. A
 *   supertype the tree does not declare (`Comparable`, `Runnable`, any JDK or
 *   third-party interface) is shared by types that decided nothing together, so
 *   it is not counted - two classes both implementing `Comparable` are not
 *   siblings, and a class throwing in `compareTo` must not pair with an
 *   unrelated `Comparable` implementer.
 * - Where it declares none the subject defines, siblings fall back to other
 *   types in the same directory - the peer notion `dependency-asymmetry` also
 *   uses (`directoryOf`), so the two probes agree on what a sibling is.
 * - A type is never its own sibling. An overload pair inside one class differing
 *   in refusing-vs-returning may be a real finding, but it is not the one this
 *   probe claims to make, and its own title says "siblings".
 *
 * Without this bound the probe pairs a refusing `iterator()` in one hierarchy
 * with a returning `iterator()` in an unrelated one and asserts a seam between
 * types that share no contract - a fabricated relationship, and worse here than
 * an id collision because this probe carries no `claims`, so the gate confirms it
 * as-is and the false finding reaches rank marked verified.
 */
const isSibling = (refuser: OwnerScope, returner: OwnerScope, declared: Set<string>): boolean => {
  if (refuser.key === returner.key) return false;
  const shapes = [...refuser.supertypes].filter((s) => declared.has(s));
  if (shapes.length > 0) {
    return shapes.some((s) => returner.supertypes.has(s));
  }
  return refuser.directory === returner.directory;
};

export const throwWhereSiblingsReturn: Probe = {
  id: "throw-where-siblings-return",
  finds: "a method that refuses outright where its siblings return a value",
  toolchain: "java",
  run: async (ctx) => {
    // Collect by method name across the tree, carrying each method's owning type
    // so siblings can be bounded rather than paired by bare name globally.
    const returning = new Map<string, OwnerScope[]>();
    const declared = new Set<string>();
    const refusing: {
      path: string;
      name: string;
      node: SyntaxNode;
      ownerPath: string[];
      sig: string;
      scope: OwnerScope;
    }[] = [];

    for (const path of ctx.paths.filter((p) => p.endsWith(".java"))) {
      const root = await ctx.parse(path);
      if (root === null) continue;
      for (const name of declaredTypeNames(root)) declared.add(name);
      for (const method of findAll(root, "method_declaration")) {
        const name = nameOf(method);
        const body = method.childForFieldName("body");
        if (name === null || !body) continue;
        if (REFUSAL.test(body.text) && isOutrightRefusal(body)) {
          const ownerPath = enclosingTypeNames(method);
          const params = paramTypesOf(method);
          const sig = params.length > 0 ? slug(params.map(encodeType).join("-")) : "noargs";
          refusing.push({ path, name, node: method, ownerPath, sig, scope: ownerScopeOf(method, path) });
        } else if (body.text.includes("return ")) {
          returning.set(name, [...(returning.get(name) ?? []), ownerScopeOf(method, path)]);
        }
      }
    }

    // The count is of distinct sibling TYPES that return, so "N other
    // implementations" cannot be inflated by one sibling carrying several
    // returning overloads of the same name.
    const siblingTypes = (r: (typeof refusing)[number]): Set<string> => {
      const keys = new Set<string>();
      for (const returner of returning.get(r.name) ?? []) {
        if (isSibling(r.scope, returner, declared)) keys.add(returner.key);
      }
      return keys;
    };

    return refusing
      .map((r) => ({ r, siblings: siblingTypes(r).size }))
      .filter(({ siblings }) => siblings > 0)
      .map(({ r, siblings }) => ({
        probe_id: "throw-where-siblings-return",
        node: {
          type: "mechanism" as const,
          id: `m-refuses-${pathSlug(r.path)}-${slug([...r.ownerPath, r.name].join("-"))}-${r.sig}`,
          title: `${[...r.ownerPath, r.name].join(".")} refuses where its siblings return`,
          what: `${r.name} throws outright here, while ${siblings} other ${siblings === 1 ? "implementation returns" : "implementations return"} a value.`,
          why_interesting:
            "The asymmetry is the design: someone decided this case must fail loudly rather than return something plausible. That choice is invisible unless you compare siblings.",
          enforcement: "convention" as const,
          gotchas: [],
          evidence: [
            {
              kind: "file" as const,
              path: r.path,
              line_start: lineOf(r.node),
              line_end: endLineOf(r.node),
              sha: ctx.sha,
            },
          ],
          confidence: "verified" as const,
          interview_value: 0,
          probe_id: "throw-where-siblings-return",
        },
      }));
  },
};
