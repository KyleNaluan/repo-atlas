/**
 * The rank stage's deterministic half: what survives, and the record of what did
 * not.
 *
 * Scoring is judgement and belongs to the scorer (#2 puts it behind a model
 * under the versioned rubric). Everything here is mechanical and reproducible:
 * given the same scores, the same nodes survive and the same deletion record is
 * written, every time.
 *
 * Two deletion mechanisms, and #9 rejected each without the other:
 *
 *  - a hard `interview_value` floor, because budgets alone let weak nodes fill an
 *    under-subscribed section;
 *  - per-section budgets, because a floor alone caps nothing when everything
 *    scores mid-range.
 *
 * Both are recorded. Silent deletion is un-auditable, and the deletion record is
 * what makes the ruthlessness defensible - it is also what #8's G2 checks, so the
 * renderer cannot quietly resurrect a node the rank stage cut.
 *
 * This stage is the ONLY place deletion happens. #7 moved budgets out of the
 * renderer for exactly this reason: two authorities over what survives is the
 * failure #6 already rejected for density tiers.
 */
import type { AtlasNode, Deletion, InterviewerQuestion } from "../schema/types.js";
import type { Profile } from "./profile.js";
import { flowArchetype, type FlowArchetype } from "./flow.js";
import {
  boostFor,
  clampScore,
  pinnedBy,
  suppressedBy,
  type Overrides,
  EMPTY_OVERRIDES,
} from "./overrides.js";

/** A node with the score the rubric gave it, before any deletion is applied. */
export interface ScoredNode {
  node: AtlasNode;
  /** 0-5, from the scorer, under the profile's rubric. */
  score: number;
  /** The scorer's one-line justification, kept for the calibration record. */
  because?: string;
}

export interface RankResult {
  /** Survivors, ordered as they will render: value desc, then id for stability. */
  nodes: AtlasNode[];
  /** Every cut, with its score and why - id + score + reason (#9). */
  deletions: Deletion[];
  profile: string;
  rubric_version: string;
  budgets: Record<string, number>;
}

/** Which budget, if any, governs a node type. */
const sectionOf = (node: AtlasNode): string | null =>
  node.type === "mechanism" ? "mechanisms" : node.type === "flow" ? "flows" : null;

const FLOW_ARCHETYPE_LABEL: Record<FlowArchetype, string> = {
  request_response: "request/response",
  shared_state_lineage: "shared-state/data-lineage",
};

/** value desc, then id, so equal scores never shuffle between runs. */
const byValue = (a: ScoredNode, b: ScoredNode): number =>
  b.score - a.score || a.node.id.localeCompare(b.node.id);

const questionText = (q: InterviewerQuestion): string =>
  typeof q === "string" ? q : q.question;

/**
 * The interviewer_questions budget cuts QUESTIONS, not nodes. A question is an
 * entry in a node's `interviewer_questions` array, and several nodes may declare
 * the same one - so this folds by text exactly as the renderer's Q&A table does
 * (one shared question is one row and one budget slot), keeps the top `budget` by
 * the highest declaring node's value, and trims the rest from every node handed on
 * so the renderer stays a pure projection of what survived.
 *
 * The node itself lives: trimming a question is not deleting the node that
 * declared it. Each cut question is one deletion - one folded row is one record,
 * so the renderer's "N further questions were cut" count stays true even when a
 * question was shared - keyed by the same node the renderer attributes the row to
 * (highest value, then id). That id never appears as an element id, so #8's G2 is
 * unaffected.
 */
const trimQuestions = (
  nodes: AtlasNode[],
  budget: number,
  profileName: string,
  deletions: Deletion[],
): AtlasNode[] => {
  const folded = new Map<string, { id: string; index: number; score: number }[]>();
  for (const node of nodes) {
    (node.interviewer_questions ?? []).forEach((q, index) => {
      const text = questionText(q);
      const sites = folded.get(text) ?? [];
      sites.push({ id: node.id, index, score: node.interview_value });
      folded.set(text, sites);
    });
  }
  // Order the folded questions the way the renderer orders its rows - highest
  // declaring node value desc, then text - so the ten we keep are the ten it
  // would show first, and a run never shuffles which question fell over the line.
  // Within a row the canonical site is the highest-value declaring node, then id,
  // matching the node the renderer's questionProv points the row at.
  const rankedQuestions = [...folded.entries()]
    .map(([text, sites]) => {
      const canonical = [...sites].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0]!;
      return { text, canonical };
    })
    .sort((a, b) => b.canonical.score - a.canonical.score || a.text.localeCompare(b.text));

  const cutTexts = new Set<string>();
  rankedQuestions.forEach(({ text, canonical }, position) => {
    if (position < budget) return;
    cutTexts.add(text);
    deletions.push({
      id: `${canonical.id}#interviewer_questions[${canonical.index}]`,
      score: canonical.score,
      reason: `section budget: interviewer_questions capped at ${budget} by the ${profileName} profile; ranked ${position + 1}`,
      kind: "budget",
      section: "interviewer_questions",
      unit: "question",
    });
  });

  if (cutTexts.size === 0) return nodes;
  return nodes.map((node) => {
    const questions = node.interviewer_questions;
    if (!questions?.some((q) => cutTexts.has(questionText(q)))) return node;
    return { ...node, interviewer_questions: questions.filter((q) => !cutTexts.has(questionText(q))) };
  });
};

