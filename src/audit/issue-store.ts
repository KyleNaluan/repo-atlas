/**
 * One issue store per audit run: the single place that knows what this run has
 * resolved.
 *
 * Pass C resolves every issue citation cache-first, fetching only on a miss;
 * pass D reads the same nodes' evidence. Threading one memoizing store through
 * both is what makes "cache-first" hold ACROSS them - an id pass C had to fetch
 * is by construction visible to pass D, rather than pass D re-reading a disk
 * snapshot the fetch never wrote back to and naming those nodes "not weighed".
 *
 * The store is cache-first and lazy: it fetches only on demand, never pre-warms,
 * and never writes back into the harvest file cache - the audit is not a writer
 * of harvest state, so a fetched issue lives in memory for the run and no longer.
 */
import { resolveIssue } from "../harvest/cache.js";
import type { HarvestedIssue } from "../harvest/types.js";

export interface IssueStore {
  /**
   * Cache-first resolve of one issue, memoized: the seed cache first, then a
   * single fetch on a miss, then the answer is never sought again. undefined
   * means the issue does not exist; any other fetch failure throws, and the
   * caller's own boundary decides what an unreachable source means.
   */
  resolve(number: number): Promise<HarvestedIssue | undefined>;
  /**
   * The synchronous view pass D reads: the seed cache, overlaid with everything
   * fetched this run. Pass C resolves every citation before pass D runs, so an id
   * it had to fetch is already here rather than lost with the disk snapshot.
   */
  resolved(): HarvestedIssue[];
  /** How the resolutions were served, so pass C can show cache-first holding. */
  readonly fromCache: number;
  readonly fetched: number;
  /**
   * True when the store has neither a seed nor a way to fetch: it can resolve
   * nothing, and a citation it cannot serve says nothing about whether that
   * citation is false. Pass C reports L3 not_run rather than failing the artifact
   * for the audit's own missing state.
   */
  readonly empty: boolean;
}

export const issueStore = (
  cached: HarvestedIssue[],
  fetch?: (number: number) => Promise<HarvestedIssue | undefined>,
): IssueStore => {
  const seen = new Map<number, HarvestedIssue | undefined>();
  let cacheHits = 0;
  let fetches = 0;
  return {
    async resolve(number) {
      if (seen.has(number)) return seen.get(number);
      let issue = resolveIssue(cached, number);
      if (issue) {
        cacheHits += 1;
      } else if (fetch) {
        issue = await fetch(number);
        if (issue) fetches += 1;
      }
      seen.set(number, issue);
      return issue;
    },
    resolved: () => {
      // The seed cache is always readable; a fetched id overlays it (by
      // construction it was a seed miss, so there is no version to prefer over).
      const byNumber = new Map<number, HarvestedIssue>();
      for (const issue of cached) byNumber.set(issue.number, issue);
      for (const issue of seen.values()) if (issue) byNumber.set(issue.number, issue);
      return [...byNumber.values()];
    },
    get fromCache() {
      return cacheHits;
    },
    get fetched() {
      return fetches;
    },
    empty: cached.length === 0 && fetch === undefined,
  };
};
