/**
 * Per-project tuning: data, not rubric (#9, point 2).
 *
 * A project may pin, boost or suppress specific nodes or node types. It may not
 * rewrite the rubric - that changes by commit only, so runs stay reproducible
 * and a scoring change is reviewable rather than ambient.
 *
 * The override file doubles as a calibration record: it is the written trace of
 * where a human disagreed with the rubric, which is the input a future rubric
 * revision needs. That is why an override carries a `why` - an untraceable
 * thumb on the scale is worth less than no thumb at all.
 */
import type { AtlasNode, NodeType } from "../schema/types.js";

export interface Override {
  /** Exactly one of these selects what the override applies to. */
  id?: string;
  type?: NodeType;
  probe_id?: string;
  /** Why a human disagreed with the rubric here. Required: this is the record. */
  why: string;
}

export interface PinOverride extends Override {
  /** Survives the floor and every budget, whatever it scored. */
  pin: true;
}

export interface BoostOverride extends Override {
  /** Added to the rubric's score, clamped to 0-5. */
  boost: number;
}

export interface SuppressOverride extends Override {
  /** Deleted regardless of score, recorded like any other deletion. */
  suppress: true;
}

export type ProjectOverride = PinOverride | BoostOverride | SuppressOverride;

export interface Overrides {
  overrides: ProjectOverride[];
}

export const EMPTY_OVERRIDES: Overrides = { overrides: [] };

const matches = (o: ProjectOverride, node: AtlasNode): boolean =>
  (o.id !== undefined && o.id === node.id) ||
  (o.type !== undefined && o.type === node.type) ||
  (o.probe_id !== undefined && o.probe_id === node.probe_id);

export const pinnedBy = (overrides: Overrides, node: AtlasNode): PinOverride | undefined =>
  overrides.overrides.find((o): o is PinOverride => "pin" in o && matches(o, node));

export const suppressedBy = (
  overrides: Overrides,
  node: AtlasNode,
): SuppressOverride | undefined =>
  overrides.overrides.find((o): o is SuppressOverride => "suppress" in o && matches(o, node));

/** Total boost for a node, so a type-level and an id-level boost compose. */
export const boostFor = (overrides: Overrides, node: AtlasNode): number =>
  overrides.overrides
    .filter((o): o is BoostOverride => "boost" in o && matches(o, node))
    .reduce((sum, o) => sum + o.boost, 0);

export const clampScore = (score: number): number => Math.max(0, Math.min(5, score));
