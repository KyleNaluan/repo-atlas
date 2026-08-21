/**
 * A profile is a named bundle of (rubric + section budgets) (#9, point 4).
 *
 * v1 ships one - `interview` - with the seam made concrete rather than
 * speculative. Onboarding and handover become additive entries here later,
 * touching zero extraction code, which is the map-level rule that audience
 * changes ranking and never extraction, made structural.
 *
 * The budgets are taken from the hand-made overview's actual shape: exactly five
 * ranked deep dives, two complementary Flows and about ten interviewer questions.
 * They are not round numbers chosen for tidiness - they are the shape a human
 * arrived at when they had to read the result under time pressure.
 */
import { readFileSync } from "node:fs";
import type { FlowArchetype } from "./flow.js";

export interface Profile {
  name: string;
  rubric_version: string;
  /** The rubric prompt asset this profile scores under. */
  rubric_path: string;
  budgets: {
    /** A node scoring below this is deleted outright, whatever its section. */
    interview_value_floor: number;
    /** Per-section caps, forcing ranked cuts even among decent nodes. */
    mechanisms: number;
    /** One Flow section, capped after the floor (#39). */
    flows: number;
    interviewer_questions: number;
  };
  /** The two complementary slots inside the Flow section budget (#39). */
  flow_archetype_budgets: Record<FlowArchetype, number>;
}

export const INTERVIEW: Profile = {
  name: "interview",
  rubric_version: "v1",
  rubric_path: "rubric/interview-v1.md",
  budgets: {
    interview_value_floor: 3,
    mechanisms: 5,
    flows: 2,
    interviewer_questions: 10,
  },
  flow_archetype_budgets: {
    request_response: 1,
    shared_state_lineage: 1,
  },
};

export const PROFILES: Record<string, Profile> = { interview: INTERVIEW };

export class UnknownProfileError extends Error {
  constructor(name: string) {
    super(
      `no profile named "${name}". v1 ships ${Object.keys(PROFILES).join(", ")}; ` +
        `a profile is a named bundle of rubric and budgets, added in src/rank/profile.ts.`,
    );
    this.name = "UnknownProfileError";
  }
}

export const profile = (name: string): Profile => {
  const found = PROFILES[name];
  if (!found) throw new UnknownProfileError(name);
  return found;
};

/** The rubric text a profile scores under, read from its versioned asset. */
export const rubricText = (p: Profile): string =>
  readFileSync(new URL(`../../${p.rubric_path}`, import.meta.url), "utf8");
