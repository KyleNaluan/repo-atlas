/**
 * An enum that carries every constant of another, plus constants that one cannot
 * have.
 *
 * The judgement encoded, from the reference overview's `Machine verdict ⟂
 * self-rating`: when a subject declares two enums over the same vocabulary and
 * deliberately keeps one value OUT of the narrower one, the extra value is a
 * boundary written into the type system. Every site typed on the narrower enum is
 * then structurally unable to receive it - not by convention, not by a check
 * somebody has to remember, but because the constant does not exist there.
 *
 * The finding is the RELATIONSHIP, which is why neither declaration alone carries
 * it and why no existing probe could mint it: `sealed-hierarchies` reports closed
 * sets and an enum is one, but the interesting thing here is the difference
 * between two of them.
 *
 * Structural, so `reading: "direct"` (#28): enum constants are grammar
 * productions and the emitted sentence names the constants that are in one list
 * and not the other. A reader following the citation sees both lists.
 *
 * THREE GUARDS, which together are what keep this from finding coincidences.
 * Enums over small vocabularies collide by accident - two three-value enums that
 * both spell `PASSED, FAILED, ERROR` share a spelling rather than a design:
 *
 *  - A STRICT SUPERSET, over a narrower set of at least two constants. A
 *    one-constant subset is a shared spelling, not a shared vocabulary.
 *  - THE WIDER ENUM'S FILE MUST NAME THE NARROWER ONE, by importing it or by
 *    being declared beside it. Two enums that never meet in the source did not
 *    decide anything together, and this is the same discipline `declaredTypeNames`
 *    exists for elsewhere: a shape is only the subject's own when the subject
 *    declares the connection.
 *  - PRODUCTION TYPES ONLY. A test enum mirroring a production one is a fixture.
 */
import type { Candidate, Probe } from "../types.js";
import { declaredTypes, type DeclaredType } from "../declared.js";
import { pathSlug, slug } from "../id.js";

/** The outermost type name of a possibly-nested qualified name: `Verdict` for `Verdict.Outcome`. */
const outermost = (qualified: string): string => qualified.split(".")[0] ?? qualified;

/**
 * Does the file declaring `wider` name `narrower` at all?
 *
 * An import of the narrower enum's outermost enclosing type, or the two being
 * declared in the same package. Read off `import` declarations rather than a
 * substring scan of the whole file, so a javadoc cross-reference alone does not
 * satisfy it - the same reason `reachability.ts` masks comments before deciding
 * what a file can reach.
 */
const namesTheOther = (source: string, wider: DeclaredType, narrower: DeclaredType): boolean => {
  if (wider.pkg === narrower.pkg && wider.pkg.length > 0) return true;
  const outer = outermost(narrower.qualified);
  const imports = [...source.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm)].map((m) => m[1] ?? "");
  return imports.some((i) => i === outer || i.endsWith(`.${outer}`) || i.includes(`.${outer}.`));
};

export const supersetEnum: Probe = {
  id: "superset-enum",
  /** The parse tree is the reading: two enums' constant lists, and the difference between them (#28). */
  reading: "direct",
  finds: "an enum that is a strict superset of another, so the extra values cannot reach the narrower one",
  toolchain: "java",
  run: async (ctx) => {
    const enums = (await declaredTypes(ctx)).filter(
      (t) => !t.test && t.kind === "enum" && t.constants.length >= 2,
    );
    const out: Candidate[] = [];

    for (const wider of enums) {
      for (const narrower of enums) {
        if (wider === narrower) continue;
        if (wider.constants.length <= narrower.constants.length) continue;
        if (!narrower.constants.every((c) => wider.constants.includes(c))) continue;
        const source = ctx.read(wider.path);
        if (source === null || !namesTheOther(source, wider, narrower)) continue;

        const extra = wider.constants.filter((c) => !narrower.constants.includes(c));
        const plural = extra.length === 1 ? "" : "s";

        out.push({
          probe_id: "superset-enum",
          node: {
            type: "boundary",
            id: `b-superset-${pathSlug(wider.path)}-${slug(wider.qualified)}-${slug(narrower.qualified)}`,
            title: `${wider.qualified} ⟂ ${narrower.qualified}`,
            a: `${wider.qualified}, over ${wider.constants.join(", ")}`,
            b: `${narrower.qualified}, over ${narrower.constants.join(", ")}`,
            enforced_by:
              `${wider.qualified} declares every one of ${narrower.qualified}'s ${narrower.constants.length} ` +
              `constants and ${extra.length} more: ${extra.join(", ")}. ` +
              `${narrower.qualified} has no such constant, so a value typed as one can never carry ${extra.join(" or ")}.`,
            what_breaks_without_it:
              `Adding ${extra.join(" or ")} to ${narrower.qualified} would let every site that reads a ` +
              `${narrower.qualified} receive it, and each of those sites was written when the set was ` +
              `${narrower.constants.length} value${narrower.constants.length === 1 ? "" : "s"} wide.`,
            evidence: [
              {
                kind: "file",
                path: wider.path,
                line_start: wider.line[0],
                line_end: wider.line[1],
                sha: ctx.sha,
                note: `declares ${extra.join(", ")} beside ${narrower.qualified}'s constants`,
              },
              {
                kind: "file",
                path: narrower.path,
                line_start: narrower.line[0],
                line_end: narrower.line[1],
                sha: ctx.sha,
                note: `no ${extra.join(" or ")} constant${plural}`,
              },
            ],
            confidence: "verified",
            interview_value: 0,
            probe_id: "superset-enum",
          },
        });
      }
    }
    return out;
  },
};
