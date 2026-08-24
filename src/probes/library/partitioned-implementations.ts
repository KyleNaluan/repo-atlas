/**
 * An interface whose implementations split on whether they hold anything from a
 * whole package.
 *
 * The judgement encoded, from the reference overview's `Grader ⟂ Runner`: the
 * interesting thing about the grader set is not that one of them executes code -
 * it is that the other three hold NOTHING from the package that does, and the
 * interface never asked them to. An inventory of fields cannot surface that; only
 * the partition does. It is the seam a reviewer asks about, because it is what
 * stops "exercise" from silently starting to mean "code".
 *
 * WHY A PACKAGE AND NOT A TYPE. `dependency-asymmetry` already compares directory
 * siblings field by field and looks for the odd one out. Field-by-field is both
 * too noisy and too narrow here: too noisy because an implementation set
 * partitions on almost any utility type one of them happens to hold, and too
 * narrow because it needs exactly one dissenter, while the reference boundary is
 * a set of four splitting one against three. A package is the unit the subject
 * itself drew - it named the directory, put the runner types in it, and kept them
 * out of the graders that do not execute - so partitioning on "holds something
 * declared in package P" reads a line the subject drew rather than one this probe
 * chose. The two probes stay separate for the reason the register keeps the Flow
 * adapters separate: "this sibling lacks a field its siblings have" and "this
 * abstraction does not require that package" are different findings.
 *
 * Structural, so `reading: "direct"` (#28): the implementation set is read from
 * `implements`/`extends` clauses, the packages from `package` declarations, and
 * the holdings from field and record-component types - all grammar productions,
 * and all through the one shared index in `declared.ts`.
 *
 * FOUR GUARDS:
 *
 *  - AT LEAST THREE IMPLEMENTATIONS. With two, "some hold and some do not" is a
 *    single difference between a pair, which is a comparison rather than a rule.
 *  - THE SPLIT MUST BE NON-TRIVIAL. Every implementation holding something from P
 *    means P is a requirement, not a boundary; none holding anything means the
 *    two never met.
 *  - AT LEAST TWO IMPLEMENTATIONS HOLD NOTHING. One dissenter is
 *    `dependency-asymmetry`'s finding, and emitting it here too would be the same
 *    thing said twice in two vocabularies.
 *  - PRODUCTION TYPES ONLY. A test class's collaborators are a fixture's wiring,
 *    not a seam the subject drew; the reference subject's only asymmetry
 *    candidates before this were three of exactly that shape.
 */
import type { Candidate, Probe } from "../types.js";
import { declaredTypes, type DeclaredType } from "../declared.js";
import { pathSlug, slug } from "../id.js";

/** The shortest name that still identifies a package to a reader: its last segment. */
const leaf = (pkg: string): string => pkg.split(".").pop() ?? pkg;

export const partitionedImplementations: Probe = {
  id: "partitioned-implementations",
  /** The parse tree is the reading: supertype clauses, package clauses and field types (#28). */
  reading: "direct",
  finds: "an abstraction whose implementations split on whether they hold anything from one package",
  toolchain: "java",
  run: async (ctx) => {
    const types = (await declaredTypes(ctx)).filter((t) => !t.test);
    const bases = types.filter((t) => t.kind === "interface" || t.permits.length > 0);
    const packages = [...new Set(types.map((t) => t.pkg).filter((p) => p.length > 0))].sort();
    const out: Candidate[] = [];

    for (const base of bases) {
      const impls = types.filter((t) => t !== base && t.supertypes.has(base.name));
      if (impls.length < 3) continue;

      for (const pkg of packages) {
        // A type holding something from its own package is not crossing a line.
        if (pkg === base.pkg) continue;
        const declaredThere = new Set(types.filter((t) => t.pkg === pkg).map((t) => t.name));
        const holders = impls.filter((t) => [...t.holds].some((h) => declaredThere.has(h)));
        const abstainers = impls.filter((t) => !holders.includes(t));
        if (holders.length === 0 || abstainers.length < 2) continue;

        const held = [
          ...new Set(holders.flatMap((t) => [...t.holds].filter((h) => declaredThere.has(h)))),
        ].sort();

        out.push({
          probe_id: "partitioned-implementations",
          node: {
            type: "boundary",
            id: `b-partition-${pathSlug(base.path)}-${slug(base.qualified)}-${slug(pkg)}`,
            title: `${base.qualified} ⟂ ${leaf(pkg)}`,
            a: `${base.qualified}, implemented by ${impls.length} types`,
            b: `package ${pkg}`,
            enforced_by:
              `${holders.length} of the ${impls.length} types implementing ${base.qualified} ` +
              `${holders.length === 1 ? "holds" : "hold"} a collaborator declared in ${pkg} ` +
              `(${holders.map((t) => t.name).join(", ")} ${holders.length === 1 ? "holds" : "hold"} ${held.join(", ")}); ` +
              `${abstainers.map((t) => t.name).join(", ")} hold nothing from it. ` +
              `${base.qualified} declares no member of ${pkg} itself, so the interface never requires one.`,
            what_breaks_without_it:
              `Putting ${leaf(pkg)} into ${base.qualified} would make ${abstainers.length} implementations ` +
              `carry a collaborator they never use, and each of them exists precisely to do the thing without it.`,
            evidence: [
              {
                kind: "file",
                path: base.path,
                line_start: base.line[0],
                line_end: base.line[1],
                sha: ctx.sha,
                note: `declares no ${leaf(pkg)} member`,
              },
              ...abstainers.map((t) => ({
                kind: "file" as const,
                path: t.path,
                line_start: t.line[0],
                line_end: t.line[1],
                sha: ctx.sha,
                note: `holds nothing declared in ${pkg}`,
              })),
              ...holders.map((t) => ({
                kind: "file" as const,
                path: t.path,
                line_start: t.line[0],
                line_end: t.line[1],
                sha: ctx.sha,
                note: `holds ${[...t.holds].filter((h) => declaredThere.has(h)).sort().join(", ")}`,
              })),
            ],
            confidence: "verified",
            interview_value: 0,
            probe_id: "partitioned-implementations",
          },
        });
      }
    }
    return out;
  },
};
