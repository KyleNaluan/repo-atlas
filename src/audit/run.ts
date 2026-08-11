/**
 * The audit run: preconditions, then the passes in fixed order, then a verdict.
 *
 * The verdict rule is #8's classification rule read backwards. A hard-gate
 * failure means the artifact makes an untrue claim, so the outcome is `failed`.
 * A warning means the artifact is worse than it should be, so the outcome is
 * `passed with warnings` - a real ship state, and it must be, or the visual
 * checks would silently acquire gate power the first time someone made the build
 * green by rule.
 *
 * A check that could not run is never counted as passing. It is carried into the
 * statement by name, which is the same discipline #6 imposes on absent sections:
 * silence is never how absence is communicated.
 */
import { checkPreconditions } from "./preconditions.js";
import { runPassA } from "./pass-a.js";
import { checksInPass, REGISTER, type PassName } from "./register.js";
import { notRun, type AuditContext, type CheckResult } from "./types.js";
import type { AuditStatus } from "../schema/types.js";

/** Passes that exist in this build. The rest report `not_run` by name. */
const IMPLEMENTED: PassName[] = ["A"];

export interface AuditOutcome {
  status: AuditStatus;
  failure_kind?: "gate" | "precondition";
  checks: CheckResult[];
  /** Precondition problems, when the run never reached a check. */
  preconditions: string[];
  notes: string[];
}

const verdict = (checks: CheckResult[]): AuditStatus => {
  // An aborted check could not run, so it can never leave the run passed or
  // passed-with-warnings, whatever its class; it fails the run like a gate.
  const hardFailures = checks.filter(
    (c) => c.outcome === "failed" && (c.class === "gate" || c.aborted),
  );
  if (hardFailures.length > 0) return "failed";
  const warnings = checks.filter((c) => c.class === "warning" && c.outcome === "failed");
  return warnings.length > 0 ? "passed_with_warnings" : "passed";
};

/**
 * Checks the register declares but this build does not run yet, reported by name
 * rather than omitted. A twenty-check contract that quietly reports on nine is
 * the failure mode this whole stage exists to prevent.
 */
const unbuilt = (ran: CheckResult[]): CheckResult[] => {
  const done = new Set(ran.map((c) => c.id));
  return REGISTER.filter((s) => !done.has(s.id)).map((s) =>
    notRun(s, `pass ${s.pass} is not built in this version`),
  );
};

export const audit = (ctx: AuditContext): AuditOutcome => {
  const pre = checkPreconditions(ctx.clone, ctx.atlas.subject.sha);
  if (!pre.ok) {
    return {
      status: "failed",
      failure_kind: "precondition",
      checks: REGISTER.map((s) => notRun(s, "a precondition failed before any check ran")),
      preconditions: pre.problems,
      notes: pre.notes,
    };
  }

  const ran = IMPLEMENTED.includes("A") ? runPassA(ctx) : [];
  // A stopped pass leaves its remaining checks unrun; say so rather than
  // implying they were fine.
  const stopped = ran.some((c) => c.class === "gate" && c.outcome === "failed");
  const skippedInPass = stopped
    ? checksInPass("A")
        .filter((s) => !ran.some((c) => c.id === s.id))
        .map((s) => notRun(s, "pass A stopped at an earlier gate failure"))
    : [];

  const checks = [...ran, ...skippedInPass, ...unbuilt([...ran, ...skippedInPass])].sort(
    (a, b) => REGISTER.findIndex((s) => s.id === a.id) - REGISTER.findIndex((s) => s.id === b.id),
  );

  const status = verdict(checks);
  // A run that failed because a check aborted is a precondition finding, not a
  // gate finding: git.ts's contract is that a git or filesystem failure is a
  // claim about the audit's own preconditions, never a false citation.
  const abortedRun = checks.some((c) => c.aborted && c.outcome === "failed");
  return {
    status,
    ...(status === "failed"
      ? { failure_kind: (abortedRun ? "precondition" : "gate") as "gate" | "precondition" }
      : {}),
    checks,
    preconditions: [],
    notes: pre.notes,
  };
};
