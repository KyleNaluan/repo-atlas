/**
 * The rank stage's deterministic half.
 *
 * The ground-truth fixture (#9, point 1) is the hand-made overview's own
 * ranking: its five ordered deep dives and the six nodes it cut. This suite
 * pins the half that does not need a model - given the human's scores, the
 * machinery must reproduce the human's shape exactly, including which cut was a
 * floor cut and which was a budget cut.
 *
 * The other half of that fixture - whether a model scoring under the versioned
 * rubric ARRIVES at those scores - needs the scorer, which is not wired while
 * how it is credentialed in CI is being decided. What is asserted here is
 * asserted fully; nothing pretends to check the part that is absent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rank, type ScoredNode } from "../../src/rank/rank.js";
import { INTERVIEW, profile, rubricText, UnknownProfileError } from "../../src/rank/profile.js";
import {
  MissingScoreError,
  RubricMismatchError,
  scoresFromFile,
  type ScoreFile,
} from "../../src/rank/scorer.js";
import type { Overrides } from "../../src/rank/overrides.js";
import type { Atlas, AtlasNode, MechanismNode } from "../../src/schema/types.js";

const atlas = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/swe-prep.atlas.json", import.meta.url)), "utf8"),
) as Atlas;

/** The reference ranking: the hand-made overview's five deep dives, in order. */
const REFERENCE_DIVES = [
  "m-grader-runner-seam",
  "m-second-language",
  "m-complexity-honesty",
  "m-content-boundary",
  "m-three-derivations",
];

/** What the human cut, and by which mechanism. */
const REFERENCE_CUTS = {
  budget: ["m-answer-tells"],
  floor: ["f-endpoint-inventory", "f-package-tour", "m-option-shuffler", "m-warmup-interleaving"],
};

/**
 * The reference node set with the human's own scores: the surviving nodes at the
 * value they were given, plus the six the record says were cut at theirs.
 */
const referenceScored = (): ScoredNode[] => {
  const kept: ScoredNode[] = atlas.nodes.map((node) => ({
    node,
    score: node.interview_value,
  }));
  const cut: ScoredNode[] = atlas.record.deletions.map((d) => ({
    node: {
      type: d.id.startsWith("f-") ? "fact" : "mechanism",
      id: d.id,
      title: d.id,
      evidence: [],
      confidence: "verified",
      interview_value: d.score,
      ...(d.id.startsWith("f-")
        ? { label: d.id, value: "x", source: "file" }
        : { what: "w", why_interesting: "y", enforcement: "convention", gotchas: [] }),
    } as AtlasNode,
    score: d.score,
  }));
  return [...kept, ...cut];
};

const mechanism = (id: string, over: Partial<MechanismNode> = {}): MechanismNode => ({
  type: "mechanism",
  id,
  title: id,
  evidence: [],
  confidence: "verified",
  interview_value: 0,
  what: "w",
  why_interesting: "y",
  enforcement: "convention",
  gotchas: [],
  ...over,
});

const scored = (entries: [string, number][]): ScoredNode[] =>
  entries.map(([id, score]) => ({ node: mechanism(id), score }));

/* ------------------------------------------------ the ground truth */

