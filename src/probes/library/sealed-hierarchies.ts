/**
 * A sealed type and the set it permits.
 *
 * The judgement encoded: `sealed ... permits A, B, C` is a closed enumeration
 * the compiler enforces. It says "these are all the cases and there will not be
 * a fourth without my knowing", which is a design decision written into the type
 * system rather than into a document - and it is one of the few places where a
 * closed enumeration can WITNESS an absence claim, which #8's M2 relies on.
 *
 * Structural, so tree-sitter: the permits clause is a grammar production, and
 * grepping for the word would match it in prose and comments too.
 */
import type { Candidate, Probe } from "../types.js";
import { pathSlug, slug } from "../id.js";
import { enclosingTypeNames, endLineOf, findAll, lineOf, nameOf } from "../java.js";

export const sealedHierarchies: Probe = {
  id: "sealed-hierarchies",
  finds: "a sealed type and the closed set of implementations it permits",
  toolchain: "java",
  run: async (ctx) => {
    const out: Candidate[] = [];
    for (const path of ctx.paths.filter((p) => p.endsWith(".java"))) {
      const source = ctx.read(path);
      if (source === null || !source.includes("permits")) continue;
      const root = await ctx.parse(path);
      if (root === null) continue;

      for (const type of [
        ...findAll(root, "interface_declaration"),
        ...findAll(root, "class_declaration"),
        ...findAll(root, "record_declaration"),
      ]) {
        const permits = type.childForFieldName("permits");
        if (!permits) continue;
        const name = nameOf(type);
        if (name === null) continue;
        const path_names = [...enclosingTypeNames(type), name];
        const fullName = path_names.join(".");
        const members = permits.text
          .replace(/^permits\s*/, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        out.push({
          probe_id: "sealed-hierarchies",
          node: {
            type: "mechanism",
            id: `m-sealed-${pathSlug(path)}-${slug(path_names.join("-"))}`,
            title: `${fullName} is sealed over ${members.length} permitted ${members.length === 1 ? "type" : "types"}`,
            what: `${fullName} permits exactly ${members.join(", ")}. The compiler rejects any implementation outside that set.`,
            why_interesting:
              "A sealed hierarchy is a closed enumeration the type system enforces. It is also one of the few things that can witness an absence claim, because the set is provably complete.",
            enforcement: "type-level",
            gotchas: [],
            evidence: [
              { kind: "file", path, line_start: lineOf(type), line_end: endLineOf(type), sha: ctx.sha },
            ],
            confidence: "verified",
            interview_value: 0,
            probe_id: "sealed-hierarchies",
          },
        });
      }
    }
    return out;
  },
};
