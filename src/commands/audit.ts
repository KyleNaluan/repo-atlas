/**
 * `repo-atlas audit <artifact.html> --atlas <atlas.json> --clone <path>`
 *
 * All four passes: A (static gates), B (browser gates over a live DOM with the
 * network disabled), C (issue citations, cache-first) and D (the model). The
 * result is stamped into the reserved slot and a failed artifact is quarantined.
 * Every check that did not run is reported BY NAME with its reason rather than
 * omitted - an audit that quietly reports on some of the twenty checks is the
 * exact failure this stage exists to prevent.
 *
 * Pass D can only ever add warnings. A model that is unreachable, or that dies
 * mid-sweep, reports as not run; it never fails the artifact, because making
 * emission depend on model availability is the non-reproducibility #8 rejected.
 */
import { resolve } from "node:path";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { loadAtlas } from "../schema/validate.js";
import { audit, runAudit, type AuditOutcome } from "../audit/run.js";
import { GATES } from "../audit/register.js";
import { declaredViewports } from "../audit/pass-b.js";
import { quarantinePath, stampAudit, withFailureBanner } from "../artifact/stamp.js";
import { fileIssueCache } from "../harvest/cache.js";
import { GhError, getIssue } from "../harvest/gh.js";
import { harvestIssue } from "../harvest/issues.js";
import { sdkJudge } from "../audit/judge.js";
import { blobAt, sliceLines } from "../audit/git.js";
import type { AuditContext, CheckResult } from "../audit/types.js";
import type { AuditRecord } from "../schema/types.js";

