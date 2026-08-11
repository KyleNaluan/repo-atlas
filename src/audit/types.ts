/**
 * What a check is handed, and what it may say back.
 *
 * A check returns findings; it never decides an outcome, never edits the
 * artifact, and never reaches for anything not in its context. #8's governing
 * rule cuts both ways: the audit may only make claims it can independently
 * establish from the artifact and the pinned tree, and this type is where that
 * is made structural - a check that wants something outside this context has to
 * add it here, in the open.
 */
import type { AuditCheckOutcome, Atlas } from "../schema/types.js";
import type { CheckSpec } from "./register.js";

export interface AuditContext {
  /** The rendered file, byte for byte as it will ship. */
  artifact: string;
  /** The graph it was rendered from. */
  atlas: Atlas;
  /** Path to a local checkout of the subject at the run's pinned SHA. */
  clone: string;
  /** Path to a readable checkout of the declared-private source, when there is one. */
  privateClone?: string;
}

export interface CheckResult {
  id: string;
  name: string;
  class: CheckSpec["class"];
  outcome: AuditCheckOutcome;
  /** What the check measured, for the counts-not-adjectives wording. */
  count?: number;
  /** One line per finding. Enumerated in full in the statement, never summarised. */
  findings?: string[];
  /** Why the check did not run. Required when the outcome is not_applicable. */
  reason?: string;
  /**
   * Set when the check's execution threw rather than returning an outcome. Such a
   * result is `failed` and never counts as a pass, but the run's failure is a
   * precondition finding, not a gate finding: the audit could not see what it
   * needed, which is a claim about the audit and never about the artifact.
   */
  aborted?: boolean;
}

export type Check = (ctx: AuditContext) => Promise<CheckResult> | CheckResult;

export const passed = (s: CheckSpec, count?: number): CheckResult => ({
  id: s.id,
  name: s.name,
  class: s.class,
  outcome: "passed",
  ...(count === undefined ? {} : { count }),
});

export const failed = (s: CheckSpec, findings: string[], count?: number): CheckResult => ({
  id: s.id,
  name: s.name,
  class: s.class,
  outcome: "failed",
  findings,
  ...(count === undefined ? {} : { count }),
});

/**
 * A check that could not run says so by name, and "could not run" never counts
 * as passing (#8). The reason is mandatory for exactly that reason.
 *
 * The distinction an author must draw when reaching for this, and it is NOT
 * simply "count 0 means not_applicable":
 *
 * - A check with no POPULATION to examine reports not_applicable with a reason.
 *   L2 with zero line ranges resolved nothing, so it cannot claim a pass.
 * - A check that examined its population and found nothing wrong is a genuine
 *   pass, even at count 0. G1 finding zero absent nodes rendered and G2 finding
 *   zero resurrections both examined the whole graph and found no violation;
 *   those are real passes, not vacuous ones.
 */
export const notApplicable = (s: CheckSpec, reason: string): CheckResult => ({
  id: s.id,
  name: s.name,
  class: s.class,
  outcome: "not_applicable",
  reason,
});

export const notRun = (s: CheckSpec, reason: string): CheckResult => ({
  id: s.id,
  name: s.name,
  class: s.class,
  outcome: "not_run",
  reason,
});

/**
 * A check whose execution threw. #8 defines exactly four outcome states, and a
 * stack trace is not one of them: an unexpected throw from any check becomes a
 * defined `failed` outcome naming the check and the underlying error. It is never
 * a pass, and because the failure means the audit could not run the check at all
 * it blocks the run like a gate failure, so the checks it never reached are
 * reported by name rather than vanishing. A git or filesystem failure is a
 * precondition finding (git.ts: a bad object is never a false citation).
 */
export const aborted = (s: CheckSpec, cause: unknown): CheckResult => ({
  id: s.id,
  name: s.name,
  class: s.class,
  outcome: "failed",
  findings: [`could not run: ${cause instanceof Error ? cause.message : String(cause)}`],
  aborted: true,
});

/**
 * A failure the pass must stop on. A gate failure means the artifact makes an
 * untrue claim; an aborted check means the audit could not run at all. Both are
 * failures the pass cannot report past, whatever the check's class.
 */
export const isBlocking = (r: CheckResult): boolean =>
  r.outcome === "failed" && (r.class === "gate" || r.aborted === true);
