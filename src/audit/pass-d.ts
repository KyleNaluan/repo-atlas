/**
 * Pass D - the model. Two checks, both advisory, and it runs last.
 *
 * Last because it is the only expensive pass, so a model is never spent on an
 * artifact that already failed. Advisory because #8 confines the model to the
 * two questions computation cannot answer, and because a model-class judge
 * certifying its own upstream's output is a rubber stamp.
 */
import { absenceWitness, proseSupport, type ModelPassOptions } from "./checks/model.js";
import type { AuditContext, CheckResult } from "./types.js";

export const runPassD = async (
  ctx: AuditContext,
  options: ModelPassOptions,
): Promise<CheckResult[]> => {
  const admissible = ctx.atlas.nodes.filter((n) => n.confidence !== "absent");
  return [await proseSupport(admissible, options), await absenceWitness(admissible, options)];
};
