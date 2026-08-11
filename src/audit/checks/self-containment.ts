/**
 * S1 - zero external resource references.
 *
 * The static half of the self-containment claim, kept as a fast pre-flight
 * exactly as #7 recommended. S2 (load it in a browser with the network disabled
 * and assert one request) is the other half, and neither subsumes the other: S1
 * catches a reference in code that never executes, S2 catches a request S1's
 * regexes do not know how to spell. Keeping both is cheap and the failure modes
 * are genuinely disjoint.
 */
import { findExternalRefs } from "../../artifact/self-contained.js";
import { spec } from "../register.js";
import { failed, passed, type AuditContext, type CheckResult } from "../types.js";

export const selfContained = (ctx: AuditContext): CheckResult => {
  const problems = findExternalRefs(ctx.artifact);
  return problems.length === 0
    ? passed(spec("S1"), 0)
    : failed(
        spec("S1"),
        problems.map((p) => `${p.what}: ${p.snippet}`),
        problems.length,
      );
};
