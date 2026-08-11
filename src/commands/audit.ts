/**
 * `repo-atlas audit <artifact.html> --atlas <atlas.json> --clone <path>`
 *
 * Pass A only in this build. The stamping mechanic, the browser pass and the
 * model pass land in later stages, and until they do the audit reports every
 * check it did not run BY NAME rather than omitting it - an audit that quietly
 * reports on nine of twenty checks is the exact failure this stage exists to
 * prevent.
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadAtlas } from "../schema/validate.js";
import { audit, runAudit, type AuditOutcome } from "../audit/run.js";
import { GATES } from "../audit/register.js";
import type { AuditContext, CheckResult } from "../audit/types.js";

const USAGE = `usage: repo-atlas audit <artifact.html> --atlas <atlas.json> --clone <path> [--private-clone <path>]

Runs the deterministic static gates (pass A) over a rendered artifact.

options:
  --atlas <path>           the atlas.json the artifact was rendered from (required)
  --clone <path>           a local checkout of the subject at the run's pinned SHA (required)
  --private-clone <path>   a readable checkout of the declared-private source, if there is one
  --screenshots <dir>      write one full-page screenshot per declared viewport
  --no-browser             run only the static passes; the browser gates report as not run

Pass B loads the artifact in a browser with the network disabled. It needs a
Chrome-family browser on the machine; set CHROME_PATH if it is somewhere
unusual. A missing browser is a precondition failure, not a skip - the audit
cannot certify what it was unable to open.

Preconditions are asserted before any check runs: the clone must exist, its HEAD
must equal the run's pinned SHA, and its worktree must be clean. A missing
precondition is its own failure, never a pass and never a silent skip.`;

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const line = (c: CheckResult): string => {
  const mark =
    c.outcome === "passed"
      ? "pass"
      : c.outcome === "failed"
        ? c.class === "gate"
          ? "FAIL"
          : "warn"
        : c.outcome === "not_applicable"
          ? "n/a "
          : "----";
  const count = c.count === undefined ? "" : ` (${c.count})`;
  return `  ${mark}  ${c.id.padEnd(3)} ${c.name}${count}`;
};

export const auditCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const artifactPath = argv.find((a) => !a.startsWith("-") && a.endsWith(".html"));
  const atlasPath = flag(argv, "--atlas");
  const clone = flag(argv, "--clone");
  if (!artifactPath || !atlasPath || !clone) {
    console.error(USAGE);
    return 64;
  }

  let ctx: AuditContext;
  let outcome: AuditOutcome;
  try {
    ctx = {
      artifact: readFileSync(artifactPath, "utf8"),
      atlas: loadAtlas(atlasPath),
      clone: resolve(clone),
      ...(flag(argv, "--private-clone") === undefined
        ? {}
        : { privateClone: resolve(flag(argv, "--private-clone")!) }),
    };
    outcome = argv.includes("--no-browser")
      ? audit(ctx)
      : await runAudit(ctx, {
          artifactPath: resolve(artifactPath),
          ...(flag(argv, "--screenshots") === undefined
            ? {}
            : { screenshotDir: resolve(flag(argv, "--screenshots")!) }),
        });
  } catch (e) {
    // The per-check boundary means audit() does not throw for a check failure;
    // this catches the surrounding I/O (unreadable artifact, invalid atlas) so
    // the command exits non-zero with a message rather than a stack trace.
    console.error(`failed: ${e instanceof Error ? e.message : String(e)}`);
    return 70; // EX_SOFTWARE
  }

  console.log(`audit ${artifactPath} against ${atlasPath} at ${ctx.atlas.subject.sha}`);
  // Two precondition shapes, told apart structurally rather than by message text.
  // A PRE-FLIGHT failure (clone missing, HEAD mismatch, dirty tree) stopped the
  // run before any check, so every check is not_run and the problems are all there
  // is to report. A MID-RUN pass failure threw after pass A had produced real
  // results; runAudit preserved those and named the pass B checks not_run with the
  // cause, so the report below is printed alongside the problems. The audit says
  // what it established and what it did not - printing only the one-line failure
  // when eight gates actually ran is the same silence #6 forbids elsewhere.
  const anyCheckRan = outcome.checks.some((c) => c.outcome !== "not_run");
  if (outcome.preconditions.length > 0) {
    console.error("failed: precondition");
    for (const p of outcome.preconditions) console.error(`  - ${p}`);
    if (!anyCheckRan) return 78; // EX_CONFIG - nothing ran; nothing to report
  }
  for (const note of outcome.notes) console.log(`  note  ${note}`);
  for (const c of outcome.checks) console.log(line(c));
  for (const c of outcome.checks) {
    for (const f of c.findings ?? []) console.log(`        ${c.id}: ${f}`);
    // Both not_applicable and not_run carry a mandatory reason, and neither is a
    // pass; report every check it did not run BY NAME and with its reason,
    // rather than dropping the reason and communicating absence by silence.
    if (c.reason) console.log(`        ${c.id}: ${c.reason}`);
  }

  for (const shot of outcome.screenshots ?? []) {
    console.log(`  shot  ${shot}`);
  }

  // A mid-run precondition failure printed its full report above; the run still
  // did not establish what it set out to, so it exits 78 like the pre-flight case
  // rather than falling through to the gate-count summary.
  if (outcome.preconditions.length > 0) return 78; // EX_CONFIG

  const gatesPassed = outcome.checks.filter(
    (c) => c.class === "gate" && c.outcome === "passed",
  ).length;
  console.log(`${outcome.status}: ${gatesPassed} of ${GATES.length} hard gates passed`);
  return outcome.status === "failed" ? 1 : 0;
};
