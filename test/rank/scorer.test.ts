/**
 * The model scorer, and the pinned measurement that lets CI check it without a
 * credential.
 *
 * The arrangement (the captain's option C): the scorer runs locally through an
 * authenticated CLI, its output is committed as `swe-prep.scores.json`, and CI
 * verifies the deterministic machinery against those real scores. What CI cannot
 * check is whether the model still agrees with the rubric - that is what
 * refreshing the fixture measures, and the loader refuses a set whose rubric has
 * changed since, so the measurement cannot go quietly stale.
 *
 * Everything here runs without credentials: the scorer's own tests inject the
 * ask function, and the ground-truth test reads the pinned file.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { modelScorer, parseScores, rubricDigest, ScorerError } from "../../src/rank/model-scorer.js";
import { INTERVIEW, rubricText } from "../../src/rank/profile.js";
import { rank } from "../../src/rank/rank.js";
import {
  assertScoresFresh,
  scoresFromFile,
  StaleScoresError,
  type ScoreFile,
} from "../../src/rank/scorer.js";
import type { Atlas, AtlasNode, MechanismNode } from "../../src/schema/types.js";

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8")) as T;

const atlas = read<Atlas>("swe-prep.atlas.json");
const pinned = read<ScoreFile>("swe-prep.scores.json");

/** The hand-made overview's five deep dives, in its order: #9's named ground truth. */
const HUMAN_DIVES = [
  "m-grader-runner-seam",
  "m-second-language",
  "m-complexity-honesty",
  "m-content-boundary",
  "m-three-derivations",
];

const mechanism = (id: string): MechanismNode => ({
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
});

const askReturning = (text: string) => async () => text;

/* ------------------------------------------- the pinned measurement */

describe("the pinned score set", () => {
  it("was produced under this profile and this rubric version", () => {
    expect(pinned.profile).toBe(INTERVIEW.name);
    expect(pinned.rubric_version).toBe(INTERVIEW.rubric_version);
  });

  it("is still a measurement of the rubric as it stands", () => {
    // The guard that stops a pinned measurement rotting: a rubric can be reworded
    // without its version moving, and scores made against the old wording would
    // then be reused as though they measured the new one.
    expect(() => assertScoresFresh(pinned, rubricText(INTERVIEW), rubricDigest)).not.toThrow();
    expect(pinned.rubric_sha256).toBe(rubricDigest(rubricText(INTERVIEW)));
  });

  it("scores every node in the reference set, exactly once", () => {
    expect(pinned.scores).toHaveLength(atlas.nodes.length);
    expect(new Set(pinned.scores.map((s) => s.id)).size).toBe(pinned.scores.length);
    for (const node of atlas.nodes) {
      expect(pinned.scores.some((s) => s.id === node.id), node.id).toBe(true);
    }
  });

  it("carries a reason for each score, which is the calibration record", () => {
    for (const s of pinned.scores) expect(s.because, s.id).toBeTruthy();
  });

  it("uses the whole scale rather than clustering", () => {
    // A scorer that returns 4 for everything would satisfy every other assertion
    // here while ranking nothing.
    expect(new Set(pinned.scores.map((s) => s.score)).size).toBeGreaterThanOrEqual(4);
  });
});

/* --------------------------------------------- the ground truth */

describe("the rubric reproduces the human ranking", () => {
  const result = rank(scoresFromFile(pinned, INTERVIEW)(atlas.nodes), INTERVIEW);

  it("selects the same five deep dives the human did, in the same order", () => {
    // This is #9's named ground-truth fixture, checked against real model scores
    // and requiring no credential to run.
    expect(result.nodes.filter((n) => n.type === "mechanism").map((n) => n.id)).toEqual(HUMAN_DIVES);
  });

  it("gives each of those five the same score the human gave it", () => {
    for (const id of HUMAN_DIVES) {
      const node = atlas.nodes.find((n) => n.id === id)!;
      const scored = pinned.scores.find((s) => s.id === id)!;
      expect(scored.score, id).toBe(node.interview_value);
    }
  });

  it("agrees with the human on 13 of 33 nodes overall, and that number is the finding", () => {
    // Recorded rather than asserted-away. #9's ground truth is the ORDERED DEEP
    // DIVES, and those match exactly; across the whole graph the model and the
    // hand-authored scores agree on well under half. That is expected - the
    // fixture's scores are the author's rather than a model's, and are not
    // internally consistent about their own floor (see rank.test.ts) - but it is
    // the kind of number that should move visibly rather than drift unnoticed,
    // so it is pinned here.
    const agree = atlas.nodes.filter(
      (n) => pinned.scores.find((s) => s.id === n.id)!.score === n.interview_value,
    ).length;
    expect(agree).toBe(13);
  });
});

