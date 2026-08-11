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
import type { AtlasNode, Deletion } from "../schema/types.js";
import type { Profile } from "./profile.js";
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
  node.type === "mechanism" ? "mechanisms" : null;

/** value desc, then id, so equal scores never shuffle between runs. */
const byValue = (a: ScoredNode, b: ScoredNode): number =>
  b.score - a.score || a.node.id.localeCompare(b.node.id);

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
    const suppressed = suppressedBy(overrides, s.node);
    if (suppressed) {
      deletions.push({
        id: s.node.id,
        score: s.score,
        reason: `suppressed by project override: ${suppressed.why}`,
        kind: "floor",
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
  // Rank position within the section, counting every candidate rather than only
  // the ones that fit. A counter that stops at the cap would report the seventh
  // cut as "ranked 6" alongside the sixth - a recorded reason stating something
  // that is not true, in the record that exists to make deletion auditable.
  const seen_in = new Map<string, number>();
  for (const s of [...survivors].sort(byValue)) {
    const section = sectionOf(s.node);
    const budget = section === null ? undefined : p.budgets[section as "mechanisms"];
    if (section === null || budget === undefined || pinnedBy(overrides, s.node)) {
      kept.push(s);
      continue;
    }
    const position = (seen_in.get(section) ?? 0) + 1;
    seen_in.set(section, position);
    const used = kept_in.get(section) ?? 0;
    if (used >= budget) {
      deletions.push({
        id: s.node.id,
        score: s.score,
        reason: `section budget: ${section} capped at ${budget} by the ${p.name} profile; ranked ${position}`,
        kind: "budget",
        section,
      });
      continue;
    }
    kept_in.set(section, used + 1);
    kept.push(s);
  }

  return {
    nodes: [...kept].sort(byValue).map((s) => s.node),
    deletions: deletions.sort((a, b) => a.id.localeCompare(b.id)),
    profile: p.name,
    rubric_version: p.rubric_version,
    budgets: { ...p.budgets },
  };
};
