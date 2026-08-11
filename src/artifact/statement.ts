/**
 * The audit statement's wording, in four states.
 *
 * #8 section 7.2 fixes the shape of all of them: outcome first in the first
 * three words, counts rather than adjectives, no word the reader has to trust
 * ("thorough", "carefully"), and in every state a paragraph naming what was NOT
 * checked. That last paragraph is load-bearing. An audit statement that lists
 * only successes reads as a marketing claim; naming the boundary of what was
 * verified is what makes the verified part credible, and it is the same move #6
 * made by requiring "The record" on every artifact rather than only degraded
 * ones.
 *
 * Every number here is generated from the run's own results. The report's
 * example wording says "15 hard checks passed", but a build that runs thirteen
 * of them must say thirteen and name the other two - a statement that rounds its
 * own coverage up is the exact failure the stage exists to prevent.
 */
import { html, join, type Safe } from "../render/html.js";
import type { AuditStatus } from "../schema/types.js";
import type { CheckResult } from "../audit/types.js";

export const BADGE_CLASS: Record<AuditStatus, string> = {
  not_run: "st-not-run",
  passed: "st-passed",
  passed_with_warnings: "st-warn",
  failed: "st-failed",
};

export const BADGE_TEXT: Record<AuditStatus, string> = {
  not_run: "Audit: not run",
  passed: "Audit: passed",
  passed_with_warnings: "Audit: passed with warnings",
  failed: "Audit: FAILED",
};

/**
 * The sticky-header badge.
 *
 * Written by the same stamp as the statement, from the same source, so the two
 * cannot disagree - the reader most likely to be misled is the one who never
 * scrolls to section 08.
 */
export const badge = (status: AuditStatus, warnings = 0): Safe => html`<a
  href="#audit-statement"
  class="${BADGE_CLASS[status]}"
  >${status === "passed_with_warnings" ? `Audit: passed, ${warnings} warnings` : BADGE_TEXT[status]}</a
>`;