/* ------------------------------------------------- the scorer itself */

describe("the model scorer", () => {
  const nodes: AtlasNode[] = [mechanism("a"), mechanism("b")];
  const good = JSON.stringify({
    scores: [
      { id: "a", score: 5, because: "an enforcement mechanism an interviewer probes" },
      { id: "b", score: 2, because: "inventory" },
    ],
  });

  it("returns a score and a reason per node", async () => {
    const scored = await modelScorer({ ask: askReturning(good) })({
      nodes,
      profile: INTERVIEW,
      rubric: "r",
    });
    expect(scored.map((s) => s.score)).toEqual([5, 2]);
    expect(scored[0]!.because).toContain("interviewer probes");
  });

  it("refuses when a node came back unscored", async () => {
    // An unscored node is not a zero. Defaulting it would delete the node while
    // the deletion record claimed it had been weighed - the same rule the score
    // file loader enforces, applied at the other end of the seam.
    const partial = JSON.stringify({ scores: [{ id: "a", score: 5 }] });
    await expect(
      modelScorer({ ask: askReturning(partial) })({ nodes, profile: INTERVIEW, rubric: "r" }),
    ).rejects.toThrow(ScorerError);
  });

  it("clamps and rounds a score into the scale rather than trusting it", async () => {
    const wild = JSON.stringify({ scores: [{ id: "a", score: 9 }, { id: "b", score: -3 }] });
    const scored = await modelScorer({ ask: askReturning(wild) })({
      nodes,
      profile: INTERVIEW,
      rubric: "r",
    });
    expect(scored.map((s) => s.score)).toEqual([5, 0]);
  });

  it("makes one call for the whole graph, because ranking is comparative", async () => {
    let calls = 0;
    await modelScorer({
      ask: async () => {
        calls += 1;
        return good;
      },
    })({ nodes, profile: INTERVIEW, rubric: "r" });
    expect(calls).toBe(1);
  });

  it("asks nothing of a model when there is nothing to score", async () => {
    let calls = 0;
    const scored = await modelScorer({
      ask: async () => {
        calls += 1;
        return good;
      },
    })({ nodes: [], profile: INTERVIEW, rubric: "r" });
    expect(scored).toEqual([]);
    expect(calls).toBe(0);
  });

  it("shows the model the rubric and the nodes, and nothing else it could act on", async () => {
    let prompt = "";
    await modelScorer({
      ask: async (p) => {
        prompt = p;
        return good;
      },
    })({ nodes, profile: INTERVIEW, rubric: "THE-RUBRIC-TEXT" });
    expect(prompt).toContain("THE-RUBRIC-TEXT");
    expect(prompt).toContain('"id": "a"');
    // Evidence is deliberately withheld: the rubric says evidence is a gate and
    // not a score, so showing citations invites rewarding a node for having many.
    expect(prompt).not.toContain("evidence");
  });
});

describe("reading the scorer's reply", () => {
  it("tolerates a fence or a preamble around the JSON", () => {
    const fenced = 'Here you go:\n```json\n{"scores":[{"id":"a","score":3}]}\n```';
    expect(parseScores(fenced)).toEqual([{ id: "a", score: 3 }]);
  });

  it("says so plainly when there is no JSON at all", () => {
    expect(() => parseScores("I could not score these.")).toThrow(/no JSON object/);
  });

  it("says so plainly when the JSON carries no scores array", () => {
    expect(() => parseScores('{"result":"fine"}')).toThrow(/no "scores" array/);
  });
});

/* --------------------------------------------------- staleness */

describe("a pinned measurement cannot go quietly stale", () => {
  it("refuses scores made under a rubric that has since been edited", () => {
    expect(() => assertScoresFresh(pinned, "a rubric someone rewrote", rubricDigest)).toThrow(
      StaleScoresError,
    );
  });

  it("names both digests and what to do about it", () => {
    try {
      assertScoresFresh(pinned, "edited", rubricDigest);
      throw new Error("expected a failure");
    } catch (e) {
      expect((e as Error).message).toContain(pinned.rubric_sha256!);
      expect((e as Error).message).toContain("repo-atlas score");
    }
  });

  it("accepts a set that predates the digest field rather than failing closed on it", () => {
    // The field is additive; a score file written before it existed is readable,
    // and its version check still applies.
    const { rubric_sha256: _drop, ...older } = pinned;
    expect(() => assertScoresFresh(older as ScoreFile, "anything", rubricDigest)).not.toThrow();
  });
});
