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
 *
 * Two entry points, and the split is deliberate rather than convenience:
 * `audit()` runs the passes that need nothing but the filesystem, synchronously;
 * `runAudit()` adds the browser pass. Keeping the static half callable on its own
 * is what lets its own error boundary be tested without a browser in the way.
 */
import { checkPreconditions } from "./preconditions.js";
import { runPassA } from "./pass-a.js";
import { runPassB, type PassBOptions } from "./pass-b.js";
import { NoBrowserError } from "./browser.js";
import { checksInPass, REGISTER, type PassName } from "./register.js";
import { notRun, type AuditContext, type CheckResult } from "./types.js";
import type { AuditStatus } from "../schema/types.js";
import type { ViewportMeasurement } from "./checks/visual.js";

/** Passes that exist in this build at all. The rest report `not_run` by name. */
const IMPLEMENTED: PassName[] = ["A", "B"];

export interface AuditOutcome {
  status: AuditStatus;
  failure_kind?: "gate" | "precondition";
  checks: CheckResult[];
  /** Precondition problems, when the run never reached a check. */
  preconditions: string[];
  notes: string[];
  /** Per-viewport layout measurements, when the browser pass ran. */
  measurements?: ViewportMeasurement[];
  /** Screenshots kept as artifacts of the audit, never as inputs to a check. */
  screenshots?: string[];
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
 * Checks the register declares but this invocation did not run, reported by name
 * with the real reason. A twenty-check contract that quietly reports on nine is
 * the failure mode this whole stage exists to prevent - and once a pass exists,
 * saying it "is not built" would be the same lie in the other direction.
 */
const unrun = (ran: CheckResult[], passesRun: PassName[]): CheckResult[] => {
  const done = new Set(ran.map((c) => c.id));
  return REGISTER.filter((s) => !done.has(s.id)).map((s) =>
    notRun(
      s,
      passesRun.includes(s.pass)
        ? `pass ${s.pass} stopped before this check ran`
        : IMPLEMENTED.includes(s.pass)
          ? `pass ${s.pass} did not run in this invocation`
          : `pass ${s.pass} is not built in this version`,
    ),
  );
};

const assemble = (
  ran: CheckResult[],
  passesRun: PassName[],
  notes: string[],
): AuditOutcome => {
  // A stopped pass leaves its remaining checks unrun; say so rather than
  // implying they were fine.
  const skipped = passesRun.flatMap((pass) => {
    const stopped = ran.some(
      (c) => c.outcome === "failed" && c.class === "gate" && checksInPass(pass).some((s) => s.id === c.id),
    );
    if (!stopped) return [];
    return checksInPass(pass)
      .filter((s) => !ran.some((c) => c.id === s.id))
      .map((s) => notRun(s, `pass ${pass} stopped at an earlier gate failure`));
  });

  const all = [...ran, ...skipped];
  const checks = [...all, ...unrun(all, passesRun)].sort(
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
    notes,
  };
};

const preconditionOutcome = (problems: string[], notes: string[]): AuditOutcome => ({
  status: "failed",
  failure_kind: "precondition",
  checks: REGISTER.map((s) => notRun(s, "a precondition failed before any check ran")),
  preconditions: problems,
  notes,
});

/** The static passes, synchronously. Pass A today. */
export const audit = (ctx: AuditContext): AuditOutcome => {
  const pre = checkPreconditions(ctx.clone, ctx.atlas.subject.sha);
  if (!pre.ok) return preconditionOutcome(pre.problems, pre.notes);
  return assemble(runPassA(ctx), ["A"], pre.notes);
};

export interface RunAuditOptions extends PassBOptions {
  /** The file on disk. Pass B loads it in a browser, so it needs the path. */
  artifactPath: string;
}

/**
 * The full deterministic suite: pass A, then pass B.
 *
 * A missing browser is a precondition failure rather than a skip, for the same
 * reason a missing clone is. Quietly reporting five hard gates as inapplicable
 * would let a machine without Chrome mint an artifact claiming more verification
 * than it received.
 */
export const runAudit = async (
  ctx: AuditContext,
  options: RunAuditOptions,
): Promise<AuditOutcome> => {
  const pre = checkPreconditions(ctx.clone, ctx.atlas.subject.sha);
  if (!pre.ok) return preconditionOutcome(pre.problems, pre.notes);

  const a = runPassA(ctx);
  // Pass A decides whether pass B is worth running: there is no point launching
  // a browser to look at an artifact whose evidence does not resolve.
  if (a.some((c) => c.outcome === "failed" && (c.class === "gate" || c.aborted))) {
    return assemble(a, ["A"], pre.notes);
  }

  try {
    const b = await runPassB(options.artifactPath, ctx.atlas, options);
    return {
      ...assemble([...a, ...b.checks], ["A", "B"], pre.notes),
      measurements: b.measurements,
      screenshots: b.screenshots,
    };
  } catch (error) {
    // Any throw escaping pass B - a missing browser, a page that will not load,
    // a browser that dies mid-launch - is a precondition failure, never a generic
    // crash. The reasoning is the one NoBrowserError already gets: the audit could
    // not see what it needed, which is a claim about the audit and never about the
    // artifact. Pass A's real answers are preserved; the pass B checks are named as
    // not run with the underlying cause, so nothing degrades into exit 70.
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      error instanceof NoBrowserError
        ? "pass B could not run: no browser was available"
        : `pass B could not run: ${message}`;
    return {
      ...preconditionOutcome([message], pre.notes),
      checks: [
        ...a,
        ...unrun(a, ["A"]).map((c) =>
          checksInPass("B").some((s) => s.id === c.id) ? { ...c, reason } : c,
        ),
      ].sort(
        (x, y) =>
          REGISTER.findIndex((s) => s.id === x.id) - REGISTER.findIndex((s) => s.id === y.id),
      ),
    };
  }
};
