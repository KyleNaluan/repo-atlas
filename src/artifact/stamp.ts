/**
 * Stamping the audit's result into the one slot it may write, and quarantining
 * an artifact that failed.
 *
 * The circularity #8 section 7.1 solves: the audit consumes the rendered file,
 * but its result must appear INSIDE that file. Re-rendering after the audit
 * produces a different file from the one that was audited, and the audit's
 * conclusion would then describe a document that no longer exists.
 *
 *   1. render emits the artifact with the slots holding the `not run` statement
 *   2. hash the artifact with every slot's content replaced by a placeholder
 *   3. run the passes over the file as rendered
 *   4. rewrite ONLY the slots
 *   5. recompute the hash and assert it is unchanged, then print it
 *
 * So "this page, excluding this box, hashes to X" is a claim anyone can check by
 * blanking the slots and hashing the file. Step 5 is not decoration: it is the
 * assertion that the stamp touched nothing else, and it fails loudly if it did.
 */
import { contentHash, writeSlot } from "./audit-slot.js";
import { badge, statement, warningCount, type StatementInput } from "./statement.js";
import type { AuditStatus } from "../schema/types.js";
import type { CheckResult } from "../audit/types.js";

export class StampError extends Error {}

export interface StampInput {
  artifact: string;
  status: AuditStatus;
  checks: CheckResult[];
  auditedAt: string;
  subjectSha: string;
  notes?: string[];
}

export interface Stamped {
  artifact: string;
  /** The hash printed inside the statement - of the page excluding the slots. */
  contentHash: string;
}

/**
 * Write the statement and the badge, and prove nothing else moved.
 *
 * Both slots are written from one source, so the badge in the sticky header and
 * the statement in section 08 cannot disagree - the reader most likely to be
 * misled is the one who never scrolls far enough to find the statement.
 */
export const stampAudit = (input: StampInput): Stamped => {
  const before = contentHash(input.artifact);

  const statementInput: StatementInput = {
    status: input.status,
    checks: input.checks,
    contentHash: before,
    auditedAt: input.auditedAt,
    subjectSha: input.subjectSha,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };

  let out = writeSlot(input.artifact, "statement", statement(statementInput).toString());
  out = writeSlot(out, "badge", badge(input.status, warningCount(input.checks)).toString());

  // Everything the audit writes lives INSIDE the slots, including the state
  // styling: an attribute on the slot ELEMENT would sit outside the blanked
  // content, so rewriting it would silently falsify the hash the statement
  // prints. This assertion is what catches that, and it caught exactly that
  // during development.
  const after = contentHash(out);
  if (after !== before) {
    throw new StampError(
      `stamping changed the page outside the audit slots: ${before} became ${after}. ` +
        "The statement's hash claim would be false, so the stamp is refused.",
    );
  }

  return { artifact: out, contentHash: before };
};

/**
 * The failure banner, prepended to a quarantined artifact.
 *
 * #8 point 9 rejected emitting a failed artifact to the output path with a
 * banner, on three grounds, and the first is the sharpest: the banner is the
 * first thing lost to the artifact's own use case. The reader is under time
 * pressure and may screenshot a section or share the file, and a banner is not
 * attached to a claim. So the banner exists only on a file whose NAME already
 * says it is not the deliverable; it is a second line of defence, not the
 * mechanism.
 */
export const FAILURE_BANNER = `<div class="callout bad" style="margin:0;border-radius:0;border-left-width:6px">
<p><b>This is not the engine's output.</b> This copy exists only so a failed audit can be
inspected. Its claims were not verified, it must not be quoted or presented, and the audit's
findings are in section 08.</p>
</div>`;

export const withFailureBanner = (artifact: string): string =>
  artifact.replace(/(<body[^>]*>)/, `$1\n${FAILURE_BANNER}`);

/** `out.html` -> `out.failed.html`, a name that cannot be mistaken for the deliverable. */
export const quarantinePath = (outputPath: string): string =>
  outputPath.replace(/\.html$/i, "") + ".failed.html";
