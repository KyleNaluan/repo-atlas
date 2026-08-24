/**
 * Two closed hierarchies one type holds one of each of.
 *
 * The judgement encoded, from the reference overview's `Response ⟂ Grading`: when
 * a subject declares two sealed hierarchies and then carries ONE OF EACH in a
 * single type, it has said that the two vary independently. Every pairing of the
 * two sets is expressible without a subtype per combination, and that is a
 * boundary someone drew deliberately - "how it is answered" and "how the answer
 * is judged" are different questions, and the type system is where the subject
 * wrote that down.
 *
 * `sealed-hierarchies` already reports each closed set on its own, and reports
 * both of these; what it cannot report is the RELATIONSHIP between two of them,
 * because that is not a property of either declaration. Only the carrier
 * establishes it, which is why this is a second probe rather than a richer
 * sentence in the first.
 *
 * Structural throughout, so `reading: "direct"` (#28): a `permits` clause and a
 * field or record component's declared type are grammar productions, and every
 * number in the emitted sentence is a length of a list read out of the tree. A
 * reader who follows the citation sees the two permits lists and the type that
 * holds one of each.
 *
 * THREE GUARDS, each of which keeps this from drawing a boundary nobody drew:
 *
 *  - BOTH SETS MUST PERMIT AT LEAST TWO. A hierarchy sealed over one member is a
 *    closed set with nothing to vary, so "these two vary independently" says
 *    nothing about it.
 *  - NEITHER MAY PERMIT THE OTHER, and their permitted sets may not overlap. Two
 *    hierarchies where one is a case of the other are one design axis wearing two
 *    names, and calling that orthogonal would be exactly backwards.
 *  - THE CARRIER HOLDS ONE OF EACH DIRECTLY. `holds` is the type's own fields and
 *    record components with generic arguments stripped to the base name
 *    (`declared.ts`), so a type holding `List<Response>` does not count: a
 *    collection of responses is not the same relationship as being answered by
 *    one, and the product claim below would not follow from it.
 */
import type { Candidate, Probe } from "../types.js";
import { declaredTypes, type DeclaredType } from "../declared.js";
import { pathSlug, slug } from "../id.js";

export const orthogonalHierarchies: Probe = {
  id: "orthogonal-hierarchies",
  /** The parse tree is the reading: two `permits` lists and a carrier's own components (#28). */
  reading: "direct",
  finds: "two sealed hierarchies a single type holds one of each of, so every pairing is expressible",
  toolchain: "java",
  run: async (ctx) => {
    const types = (await declaredTypes(ctx)).filter((t) => !t.test);
    const sealed = types.filter((t) => t.permits.length >= 2);
    const out: Candidate[] = [];

    for (let i = 0; i < sealed.length; i += 1) {
      for (let j = i + 1; j < sealed.length; j += 1) {
        const a = sealed[i] as DeclaredType;
        const b = sealed[j] as DeclaredType;
        // One hierarchy that is a case of the other is one axis, not two.
        if (a.permits.includes(b.name) || b.permits.includes(a.name)) continue;
        if (a.permits.some((p) => b.permits.includes(p))) continue;

        const carriers = types.filter((c) => c.holds.has(a.name) && c.holds.has(b.name));
        const carrier = carriers[0];
        if (carrier === undefined) continue;

        const pairings = a.permits.length * b.permits.length;
        const also =
          carriers.length > 1
            ? ` ${carriers.length - 1} further ${carriers.length === 2 ? "type does" : "types do"} the same.`
            : "";

        out.push({
          probe_id: "orthogonal-hierarchies",
          node: {
            type: "boundary",
            id: `b-orthogonal-${pathSlug(carrier.path)}-${slug(a.qualified)}-${slug(b.qualified)}`,
            title: `${a.qualified} ⟂ ${b.qualified}`,
            a: `${a.qualified}, sealed over ${a.permits.join(", ")}`,
            b: `${b.qualified}, sealed over ${b.permits.join(", ")}`,
            enforced_by:
              `Two sealed hierarchies with no permitted type in common. ${carrier.qualified} holds one of each, ` +
              `so all ${pairings} pairings of the two sets are expressible without a subtype per combination.${also}`,
            what_breaks_without_it:
              `Folding one axis into the other would need ${pairings} declared types where the subject declares ` +
              `${a.permits.length} + ${b.permits.length}, and every new member of either set would multiply ` +
              `against the other rather than being added once.`,
            evidence: [
              { kind: "file", path: a.path, line_start: a.line[0], line_end: a.line[1], sha: ctx.sha },
              { kind: "file", path: b.path, line_start: b.line[0], line_end: b.line[1], sha: ctx.sha },
              {
                kind: "file",
                path: carrier.path,
                line_start: carrier.line[0],
                line_end: carrier.line[1],
                sha: ctx.sha,
                note: `holds one ${a.name} and one ${b.name}`,
              },
            ],
            confidence: "verified",
            interview_value: 0,
            probe_id: "orthogonal-hierarchies",
          },
        });
      }
    }
    return out;
  },
};