describe("the rubric's ground-truth fixture", () => {
  const result = rank(referenceScored(), INTERVIEW);

  it("reproduces the hand-made overview's five deep dives, in its order", () => {
    const dives = result.nodes.filter((n) => n.type === "mechanism").map((n) => n.id);
    expect(dives).toEqual(REFERENCE_DIVES);
  });

  it("cuts everything the human cut", () => {
    const cut = result.deletions.map((d) => d.id);
    for (const id of [...REFERENCE_CUTS.budget, ...REFERENCE_CUTS.floor]) {
      expect(cut, id).toContain(id);
    }
  });

  it("also cuts two nodes the hand-authored fixture kept below its own floor", () => {
    // Not a defect in the rank stage - a discrepancy in the reference data, and
    // worth pinning rather than papering over.
    //
    // #9 is unambiguous that the floor "deletes low-scoring nodes outright", and
    // the fixture's own deletion record gives the floor as 3. But the fixture
    // keeps a Fact and an Edge scored 2, while cutting Facts scored 1.0 and 1.2
    // for being below that same floor. #7's report says why this is possible:
    // atlas.sample.json is hand-authored stand-in data whose scores are the
    // author's, not a model's, so its numbers were never held to one rule.
    //
    // The resolution governs over the fixture, so the floor stays global. What
    // #9 actually names as the ground truth - "its five ordered deep dives" - is
    // reproduced exactly, and that is asserted above.
    const extra = result.deletions
      .map((d) => d.id)
      .filter((id) => ![...REFERENCE_CUTS.budget, ...REFERENCE_CUTS.floor].includes(id));
    expect(extra.sort()).toEqual(["e-surefire-pin", "f-packages"]);
    for (const id of extra) {
      const node = atlas.nodes.find((n) => n.id === id)!;
      expect(node.interview_value, id).toBeLessThan(INTERVIEW.budgets.interview_value_floor);
    }
  });

  it("cuts each one by the mechanism the record says", () => {
    // The distinction is the point of having two mechanisms: a floor cut is
    // "not worth saying", a budget cut is "worth saying and still cut to fit".
    for (const id of REFERENCE_CUTS.budget) {
      expect(result.deletions.find((d) => d.id === id)?.kind, id).toBe("budget");
    }
    for (const id of REFERENCE_CUTS.floor) {
      expect(result.deletions.find((d) => d.id === id)?.kind, id).toBe("floor");
    }
  });

  it("records the section a budget cut was made against", () => {
    expect(result.deletions.find((d) => d.kind === "budget")?.section).toBe("mechanisms");
  });

  it("carries the profile and rubric version the ranking was made under", () => {
    expect(result.profile).toBe("interview");
    expect(result.rubric_version).toBe("v1");
    expect(result.budgets).toEqual(atlas.record.budgets);
  });
});

/* --------------------------------------------------- the two mechanisms */

