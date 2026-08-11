/**
 * A type that depends on a sibling its siblings do not depend on.
 *
 * The judgement encoded, from discovery: a grader with no runner field, where
 * every other grader has one. The absence is the seam - it says this
 * implementation never executes code, which is a boundary someone drew and
 * which the field list quietly enforces. An inventory of fields would not
 * surface it; only the comparison does.
 *
 * Structural, so tree-sitter: field declarations and their types are grammar
 * productions, and a grep would match the type name in imports and comments.
 */
import type { Candidate, Probe } from "../types.js";
import { pathSlug, slug } from "../id.js";
import { enclosingTypeNames, endLineOf, findAll, lineOf, nameOf, parseJava } from "../java.js";

/** Types in the same directory are the sibling set worth comparing. */
const directory = (path: string): string => {
  // A repo-root file has no slash; `lastIndexOf` returns -1 and a bare slice
  // would drop the final character, stranding each root class in its own bogus
  // one-member directory instead of the shared root.
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

export const dependencyAsymmetry: Probe = {
  id: "dependency-asymmetry",
  finds: "a type missing a collaborator every one of its siblings holds",
  toolchain: "java",
  run: async (ctx) => {
    const byDir = new Map<string, { path: string; name: string; fields: Set<string>; line: [number, number] }[]>();

    for (const path of ctx.paths.filter((p) => p.endsWith(".java"))) {
      const source = ctx.read(path);
      if (source === null) continue;
      const root = await parseJava(source);
      for (const decl of findAll(root, "class_declaration")) {
        const name = nameOf(decl);
        if (name === null) continue;
        // A nested type is not a directory peer of top-level classes: comparing
        // an inner helper against its file's siblings would synthesise a seam the
        // record never drew. Peers are compared with peers, so only top-level
        // classes join the sibling set.
        if (enclosingTypeNames(decl).length > 0) continue;
        const fullName = [...enclosingTypeNames(decl), name].join(".");
        // Only the class's OWN fields, not its inner classes'. `findAll` would
        // descend into nested types and attribute their fields here, making this
        // class appear to hold a collaborator that is really its inner class's -
        // a boundary the probe never established. Direct body children only.
        const body = decl.childForFieldName("body");
        const fields = new Set<string>();
        for (let i = 0; body && i < body.namedChildCount; i += 1) {
          const child = body.namedChild(i);
          if (child?.type !== "field_declaration") continue;
          const type = child.childForFieldName("type")?.text;
          if (type) fields.add(type.replace(/<.*>$/, ""));
        }
        const list = byDir.get(directory(path)) ?? [];
        list.push({ path, name: fullName, fields, line: [lineOf(decl), endLineOf(decl)] });
        byDir.set(directory(path), list);
      }
    }

    const out: Candidate[] = [];
    for (const [, siblings] of byDir) {
      // Three is the smallest set where "every other one" means anything.
      if (siblings.length < 3) continue;
      const counts = new Map<string, number>();
      for (const s of siblings) for (const f of s.fields) counts.set(f, (counts.get(f) ?? 0) + 1);

      for (const [type, held] of counts) {
        if (held !== siblings.length - 1) continue;
        const odd = siblings.find((s) => !s.fields.has(type));
        if (!odd) continue;
        out.push({
          probe_id: "dependency-asymmetry",
          node: {
            type: "boundary",
            id: `b-asymmetry-${pathSlug(odd.path)}-${slug(odd.name)}-${slug(type)}`,
            title: `${odd.name} holds no ${type}, and every sibling does`,
            a: odd.name,
            b: type,
            enforced_by: `${odd.name} simply has no ${type} field, while its ${siblings.length - 1} siblings all do.`,
            what_breaks_without_it: `Giving ${odd.name} a ${type} would let it do the thing its whole point is not to do.`,
            evidence: [
              { kind: "file", path: odd.path, line_start: odd.line[0], line_end: odd.line[1], sha: ctx.sha },
            ],
            confidence: "verified",
            interview_value: 0,
            probe_id: "dependency-asymmetry",
          },
        });
      }
    }
    return out;
  },
};
