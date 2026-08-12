/**
 * Trace without resolution: source cites an issue the record never explains.
 *
 * #6's point 3, and #10's stated reason for choosing the degradation subject.
 * Java-WebSocket carries lines like "look at variable declaration why this line
 * exists and #190" - a reference to a conversation that is not in the record.
 * The engine must surface those as REFERENCED BUT UNRESOLVED rather than
 * synthesising a plausible rationale for them, which is a sharper test than pure
 * silence: silence has nothing to invent from, a bare issue number does.
 *
 * The rule for what counts as a citation is `sourceIssueCitations`, shared with
 * the density signal that counts the same thing at harvest. Two definitions of
 * "cites an issue" would let the measured signal and this finding disagree about
 * the same file.
 *
 * What makes a citation UNRESOLVED is deliberately narrow: the record does not
 * carry a resolution-shaped comment for it. That covers both an issue harvest
 * never saw and an issue that exists but was closed without one, and it does not
 * cover an issue whose resolution is present - a decision node already carries
 * that, and reporting it here too would double-count the same trail.
 */
import { isSourceFile, sourceIssueCitations } from "../../harvest/tree.js";
import { RESOLUTION_HEADING } from "../../harvest/issues.js";
import type { Candidate, Probe, ProbeContext } from "../types.js";
import type { Evidence } from "../../schema/types.js";

/** Enough places to show the reference is real, not a one-off typo. */
const SITES = 3;

const find = async (ctx: ProbeContext): Promise<Candidate[]> => {
  const byNumber = new Map<number, { path: string; line: number }[]>();

  for (const path of ctx.paths) {
    if (!isSourceFile(path)) continue;
    const text = ctx.read(path);
    if (text === null) continue;
    for (const { number, line } of sourceIssueCitations(text, path)) {
      const sites = byNumber.get(number) ?? [];
      sites.push({ path, line });
      byNumber.set(number, sites);
    }
  }

  const resolved = new Set(
    ctx.harvest.issues
      .filter((i) => i.comments.some((c) => RESOLUTION_HEADING.test(c.body)))
      .map((i) => i.number),
  );
  const known = new Map(ctx.harvest.issues.map((i) => [i.number, i]));

  return [...byNumber]
    .filter(([number]) => !resolved.has(number))
    .sort((a, b) => a[0] - b[0])
    .map(([number, sites]) => {
      const issue = known.get(number);
      const evidence: Evidence[] = sites.slice(0, SITES).map((s) => ({
        kind: "file" as const,
        path: s.path,
        line_start: s.line,
        line_end: s.line,
        sha: ctx.sha,
      }));
      // The issue itself is cited only when the harvest actually holds it. A
      // citation to an issue nobody fetched would not resolve, and #8's L3 would
      // be right to fail it.
      if (issue !== undefined) evidence.push({ kind: "issue", number });

      const where = `${sites.length} place${sites.length === 1 ? "" : "s"} in the source`;
      const record =
        issue === undefined
          ? "no issue with that number was harvested for this subject"
          : `issue #${number} exists (${issue.state}) but carries no resolution-shaped comment`;

      return {
        probe_id: "unresolved-references",
        node: {
          type: "edge" as const,
          kind: "coverage_gap" as const,
          id: `e-unresolved-${number}`,
          title: `#${number} is referenced but not explained`,
          statement:
            `The source cites #${number} in ${where}, and the record does not resolve it: ${record}.`,
          why_it_matters:
            "The code was written with a reason that lives outside the repository. Saying so is the " +
            "honest report; inventing the reason from the surrounding code is the failure this " +
            "engine exists to avoid.",
          how_to_say_it: `There is a reference to #${number} here that the record does not explain.`,
          evidence,
          confidence: "verified" as const,
          interview_value: 0,
        },
      };
    });
};

export const unresolvedReferences: Probe = {
  id: "unresolved-references",
  finds: "source citing an issue number the record never explains (#6 point 3)",
  toolchain: "any",
  run: find,
};
