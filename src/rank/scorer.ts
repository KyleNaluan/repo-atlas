/**
 * The seam between judgement and mechanism.
 *
 * `interview_value` is the only pure-judgement field in the schema (#3), and #2
 * puts it behind a model: plain structured calls under the versioned rubric,
 * taking the node graph and returning scores. Everything downstream of this
 * interface - the floor, the budgets, the deletion record, the ordering - is
 * deterministic code that reproduces exactly given the same scores.
 *
 * The seam exists so that boundary is visible rather than implied. A scorer may
 * decide what a node is worth; it may not decide what survives, because #9 gives
 * deletion to the rank stage and #8's G2 audits the record it leaves.
 *
 * The model-backed implementation is deliberately not wired here yet: how its
 * ground-truth fixture test is credentialed and verified in CI is an open
 * decision, and committing one shape now would foreclose the other. What is
 * settled and built is everything on this side of the interface.
 */
import type { AtlasNode } from "../schema/types.js";
import type { Profile } from "./profile.js";
import type { ScoredNode } from "./rank.js";

export interface ScoreRequest {
  nodes: AtlasNode[];
  profile: Profile;
  /** The rubric prompt asset's text, read from the profile's versioned file. */
  rubric: string;
}

export type Scorer = (request: ScoreRequest) => Promise<ScoredNode[]>;

/**
 * Scores supplied from a file rather than produced here.
 *
 * This is how the deterministic half is exercised end to end without a model,
 * and it is neutral about what eventually fills the file: a live model call, or
 * a recorded fixture. Either way the scores arrive through one interface, so the
 * machinery below never learns where judgement came from.
 */
export interface ScoreFile {
  profile: string;
  rubric_version: string;
  scores: { id: string; score: number; because?: string }[];
}

export class MissingScoreError extends Error {
  constructor(missing: string[]) {
    super(
      `no score for ${missing.length} node${missing.length === 1 ? "" : "s"}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}. ` +
        `Every node must be scored before ranking: an unscored node is not a zero, it is a node nobody judged, ` +
        `and ranking it as zero would delete it while making the deletion record say it was weighed.`,
    );
    this.name = "MissingScoreError";
  }
}

export class RubricMismatchError extends Error {
  constructor(fileVersion: string, profileVersion: string) {
    super(
      `scores were produced under rubric ${fileVersion} but this run ranks under ${profileVersion}. ` +
        `The rubric is versioned precisely so a ranking cannot silently mix two of them.`,
    );
    this.name = "RubricMismatchError";
  }
}

export class ProfileMismatchError extends Error {
  constructor(fileProfile: string, runProfile: string) {
    super(
      `scores were produced under profile "${fileProfile}" but this run ranks under "${runProfile}". ` +
        `A profile bundles a rubric with its section budgets; scores from one profile must not be ` +
        `ranked under another, the same reason the rubric version is checked.`,
    );
    this.name = "ProfileMismatchError";
  }
}

export const scoresFromFile = (file: ScoreFile, p: Profile) => {
  if (file.profile !== p.name) {
    throw new ProfileMismatchError(file.profile, p.name);
  }
  if (file.rubric_version !== p.rubric_version) {
    throw new RubricMismatchError(file.rubric_version, p.rubric_version);
  }
  const byId = new Map(file.scores.map((s) => [s.id, s]));
  return (nodes: AtlasNode[]): ScoredNode[] => {
    const missing = nodes.filter((n) => !byId.has(n.id)).map((n) => n.id);
    if (missing.length > 0) throw new MissingScoreError(missing);
    return nodes.map((node) => {
      const s = byId.get(node.id)!;
      return { node, score: s.score, ...(s.because === undefined ? {} : { because: s.because }) };
    });
  };
};
