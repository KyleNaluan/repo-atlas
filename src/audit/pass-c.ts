/**
 * Pass C - network, cache-first. One check.
 *
 * Deliberately last among the deterministic passes and deliberately small (#8).
 * The href walk it replaces would have hit seventy URLs; this resolves eleven
 * citations from a cache harvest already filled, and reaches the network only
 * for an id the cache does not hold.
 *
 * It carries its own error boundary, and needs one that is its own: a throw here
 * is a deterministic check that could not run, so it becomes a defined aborted
 * failure naming L3. Shared with pass B's boundary it would have been reported
 * as "pass B could not run", which is a true-shaped sentence about the wrong
 * pass - and the checks pass C did run would have been dropped with it.
 */
import { resolveIssueCitations, resolutionSource } from "./checks/issue-resolution.js";
import type { IssueStore } from "./issue-store.js";
import { abortedFor, type AuditContext, type CheckResult } from "./types.js";

export interface PassCResult {
  checks: CheckResult[];
  /** Where the citations came from, so the cache-first claim is checkable. */
  notes: string[];
}

export const runPassC = async (ctx: AuditContext, issues: IssueStore): Promise<PassCResult> => {
  try {
    const { result, fromCache, fetched } = await resolveIssueCitations(ctx, issues);
    return { checks: [result], notes: [resolutionSource(fromCache, fetched)] };
  } catch (cause) {
    return { checks: abortedFor(["L3"], cause), notes: [] };
  }
};
