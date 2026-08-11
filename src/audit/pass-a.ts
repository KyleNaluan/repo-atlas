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
import { isBlocking, type AuditContext, type CheckResult } from "./types.js";

/**
 * Order within the pass is cheapest-and-most-decisive first, so a broken
 * artifact fails on a grep rather than after a tree walk.
 */
export const runPassA = (ctx: AuditContext): CheckResult[] => {
  const results: CheckResult[] = [];
  const add = (...rs: CheckResult[]): boolean => {
    results.push(...rs);
    return !rs.some(isBlocking);
  };

  if (!add(selfContained(ctx))) return results;
  if (!add(noAbsentNodeRendered(ctx))) return results;
  if (!add(noDeletedNodeResurrected(ctx))) return results;
  if (!add(displayedRankMatches(ctx))) return results;
  if (!add(presentTenseClaims(ctx))) return results;
  if (!add(shaPinned(ctx))) return results;
  if (!add(...resolveFileEvidence(ctx))) return results;
  add(privateSourceCheck(ctx));
  return results;
};
