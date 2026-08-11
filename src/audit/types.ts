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

/** A gate failure means the artifact makes an untrue claim. */
export const isBlocking = (r: CheckResult): boolean =>
  r.class === "gate" && r.outcome === "failed";