const USAGE = `usage: repo-atlas audit <artifact.html> --atlas <atlas.json> --clone <path> [--private-clone <path>]

Runs the gates over a rendered artifact: pass A (static), pass B (browser), pass
C (issue citations, cache-first) and pass D (the model, advisory). Pass
--no-browser to run pass A alone.

options:
  --atlas <path>           the atlas.json the artifact was rendered from (required)
  --clone <path>           a local checkout of the subject at the run's pinned SHA (required)
  --private-clone <path>   a readable checkout of the declared-private source, if there is one
  --screenshots <dir>      write one full-page screenshot per declared viewport
  --no-browser             run only the static passes; the browser gates report as not run
  --out <path>             where the audited artifact is emitted (default: in place)
  --allow-failed           emit a failed artifact, with a banner, for local development
  --no-write-atlas         do not mirror the result into the atlas.json record
  --repo <owner/name>      the subject repo, so pass C can read the harvest cache
                           (default: the subject recorded in the atlas)
  --no-model               skip pass D; its checks report as not run, never as failed

The audit is the only writer of the reserved slot that holds its own result. It
hashes the page with that slot blanked, runs its passes, rewrites only the slot,
and asserts the hash is unchanged - so the statement's claim that "this page,
excluding this box, hashes to X" is one anyone can check.

A hard-gate failure is never emitted at the output path. The failed copy goes to
<out>.failed.html with a banner and the command exits non-zero. --allow-failed
emits it anyway for local development; CI must never set it.

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
    const repo = flag(argv, "--repo") ?? `${ctx.atlas.subject.owner}/${ctx.atlas.subject.repo}`;
    outcome = argv.includes("--no-browser")
      ? audit(ctx)
      : await runAudit(ctx, {
          artifactPath: resolve(artifactPath),
          ...(flag(argv, "--screenshots") === undefined
            ? {}
            : { screenshotDir: resolve(flag(argv, "--screenshots")!) }),
          issues: {
            cached: fileIssueCache().all(repo),
            // Cache-first, network only on a miss (#8). A 404 is the answer -
            // that issue does not exist, so the citation is false - while any
            // other failure is the audit unable to ask, which pass C's own
            // boundary turns into a precondition failure rather than a verdict
            // about the artifact.
            fetch: async (n) => {
              let issue;
              try {
                issue = await getIssue(repo, n);
              } catch (e) {
                if (e instanceof GhError && e.status === 404) return undefined;
                throw e;
              }
              return harvestIssue(repo, issue);
            },
          },
          // No model means pass D reports as not run rather than failing: an
          // unreachable model must never decide whether an artifact ships.
          ...(argv.includes("--no-model")
            ? {}
            : {
                model: {
                  judge: sdkJudge,
                  // Resolve a file citation to its CITED SPAN, not the whole file:
                  // the line range is what pins the claim (git.ts), and the judge
                  // truncates long text, so handing it the file head would grade a
                  // citation past that head against the wrong region. Fall back to
                  // the whole blob only when the citation names no line range.
                  resolve: (e) => {
                    if (e.kind === "command") return e.output_excerpt;
                    if (e.kind !== "file") return undefined;
                    const blob = blobAt(ctx.clone, ctx.atlas.subject.sha, e.path);
                    if (blob === null) return undefined;
                    return e.line_start === undefined
                      ? blob
                      : sliceLines(blob, e.line_start, e.line_end);
                  },
                },
              }),
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

  // The stamp. The audit is the only writer of these slots, and it proves it:
  // stampAudit refuses to write if the page outside them moved.
  const auditedAt = new Date().toISOString();
  let stamped: ReturnType<typeof stampAudit>;
  try {
    stamped = stampAudit({
      artifact: ctx.artifact,
      status: outcome.status,
      checks: outcome.checks,
      auditedAt,
      subjectSha: ctx.atlas.subject.sha,
      ...(outcome.notes.length === 0 ? {} : { notes: outcome.notes }),
    });
  } catch (e) {
    // An artifact with no reserved slot, or one the stamp would move, leaves the
    // audit's result nowhere to live. That is a precondition-class failure - a
    // claim about what the audit was given, never about the subject - and it is
    // reported rather than thrown, so the run still ends in a defined state.
    console.error("failed: precondition");
    console.error(`  - ${e instanceof Error ? e.message : String(e)}`);
    return 78; // EX_CONFIG
  }

  const outPath = resolve(flag(argv, "--out") ?? artifactPath);
  const allowFailed = argv.includes("--allow-failed");
  const failed = outcome.status === "failed";
  let emittedTo = outPath;

  if (failed && !allowFailed) {
    // #8 point 9: a failed artifact does not ship. It goes to a name that cannot
    // be mistaken for the deliverable, so a downstream consumer of the output
    // path can never pick one up by accident, and the banner is a second line of
    // defence rather than the mechanism - a banner is the first thing lost when
    // the reader screenshots a section or shares the file.
    emittedTo = quarantinePath(outPath);
    writeFileSync(emittedTo, withFailureBanner(stamped.artifact), "utf8");
    // The unaudited render is still sitting at the output path; leaving it there
    // would put an artifact the audit rejected exactly where the deliverable
    // belongs.
    if (resolve(artifactPath) === outPath) rmSync(outPath, { force: true });
  } else {
    writeFileSync(outPath, failed ? withFailureBanner(stamped.artifact) : stamped.artifact, "utf8");
  }

  if (argv.includes("--no-write-atlas") === false) {
    const record: AuditRecord = {
      status: outcome.status,
      ...(outcome.failure_kind === undefined ? {} : { failure_kind: outcome.failure_kind }),
      ...(failed ? {} : { content_hash: stamped.contentHash }),
      audited_at: auditedAt,
      checks: outcome.checks.map((c) => ({
        id: c.id,
        name: c.name,
        class: c.class,
        outcome: c.outcome,
        ...(c.count === undefined ? {} : { count: c.count }),
        ...(c.findings === undefined ? {} : { findings: c.findings }),
        ...(c.reason === undefined ? {} : { reason: c.reason }),
      })),
      ...((outcome.measurements?.length ?? 0) > 0 ? { viewports: declaredViewports() } : {}),
    };
    const mirrored = { ...ctx.atlas, record: { ...ctx.atlas.record, audit: record } };
    writeFileSync(atlasPath, `${JSON.stringify(mirrored, null, 2)}\n`, "utf8");
  }

  console.log(`  stamp ${stamped.contentHash}`);
  console.log(`  emit  ${emittedTo}${failed && !allowFailed ? " (quarantined; not the deliverable)" : ""}`);
  console.log(`${outcome.status}: ${gatesPassed} of ${GATES.length} hard gates passed`);
  return failed ? 1 : 0;
};