export interface StatementInput {
  status: AuditStatus;
  checks: CheckResult[];
  /** sha256 of the artifact with the audit slots blanked. */
  contentHash: string;
  auditedAt: string;
  subjectSha: string;
  /** Filesystem notes - screenshots that could not be written, and the like. */
  notes?: string[];
  /** Where the failed copy went, when the artifact was quarantined. */
  quarantinedTo?: string;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const gatesPassed = (checks: CheckResult[]): CheckResult[] =>
  checks.filter((c) => c.class === "gate" && c.outcome === "passed");

const gatesFailed = (checks: CheckResult[]): CheckResult[] =>
  checks.filter((c) => c.class === "gate" && c.outcome === "failed");

const warningsFailed = (checks: CheckResult[]): CheckResult[] =>
  checks.filter((c) => c.class === "warning" && c.outcome === "failed");

/** Checks that did not run or did not apply, with the reason each gave. */
const unchecked = (checks: CheckResult[]): CheckResult[] =>
  checks.filter((c) => c.outcome === "not_run" || c.outcome === "not_applicable");

/** One line per check, so counts are attributable rather than a bare total. */
const measured = (checks: CheckResult[]): Safe =>
  join(
    gatesPassed(checks).map(
      (c) => html`<li>${c.name}${c.count === undefined ? "" : html` (${c.count})`}</li>`,
    ),
  );

const findingList = (checks: CheckResult[]): Safe =>
  join(
    checks.flatMap((c) =>
      (c.findings ?? []).map((f) => html`<li><b>${c.id}</b> ${f}</li>`),
    ),
  );

/**
 * What was not checked, always named.
 *
 * Two kinds, and both belong here: the judgement this stage never certifies, and
 * the checks that did not run in this build or did not apply to this subject.
 * "Could not run" never counts as passing, so it has to appear where a reader
 * decides how much to trust the page.
 */
const notCheckedParagraph = (checks: CheckResult[]): Safe => {
  const missing = unchecked(checks);
  return html`
    <p>
      <b>Not checked:</b> whether the ranking is the right ranking, and whether the omissions are
      the right omissions. Those are judgement, and they are recorded in <code>atlas.json</code>
      rather than certified here.
    </p>
    ${missing.length === 0
      ? html``
      : html`<p>
            ${missing.length} further ${plural(missing.length, "check", "checks")} did not run, and
            ${plural(missing.length, "it is", "they are")} not counted as passing:
          </p>
          <ul>
            ${join(
              missing.map((c) => html`<li><b>${c.id}</b> ${c.name} - ${c.reason ?? "no reason recorded"}</li>`),
            )}
          </ul>`}`;
};

const auditedLine = (input: StatementInput, withHash = true): Safe => html`
  <p class="hash">
    Audited ${input.auditedAt}.${withHash
      ? html` This page, excluding this box, hashes to <code>${input.contentHash}</code>, which is
        the file that was checked.`
      : ""}
  </p>`;

const notesBlock = (notes: string[] | undefined): Safe =>
  notes === undefined || notes.length === 0
    ? html``
    : html`<ul>
        ${join(notes.map((n) => html`<li>${n}</li>`))}
      </ul>`;

/**
 * The `not run` statement.
 *
 * This is the state every freshly rendered artifact is in, and saying so is the
 * honest-degradation contract applied to the artifact's own production. In this
 * state the artifact must carry no other audit conclusion anywhere - which is
 * why #8 ruling 1 deleted the prototype's footer assertions and the source
 * index's "all file links resolve" lede rather than making them conditional.
 */
export const notRunStatement = (): Safe =>
  join([
    html`<p><b>Audit: not run.</b> This artifact was rendered but the audit stage did not run over it.</p>`,
    html`<p>
      No claim on this page has been independently checked: nothing here has been traced to its
      evidence, no link has been resolved, and no check for private-source content has been
      performed. Read it as asserted, not verified.
    </p>`,
  ]);

const passedStatement = (input: StatementInput): Safe => {
  const passed = gatesPassed(input.checks);
  return join([
    html`<p>
      <b>Audit: passed.</b> An independent pass over this rendered file checked every claim on it
      against <code>atlas.json</code> and the subject repository at
      <code>${input.subjectSha}</code>.
    </p>`,
    html`<p>
      ${passed.length} hard ${plural(passed.length, "check", "checks")} passed:
    </p>
    <ul>
      ${measured(input.checks)}
    </ul>`,
    notCheckedParagraph(input.checks),
    notesBlock(input.notes),
    auditedLine(input),
  ]);
};

/**
 * `passed with warnings` is a real ship state, and it must be, or the visual
 * checks would silently acquire gate power the first time someone made the build
 * green by rule.
 *
 * Warnings are enumerated in full, never summarised to a count. A count would be
 * a currency, and #7's ruling on cut disclosure already settled that a bare
 * number is unauditable.
 */
const passedWithWarningsStatement = (input: StatementInput): Safe => {
  const passed = gatesPassed(input.checks);
  const warned = warningsFailed(input.checks);
  const findings = warned.flatMap((c) => c.findings ?? []);
  return join([
    html`<p>
      <b>Audit: passed, with ${findings.length} ${plural(findings.length, "warning", "warnings")}.</b>
      All ${passed.length} hard ${plural(passed.length, "check", "checks")} passed: every claim on
      this page traces to evidence that resolves at <code>${input.subjectSha}</code>.
    </p>`,
    html`<p>
      ${warned.length} advisory ${plural(warned.length, "check", "checks")} did not pass, and none
      of them affects whether a claim on this page is true:
    </p>
    <ul>
      ${findingList(warned)}
    </ul>`,
    notCheckedParagraph(input.checks),
    notesBlock(input.notes),
    auditedLine(input),
  ]);
};

/**
 * The failed statement.
 *
 * It says what a reader must do, first, because this file exists only so the
 * failures can be inspected - it is not the engine's output and must not be
 * quoted or presented.
 */
const failedStatement = (input: StatementInput): Safe => {
  const failed = gatesFailed(input.checks);
  const findings = failed.flatMap((c) => c.findings ?? []);
  return join([
    html`<p>
      <b>Audit: FAILED. Do not rely on this document.</b>
      ${failed.length} hard ${plural(failed.length, "check", "checks")} did not pass, which means
      this page makes at least one claim that could not be verified.
    </p>`,
    html`<ul>
      ${findingList(failed)}
    </ul>`,
    findings.length === 0
      ? html`<p>
          No individual finding was recorded, which is itself a defect in this run: a failure that
          cannot be inspected cannot be fixed.
        </p>`
      : html``,
    html`<p>
      This file was not emitted as the engine's output. It exists only so the failures can be
      inspected, and its contents must not be quoted or presented.
    </p>`,
    notCheckedParagraph(input.checks),
    notesBlock(input.notes),
    auditedLine(input, false),
  ]);
};

const body = (input: StatementInput): Safe => {
  switch (input.status) {
    case "not_run":
      return notRunStatement();
    case "passed":
      return passedStatement(input);
    case "passed_with_warnings":
      return passedWithWarningsStatement(input);
    case "failed":
      return failedStatement(input);
  }
};

/**
 * The statement, wrapped in its own state class.
 *
 * The class lives INSIDE the slot on purpose. Putting it on the slot element
 * instead would place it outside the content the hash blanks, so writing it
 * would falsify the very hash the statement prints.
 */
export const statement = (input: StatementInput): Safe =>
  html`<div class="${BADGE_CLASS[input.status]}">${body(input)}</div>`;

/** How many warnings the badge should report, from the same source as the statement. */
export const warningCount = (checks: CheckResult[]): number =>
  warningsFailed(checks).flatMap((c) => c.findings ?? []).length;
