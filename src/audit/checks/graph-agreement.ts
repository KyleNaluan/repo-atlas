/**
 * G1, G2, G3 - the artifact agrees with the graph it claims to be a view of.
 *
 * #3 makes `atlas.json` the contract and the HTML one view of it. These three
 * checks are what make that more than a slogan: they verify the outcome
 * independently of the mechanism that produced it, so a renderer bug cannot
 * quietly widen what the document says.
 */
import { spec } from "../register.js";
import { failed, passed, type AuditContext, type CheckResult } from "../types.js";

/** Element ids and anchor targets - what "appears in the artifact" means structurally. */
const structuralIds = (artifact: string): Set<string> =>
  new Set([
    ...[...artifact.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""),
    ...[...artifact.matchAll(/href="#([^"]+)"/g)].map((m) => m[1] ?? ""),
  ]);

/**
 * G1 - no `absent`-confidence node appears.
 *
 * #3 makes `absent` a cut, never a hedge, and the renderer applies the gate
 * exactly once at the top of render. This verifies the result rather than
 * trusting the mechanism.
 */
export const noAbsentNodeRendered = (ctx: AuditContext): CheckResult => {
  const ids = structuralIds(ctx.artifact);
  const absent = ctx.atlas.nodes.filter((n) => n.confidence === "absent");
  const leaked = absent.filter((n) => ids.has(n.id));
  return leaked.length === 0
    ? passed(spec("G1"), absent.length)
    : failed(
        spec("G1"),
        leaked.map((n) => `${n.id} has confidence absent but is rendered as an element`),
        absent.length,
      );
};

/**
 * G2 - no deleted node is resurrected.
 *
 * The mechanic matters, and the prototype's first version got it wrong: testing
 * "does the deleted id appear anywhere in the HTML" reported seven resurrections
 * on a clean artifact, and all seven were the ids appearing as table text in The
 * record's deletion table - which the captain's `absent-cut-disclosure` ruling
 * explicitly permits. So the check is STRUCTURAL: a deleted id must not appear
 * as an element id or an anchor target. Appearing as text inside the deletion
 * record is the permitted disclosure, not a resurrection.
 */
export const noDeletedNodeResurrected = (ctx: AuditContext): CheckResult => {
  const ids = structuralIds(ctx.artifact);
  const deleted = [
    ...ctx.atlas.record.deletions.map((d) => d.id),
    ...ctx.atlas.record.absent_cuts.map((c) => c.id),
  ];
  const resurrected = deleted.filter((id) => ids.has(id));
  return resurrected.length === 0
    ? passed(spec("G2"), deleted.length)
    : failed(
        spec("G2"),
        resurrected.map((id) => `${id} was deleted by the rank stage but is rendered as an element`),
        deleted.length,
      );
};

/**
 * G3 - the displayed rank, value and rubric match the graph.
 *
 * The captain ruled (`expose-rank-scores`) that ranked items display their
 * `interview_value` and the rubric version precisely because the ranking is a
 * claim the artifact makes. An attributed claim that does not match its source
 * is worse than an unattributed one, so the attribution has to be checked.
 */
export const displayedRankMatches = (ctx: AuditContext): CheckResult => {
  const problems: string[] = [];

  // Every "value N/5" chip sits inside the block carrying its node's id, so each
  // chip is attributed to the NEAREST PRECEDING id that names a node in the
  // graph. Pairing them positionally in document order instead would silently
  // re-attribute every chip after the first unrelated element id.
  const byId = new Map(ctx.atlas.nodes.map((n) => [n.id, n]));
  const idPositions = [...ctx.artifact.matchAll(/\sid="([^"]+)"/g)]
    .filter((m) => byId.has(m[1] ?? ""))
    .map((m) => ({ index: m.index, id: m[1] ?? "" }));
  let checked = 0;
  for (const chip of ctx.artifact.matchAll(/value (\d+(?:\.\d+)?)\/5/g)) {
    let owner: string | undefined;
    for (const pos of idPositions) {
      if (pos.index < chip.index) owner = pos.id;
      else break;
    }
    const node = owner === undefined ? undefined : byId.get(owner);
    if (!node) {
      problems.push(`a "value ${chip[1]}/5" chip is not inside any node's block`);
      continue;
    }
    checked += 1;
    const shown = Number(chip[1]);
    if (shown !== node.interview_value) {
      problems.push(`${node.id} displays value ${shown}/5 but the graph says ${node.interview_value}`);
    }
  }

  if (!ctx.artifact.includes(ctx.atlas.rubric_version)) {
    problems.push(`the artifact does not display the rubric version ${ctx.atlas.rubric_version}`);
  }
  if (!ctx.artifact.includes(ctx.atlas.profile)) {
    problems.push(`the artifact does not display the profile ${ctx.atlas.profile}`);
  }

  // The generated "N further items were cut" line is a claim about the deletion
  // record, so it is checked against the deletion record.
  const cutLine = /(\d+) further mechanisms? scored above the value floor/.exec(
    ctx.artifact.replace(/<[^>]*>/g, "").replace(/\s+/g, " "),
  );
  const budgetCuts = ctx.atlas.record.deletions.filter(
    (d) => d.kind === "budget" && d.section === "mechanisms",
  ).length;
  if (cutLine && Number(cutLine[1]) !== budgetCuts) {
    problems.push(
      `the artifact reports ${cutLine[1]} mechanisms cut to budget but the deletion record holds ${budgetCuts}`,
    );
  }
  if (!cutLine && budgetCuts > 0) {
    problems.push(
      `the deletion record holds ${budgetCuts} mechanisms cut to budget but the artifact reports none`,
    );
  }

  return problems.length === 0
    ? passed(spec("G3"), checked)
    : failed(spec("G3"), problems, checked);
};
