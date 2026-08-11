/**
 * The audit statement's wording.
 *
 * #8 section 7.2 fixes the shape of all four states: outcome first in the first
 * three words, counts rather than adjectives, no word the reader has to trust
 * ("thorough", "carefully"), and in every state a paragraph naming what was NOT
 * checked. An audit statement that lists only successes reads as a marketing
 * claim; naming the boundary of what was verified is what makes the verified
 * part credible.
 *
 * The render stage can only ever produce `not run`, because at render time that
 * is the truth. The other three states are written by the audit stage into the
 * same reserved slot.
 */
import { html, join, type Safe } from "../render/html.js";
import type { AuditStatus } from "../schema/types.js";

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

/** The sticky-header badge. Written by the same stamp as the statement, from the
 * same source, so the two cannot disagree - the reader most likely to be misled
 * is the one who never scrolls to section 08. */
export const badge = (status: AuditStatus, warnings = 0): Safe => html`<a
  href="#audit-statement"
  class="${BADGE_CLASS[status]}"
  >${status === "passed_with_warnings" ? `Audit: passed, ${warnings} warnings` : BADGE_TEXT[status]}</a
>`;

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