export const rank = (
  scored: ScoredNode[],
  p: Profile,
  overrides: Overrides = EMPTY_OVERRIDES,
): RankResult => {
  const deletions: Deletion[] = [];

  // Overrides first: they are data a human wrote, and they decide what the floor
  // and the budgets are even allowed to see.
  const adjusted = scored.map((s) => {
    const boost = boostFor(overrides, s.node);
    const score = clampScore(s.score + boost);
    return { ...s, score, node: { ...s.node, interview_value: score } };
  });

  const survivors: ScoredNode[] = [];
  for (const s of adjusted) {
    // Confidence is an admission gate, not a score. In particular, a Flow with
    // one unresolvable arrow is quarantined atomically as `absent`; no high model
    // score and no project pin may resurrect part of that story. Assemble records
    // this cut in absent_cuts, separately from floor/budget deletions, so the two
    // reasons remain distinct (#35, accepted design 6.3 and 10).
    if (s.node.confidence === "absent") continue;

    const suppressed = suppressedBy(overrides, s.node);
    if (suppressed) {
      deletions.push({
        id: s.node.id,
        score: s.score,
        reason: `suppressed by project override: ${suppressed.why}`,
        kind: "floor",
        unit: "node",
      });
      continue;
    }
    const pinned = pinnedBy(overrides, s.node);
    if (!pinned && s.score < p.budgets.interview_value_floor) {
      deletions.push({
        id: s.node.id,
        score: s.score,
        reason: `below the interview_value floor of ${p.budgets.interview_value_floor}`,
        kind: "floor",
        unit: "node",
      });
      continue;
    }
    survivors.push(s);
  }

  // Section budgets, applied to what cleared the floor. A pinned node occupies no
  // budget slot: pinning is a human saying "this one regardless", and letting a
  // pin push out a higher-scoring node would make the override rewrite the
  // ranking rather than add to it.
  const kept: ScoredNode[] = [];
  const kept_in = new Map<string, number>();
  const kept_flow_archetype = new Map<FlowArchetype, number>();
  // Rank position within the section, counting every candidate rather than only
  // the ones that fit. A counter that stops at the cap would report the seventh
  // cut as "ranked 6" alongside the sixth - a recorded reason stating something
  // that is not true, in the record that exists to make deletion auditable.
  const seen_in = new Map<string, number>();
  for (const s of [...survivors].sort(byValue)) {
    const section = sectionOf(s.node);
    const budget = section === null ? undefined : p.budgets[section as "mechanisms" | "flows"];
    if (section === null || budget === undefined || pinnedBy(overrides, s.node)) {
      kept.push(s);
      continue;
    }
    const position = (seen_in.get(section) ?? 0) + 1;
    seen_in.set(section, position);
    const used = kept_in.get(section) ?? 0;
    const archetype = s.node.type === "flow" ? flowArchetype(s.node) : null;
    const archetypeBudget = archetype === null ? undefined : p.flow_archetype_budgets[archetype];
    const archetypeUsed = archetype === null ? 0 : (kept_flow_archetype.get(archetype) ?? 0);
    const sectionBound = used >= budget;
    const archetypeBound =
      archetype !== null && archetypeBudget !== undefined && archetypeUsed >= archetypeBudget;
    if (sectionBound || archetypeBound) {
      // A `capped at N` clause may only name a constraint that actually bound.
      // The section cap and an archetype slot can each bind alone, so the reason
      // states only the one(s) that did - the deletion record #8's G2 relies on
      // must never claim the section was full when the archetype slot bound alone.
      const clauses: string[] = [];
      if (sectionBound) clauses.push(`${section} capped at ${budget} by the ${p.name} profile`);
      if (archetypeBound)
        clauses.push(`${FLOW_ARCHETYPE_LABEL[archetype!]} slot capped at ${archetypeBudget}`);
      deletions.push({
        id: s.node.id,
        score: s.score,
        reason: `section budget: ${clauses.join("; ")}; ranked ${position}`,
        kind: "budget",
        section,
        unit: "node",
      });
      continue;
    }
    kept_in.set(section, used + 1);
    if (archetype !== null) kept_flow_archetype.set(archetype, archetypeUsed + 1);
    kept.push(s);
  }

  // `kept` is already in byValue order - it was pushed while iterating the sorted
  // survivors - so it needs no re-sort. Trim the Q&A budget last, on the survivors
  // it applies to, so the renderer receives only the questions that fit.
  const nodes = trimQuestions(
    kept.map((s) => s.node),
    p.budgets.interviewer_questions,
    p.name,
    deletions,
  );

  return {
    nodes,
    deletions: deletions.sort((a, b) => a.id.localeCompare(b.id)),
    profile: p.name,
    rubric_version: p.rubric_version,
    budgets: { ...p.budgets },
  };
};