describe("deletion uses two mechanisms, and needs both", () => {
  it("the floor deletes a weak node whatever the section budget allows", () => {
    // Budgets alone let weak nodes fill an under-subscribed section.
    const result = rank(scored([["a", 5], ["b", 1]]), INTERVIEW);
    expect(result.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(result.deletions[0]).toMatchObject({ id: "b", kind: "floor" });
  });

  it("the budget cuts a good node when the section is full", () => {
    // A floor alone caps nothing when everything scores mid-range.
    const six = scored([["a", 4], ["b", 4], ["c", 4], ["d", 4], ["e", 4], ["f", 4]]);
    const result = rank(six, INTERVIEW);
    expect(result.nodes).toHaveLength(5);
    const cut = result.deletions.find((d) => d.kind === "budget");
    expect(cut?.id).toBe("f");
    expect(cut?.score).toBe(4);
    expect(cut?.reason).toContain("capped at 5");
    expect(cut?.reason).toContain("ranked 6");
  });

  it("reports each budget cut's real rank position, not the cap", () => {
    // Eight candidates for five slots: the cuts are ranked 6, 7 and 8. A counter
    // that stopped at the cap would call all three "ranked 6", which is a
    // recorded reason asserting something untrue in the record that exists to
    // make the deletion auditable.
    const eight = scored([
      ["a", 5], ["b", 5], ["c", 5], ["d", 5], ["e", 5], ["f", 4], ["g", 4], ["h", 4],
    ]);
    const positions = rank(eight, INTERVIEW)
      .deletions.filter((d) => d.kind === "budget")
      .map((d) => /ranked (\d+)/.exec(d.reason)?.[1]);
    expect(positions.sort()).toEqual(["6", "7", "8"]);
  });

  it("records every deletion with id, score and reason", () => {
    const result = rank(scored([["a", 1]]), INTERVIEW);
    expect(result.deletions[0]).toMatchObject({ id: "a", score: 1 });
    expect(result.deletions[0]!.reason.length).toBeGreaterThan(10);
  });

  it("orders survivors by value then id, so equal scores never shuffle", () => {
    const result = rank(scored([["z", 4], ["a", 4], ["m", 5]]), INTERVIEW);
    expect(result.nodes.map((n) => n.id)).toEqual(["m", "a", "z"]);
  });

  it("writes the adjusted score onto the node the renderer will display", () => {
    const result = rank(scored([["a", 4]]), INTERVIEW);
    expect(result.nodes[0]!.interview_value).toBe(4);
  });
});

/* ------------------------------------------------------- overrides */

describe("per-project overrides are data, and the rubric is code", () => {
  const pin = (id: string): Overrides => ({
    overrides: [{ id, pin: true, why: "the maintainer says this always matters" }],
  });

  it("a pin survives the floor", () => {
    const result = rank(scored([["a", 1]]), INTERVIEW, pin("a"));
    expect(result.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(result.deletions).toEqual([]);
  });

  it("a pin survives a full section, and does not displace a higher-scoring node", () => {
    // Pinning adds to the ranking; it does not rewrite it. If a pin consumed a
    // budget slot it would push out a node the rubric scored higher, which is
    // the override editing the rubric by another route.
    const nodes = scored([["a", 5], ["b", 5], ["c", 5], ["d", 5], ["e", 5], ["pinned", 3]]);
    const result = rank(nodes, INTERVIEW, pin("pinned"));
    expect(result.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d", "e", "pinned"]);
    expect(result.deletions).toEqual([]);
  });

  it("a boost raises a score and is clamped to the scale", () => {
    const overrides: Overrides = { overrides: [{ id: "a", boost: 3, why: "under-rated" }] };
    const result = rank(scored([["a", 4]]), INTERVIEW, overrides);
    expect(result.nodes[0]!.interview_value).toBe(5);
  });

  it("a boost can lift a node over the floor", () => {
    const overrides: Overrides = { overrides: [{ id: "a", boost: 2, why: "matters here" }] };
    expect(rank(scored([["a", 2]]), INTERVIEW, overrides).nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("boosts compose, so a type rule and an id rule can both apply", () => {
    const overrides: Overrides = {
      overrides: [
        { type: "mechanism", boost: 1, why: "mechanisms matter on this project" },
        { id: "a", boost: 1, why: "and this one especially" },
      ],
    };
    expect(rank(scored([["a", 2]]), INTERVIEW, overrides).nodes[0]!.interview_value).toBe(4);
  });

  it("a suppression is recorded like any other deletion, never silent", () => {
    const overrides: Overrides = {
      overrides: [{ id: "a", suppress: true, why: "covered better elsewhere" }],
    };
    const result = rank(scored([["a", 5]]), INTERVIEW, overrides);
    expect(result.nodes).toEqual([]);
    expect(result.deletions[0]?.reason).toContain("covered better elsewhere");
  });

  it("an override cannot change the budgets or the rubric version", () => {
    const overrides: Overrides = { overrides: [{ id: "a", boost: 1, why: "x" }] };
    const result = rank(scored([["a", 4]]), INTERVIEW, overrides);
    expect(result.budgets).toEqual(INTERVIEW.budgets);
    expect(result.rubric_version).toBe(INTERVIEW.rubric_version);
  });
});

/* -------------------------------------------------- profile and rubric */

describe("the profile is a named bundle of rubric and budgets", () => {
  it("v1 ships the interview profile with the seam concrete", () => {
    expect(profile("interview")).toBe(INTERVIEW);
    expect(INTERVIEW.budgets.mechanisms).toBe(5);
    expect(INTERVIEW.budgets.interviewer_questions).toBe(10);
    expect(INTERVIEW.budgets.interview_value_floor).toBe(3);
  });

  it("names the profiles it has rather than guessing at one it does not", () => {
    expect(() => profile("onboarding")).toThrow(UnknownProfileError);
    expect(() => profile("onboarding")).toThrow(/v1 ships interview/);
  });

  it("reads the rubric from its versioned asset", () => {
    const text = rubricText(INTERVIEW);
    expect(text).toContain("Interview ranking rubric, v1");
    // The rubric's substance, not just its presence: these are the marks #9
    // derived from the hand-made overview's own rationale.
    expect(text).toContain("rejected alternative");
    expect(text).toContain("Inventory");
  });
});

/* ------------------------------------------------------- the scorer seam */

describe("scores arrive through one seam, whatever produced them", () => {
  const file: ScoreFile = {
    profile: "interview",
    rubric_version: "v1",
    scores: [{ id: "a", score: 4, because: "a decision with a recorded alternative" }],
  };

  it("attaches a score and its justification to each node", () => {
    const [s] = scoresFromFile(file, INTERVIEW)([mechanism("a")]);
    expect(s).toMatchObject({ score: 4, because: "a decision with a recorded alternative" });
  });

  it("refuses to rank a node nobody scored", () => {
    // An unscored node is not a zero. Ranking it as one would delete it while
    // the deletion record claimed it had been weighed.
    expect(() => scoresFromFile(file, INTERVIEW)([mechanism("a"), mechanism("b")])).toThrow(
      MissingScoreError,
    );
  });

  it("refuses to mix two rubric versions in one ranking", () => {
    const stale: ScoreFile = { ...file, rubric_version: "v0" };
    expect(() => scoresFromFile(stale, INTERVIEW)).toThrow(RubricMismatchError);
  });
});
