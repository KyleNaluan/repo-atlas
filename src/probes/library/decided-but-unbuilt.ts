/**
 * A closed decision issue whose implementation issue is still open.
 *
 * The judgement encoded: a repository that argues a decision to a close and then
 * tracks the building of it separately leaves a gap between the two, and that
 * gap is the most interesting thing on the page - it is what an interviewer
 * probes and what a summariser flattens.
 *
 * Three discriminations, each of which the first version of this probe got
 * wrong when it was run against the reference subject:
 *
 *  - ONE CANDIDATE PER OPEN ISSUE, not one per decision that references it.
 *    Nine closed decisions all cited the same ticket and produced nine
 *    candidates sharing an id.
 *  - A HUB IS NOT AN IMPLEMENTATION TICKET. Every decision on the reference
 *    subject carries "Part of the wayfinder map: #1", so the map issue was
 *    referenced by all of them; a ticket referenced by many decisions is a
 *    parent, not a task. An implementation ticket is cited by one or two.
 *  - NO KEYWORD FILTER ON THE TITLE. Filtering titles for "implement", "build"
 *    and the like matched the map ("...to a build-ready spec") and MISSED the
 *    real case: "Second language adapter", the open ticket #7 found whose
 *    implementation fully existed at the pinned SHA. The relationship is what
 *    matters, not the wording.
 *
 * The candidate carries a claim the gate must resolve, and the claim is
 * `expect: "absent"` on purpose: an open ticket is not evidence of absence, and
 * #7's point 7 requires the gate to be able to overturn the record in that
 * direction too.
 *
 * SCOPE, and it needs stating because two resolutions read differently here.
 * #5 names this probe as "closed decision issue with open implementation
 * issue". On the reference subject that pairing does not exist in the tracker:
 * every decision cites only the wayfinder map, and nothing cites #26 "Second
 * language adapter" - the open ticket #7 found whose implementation fully
 * exists at the pinned SHA. Read literally, #5's pairing would emit nothing and
 * the gate would have nothing to overturn, losing the demonstration #7's point 7
 * exists to require. #7 is titled "Probe-contract clarification for #5" and
 * attributes that live finding to THIS probe, so the linkage is treated as
 * strengthening evidence rather than as the trigger: any open, non-decision,
 * non-hub ticket is a candidate, and a referencing decision adds its resolution
 * as evidence when there is one.
 */
import type { Candidate, Probe } from "../types.js";
import type { HarvestedIssue } from "../../harvest/types.js";
import { RESOLUTION_HEADING } from "../../harvest/issues.js";

/** Beyond this many referencing decisions, an open issue is a hub, not a task. */
const HUB_THRESHOLD = 2;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "into", "from", "that", "this", "then", "when",
  "second", "first", "new", "add", "use", "using", "via", "per",
]);

/** Issue numbers this issue points at, from its body and its comments. */
const referenced = (issue: HarvestedIssue): number[] => {
  const text = [issue.body, ...issue.comments.map((c) => c.body)].join("\n");
  return [...new Set([...text.matchAll(/(?:^|[^\w#])#(\d+)\b/g)].map((m) => Number(m[1])))];
};

/**
 * A pattern that would appear in the tree if this ticket WERE built.
 *
 * The two longest meaningful words of the title, required to sit ADJACENT in an
 * identifier rather than merely to co-occur somewhere in the same file. "Second
 * language adapter" becomes language-then-adapter, which finds
 * LanguageAdapterRegistry - the implementation the open ticket implies does not
 * exist.
 *
 * Adjacency is doing real work. Co-occurrence anywhere in a file overturned two
 * further tickets on the reference subject that are genuinely unbuilt: "Author
 * the AI/ML family" matched a file containing "author" and "family" in unrelated
 * places, and a ticket about working with coding agents matched a component
 * mentioning both words. The gate reporting "the tree says otherwise" about a
 * ticket that is not built is worse than the probe staying quiet - it is the
 * engine asserting a contradiction it did not establish.
 */
const builtPattern = (title: string): string | null => {
  const words = title
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  if (words.length < 2) return null;
  const [a, b] = words as [string, string];
  const joined = "[_\\s-]*";
  return `(?:${a}${joined}${b}|${b}${joined}${a})`;
};

export const decidedButUnbuilt: Probe = {
  id: "decided-but-unbuilt",
  finds: "a decision argued and closed whose implementation issue is still open",
  toolchain: "any",
  run: (ctx) => {
    const issues = ctx.harvest.issues;
    const byNumber = new Map(issues.map((i) => [i.number, i]));
    const isDecision = (i: HarvestedIssue): boolean =>
      i.state === "closed" && i.comments.some((c) => RESOLUTION_HEADING.test(c.body));

    // Which closed decisions cite which open issue. A citation is strengthening
    // evidence, not the trigger.
    const citedBy = new Map<number, HarvestedIssue[]>();
    for (const decision of issues.filter(isDecision)) {
      for (const number of referenced(decision)) {
        citedBy.set(number, [...(citedBy.get(number) ?? []), decision]);
      }
    }

    const out: Candidate[] = [];
    for (const open of issues.filter((i) => i.state === "open").sort((a, b) => a.number - b.number)) {
      const decisions = citedBy.get(open.number) ?? [];
      // A ticket every decision points at is the map they all belong to, not a
      // task that was decided and left unbuilt.
      if (decisions.length > HUB_THRESHOLD) continue;
      // An open issue carrying its own resolution is a decision, not a task.
      if (open.comments.some((c) => RESOLUTION_HEADING.test(c.body))) continue;

      const pattern = builtPattern(open.title);
      // Without something checkable the gate could only ever return unresolved,
      // and an unresolvable candidate is noise rather than a finding.
      if (pattern === null) continue;

      const first = decisions[0];
      const resolution = first?.comments.find((c) => RESOLUTION_HEADING.test(c.body));
      const evidence: { kind: "issue"; number: number; comment_id?: number }[] = [
        { kind: "issue", number: open.number },
      ];
      if (first && resolution) {
        evidence.unshift({ kind: "issue", number: first.number, comment_id: resolution.id });
      }

      out.push({
        probe_id: "decided-but-unbuilt",
        claims: [
          {
            description: `#${open.number} "${open.title}" is open, so the record implies it is not built`,
            expect: "absent",
            pattern: { regex: pattern, include: "\\.(java|ts|tsx|py|kt|go|rs)$" },
          },
        ],
        node: {
          type: "edge",
          kind: "unbuilt",
          id: `e-unbuilt-${open.number}`,
          title: open.title,
          statement:
            first === undefined
              ? `#${open.number} is open, so the record implies this is not built.`
              : `#${first.number} was decided and closed; #${open.number}, which tracks building it, is still open.`,
          why_it_matters:
            "A decision that is settled but not built is the gap between the record and the tree, and it is what an interviewer asks about first.",
          how_to_say_it:
            first === undefined
              ? `The tracker still has #${open.number} open for that.`
              : `That one is decided but not built - the argument is closed in #${first.number}, the work is tracked in #${open.number}.`,
          evidence,
          confidence: "attested",
          interview_value: 0,
          probe_id: "decided-but-unbuilt",
        },
      });
    }
    return out;
  },
};
