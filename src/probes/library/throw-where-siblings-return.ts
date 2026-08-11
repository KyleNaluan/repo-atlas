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
  enclosingTypeNames,
  endLineOf,
  findAll,
  lineOf,
  nameOf,
  paramTypesOf,
  parseJava,
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

export const throwWhereSiblingsReturn: Probe = {
  id: "throw-where-siblings-return",
  finds: "a method that refuses outright where its siblings return a value",
  toolchain: "java",
  run: async (ctx) => {
    // Collect by method name across the tree, so siblings can be compared.
    const returning = new Map<string, number>();
    const refusing: {
      path: string;
      name: string;
      node: SyntaxNode;
      ownerPath: string[];
      sig: string;
    }[] = [];

    for (const path of ctx.paths.filter((p) => p.endsWith(".java"))) {
      const source = ctx.read(path);
      if (source === null) continue;
      const root = await parseJava(source);
      for (const method of findAll(root, "method_declaration")) {
        const name = nameOf(method);
        const body = method.childForFieldName("body");
        if (name === null || !body) continue;
        if (REFUSAL.test(body.text) && isOutrightRefusal(body)) {
          const ownerPath = enclosingTypeNames(method);
          const params = paramTypesOf(method);
          const sig = params.length > 0 ? slug(params.map(encodeType).join("-")) : "noargs";
          refusing.push({ path, name, node: method, ownerPath, sig });
        } else if (body.text.includes("return ")) {
          returning.set(name, (returning.get(name) ?? 0) + 1);
        }
      }
    }

    return refusing
      .filter((r) => (returning.get(r.name) ?? 0) > 0)
      .map((r) => ({
        probe_id: "throw-where-siblings-return",
        node: {
          type: "mechanism" as const,
          id: `m-refuses-${pathSlug(r.path)}-${slug([...r.ownerPath, r.name].join("-"))}-${r.sig}`,
          title: `${[...r.ownerPath, r.name].join(".")} refuses where its siblings return`,
          what: `${r.name} throws outright here, while ${returning.get(r.name)} other ${(returning.get(r.name) ?? 0) === 1 ? "implementation returns" : "implementations return"} a value.`,
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
