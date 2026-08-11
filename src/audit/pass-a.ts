/**
 * Pass A - static, no browser, no network.
 *
 * Nine of the fifteen hard gates live here, and it runs first because it is the
 * cheapest and the most decisive: there is no point launching a browser to look
 * at an artifact whose evidence does not resolve.
 *
 * A Pass A gate failure stops the audit (#8, point 2). That is not an
 * optimisation - it is the same reasoning as the confidence gate. Once the
 * artifact is known to make an untrue claim, everything downstream would be
 * measuring the quality of a document that is not going to ship.
 */
import { selfContained } from "./checks/self-containment.js";
import { presentTenseClaims, resolveFileEvidence, shaPinned } from "./checks/evidence.js";
import {
  displayedRankMatches,
  noAbsentNodeRendered,
  noDeletedNodeResurrected,
} from "./checks/graph-agreement.js";
import { privateSourceCheck } from "./checks/private-source.js";
import { abortedFor, isBlocking, type AuditContext, type CheckResult } from "./types.js";

/**
 * Order within the pass is cheapest-and-most-decisive first, so a broken
 * artifact fails on a grep rather than after a tree walk. Each entry names the
 * register ids it owns so that when it throws the boundary can report those
 * checks as aborted by name (`resolveFileEvidence` produces L1 and L2 together).
 */
interface Step {
  ids: string[];
  run: (ctx: AuditContext) => CheckResult[];
}

const STEPS: Step[] = [
  { ids: ["S1"], run: (c) => [selfContained(c)] },
  { ids: ["G1"], run: (c) => [noAbsentNodeRendered(c)] },
  { ids: ["G2"], run: (c) => [noDeletedNodeResurrected(c)] },
  { ids: ["G3"], run: (c) => [displayedRankMatches(c)] },
  { ids: ["E2"], run: (c) => [presentTenseClaims(c)] },
  { ids: ["L5"], run: (c) => [shaPinned(c)] },
  { ids: ["L1", "L2"], run: (c) => resolveFileEvidence(c) },
  { ids: ["P1"], run: (c) => [privateSourceCheck(c)] },
];

/**
 * Run one step behind a per-check error boundary. A check that throws - git
 * could not read a blob, the filesystem could not be walked - becomes a defined
 * `aborted` failure for each id it owns rather than an unhandled exception that
 * escapes audit(). This is the structural close of the crash-instead-of-report
 * class: the boundary is per-check, so the report can still say which check
 * aborted and the checks it never reached are named rather than lost.
 */
const runStep = (ctx: AuditContext, step: Step): CheckResult[] => {
  try {
    return step.run(ctx);
  } catch (cause) {
    return abortedFor(step.ids, cause);
  }
};

export const runPassA = (ctx: AuditContext): CheckResult[] => {
  const results: CheckResult[] = [];
  for (const step of STEPS) {
    const rs = runStep(ctx, step);
    results.push(...rs);
    if (rs.some(isBlocking)) return results;
  }
  return results;
};
