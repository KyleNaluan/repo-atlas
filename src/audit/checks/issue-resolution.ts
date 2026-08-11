/**
 * L3 - every issue and comment citation resolves. Pass C.
 *
 * Cache-first, and network only on a miss. Harvest (#4) already fetched every
 * body and comment at full fidelity and keyed its cache so a comment edit
 * invalidates the entry, so re-fetching would be asking the same question twice
 * and paying for it.
 *
 * The comment id is the whole point of this check. #7 found issue #2 carrying
 * two comments cited as distinct artifacts, and #8's L3 says it plainly: an
 * audit that cannot tell comment 5181222288 from 5243059657 cannot verify that
 * the decision trail cites the RESOLUTION rather than a later note. So a
 * citation naming a comment resolves against that comment or it does not
 * resolve at all.
 */
import { spec } from "../register.js";
import {
  failed,
  notApplicable,
  notRun,
  passed,
  type AuditContext,
  type CheckResult,
} from "../types.js";
import type { Evidence, IssueEvidence } from "../../schema/types.js";
import type { HarvestedIssue } from "../../harvest/types.js";
import { resolveComment, resolveIssue } from "../../harvest/cache.js";
import { nodeEvidence } from "./evidence.js";

/**
 * Every issue citation in the graph, with the element that carries it.
 *
 * A node's evidence is `nodeEvidence(n)` - the one traversal that folds in
 * implemented_by, code_excerpt and steps (evidence.ts, the I1 ruling) - rather
 * than a second hand-walk that could drift from it. A decision whose resolution
 * comment is cited via implemented_by is thereby checked here too.
 */
export const issueCitations = (
  atlas: AuditContext["atlas"],
): { owner: string; e: IssueEvidence }[] => {
  const out: { owner: string; e: IssueEvidence }[] = [];
  const add = (owner: string, list: Evidence[]) => {
    for (const e of list) if (e.kind === "issue") out.push({ owner, e });
  };
  add("synopsis", atlas.synopsis.evidence);
  add("shape", atlas.shape.evidence);
  for (const n of atlas.nodes) add(n.id, nodeEvidence(n));
  return out;
};

export interface IssueSource {
  /** Cached issues for the subject, from the harvest cache. */
  cached: HarvestedIssue[];
  /** Fetch one issue when the cache does not hold it. Absent means cache-only. */
  fetch?: (number: number) => Promise<HarvestedIssue | undefined>;
}

/**
 * The check's result, and where its answers came from.
 *
 * The split is returned rather than folded into the result because "cache-first"
 * is a property of this stage that an operator should be able to see holding, and
 * a claim nobody can check is the thing this whole audit exists to refuse.
 */
export interface ResolutionResult {
  result: CheckResult;
  fromCache: number;
  fetched: number;
}

export const resolveIssueCitations = async (
  ctx: AuditContext,
  source: IssueSource,
): Promise<ResolutionResult> => {
  const citations = issueCitations(ctx.atlas);
  if (citations.length === 0) {
    return {
      result: notApplicable(spec("L3"), "the graph cites no issues, so there is nothing to resolve"),
      fromCache: 0,
      fetched: 0,
    };
  }

  if (source.cached.length === 0 && source.fetch === undefined) {
    // The distinction this refuses to guess at. A citation the cache cannot serve
    // is a false citation only if the cache is in a position to know; an EMPTY
    // cache with no way to fetch knows nothing, and reporting fifteen unresolved
    // citations from it would be the audit blaming the artifact for its own
    // missing state. It could not run, it says so by name, and "could not run"
    // never counts as a pass.
    return {
      result: notRun(
        spec("L3"),
        `no harvested issues were available to resolve ${citations.length} citation${citations.length === 1 ? "" : "s"} against; run harvest for this subject first`,
      ),
      fromCache: 0,
      fetched: 0,
    };
  }

  const problems: string[] = [];
  let fromCache = 0;
  let fetched = 0;
  const seen = new Map<number, HarvestedIssue | undefined>();

  for (const { owner, e } of citations) {
    let issue = seen.get(e.number);
    if (issue === undefined && !seen.has(e.number)) {
      issue = resolveIssue(source.cached, e.number);
      if (issue) {
        fromCache += 1;
      } else if (source.fetch) {
        issue = await source.fetch(e.number);
        if (issue) fetched += 1;
      }
      seen.set(e.number, issue);
    }

    if (!issue) {
      problems.push(`${owner}: issue #${e.number} does not resolve`);
      continue;
    }
    if (e.comment_id === undefined) continue;
    if (!resolveComment([issue], e.number, e.comment_id)) {
      // Naming the comments that DO exist, because the likeliest cause is a
      // citation pointing at the issue's later note rather than its resolution.
      problems.push(
        `${owner}: issue #${e.number} resolves but comment ${e.comment_id} does not; ` +
          `that issue carries ${issue.comments.map((c) => c.id).join(", ") || "no comments"}`,
      );
    }
  }

  return {
    result:
      problems.length === 0
        ? passed(spec("L3"), citations.length)
        : // Count is the problem total, not the twenty shown, so the cap on the
          // enumeration is never silent.
          failed(spec("L3"), problems.slice(0, 20), problems.length),
    fromCache,
    fetched,
  };
};

/** Reported alongside the result, so a cache-first claim is checkable. */
export const resolutionSource = (fromCache: number, fetched: number): string =>
  `${fromCache} issue${fromCache === 1 ? "" : "s"} served from the harvest cache, ${fetched} fetched`;
