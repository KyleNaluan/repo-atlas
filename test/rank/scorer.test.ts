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
import { modelScorer, parseScores, ScorerError } from "../../src/rank/model-scorer.js";
import { INTERVIEW, rubricText } from "../../src/rank/profile.js";
import { rank } from "../../src/rank/rank.js";
import {
  assertScoresFresh,
  rubricDigest,
  scoresFromFile,
  StaleScoresError,
  type ScoreFile,
} from "../../src/rank/scorer.js";
import type { Atlas, AtlasNode, FlowNode, MechanismNode } from "../../src/schema/types.js";

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
    expect(() => assertScoresFresh(pinned, rubricText(INTERVIEW))).not.toThrow();
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
  const result = rank(scoresFromFile(pinned, INTERVIEW, rubricText(INTERVIEW))(atlas.nodes), INTERVIEW);

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

  it("scores the reference request and lineage Flows as high-signal", () => {
    expect(pinned.scores.find((score) => score.id === "fl-submission")?.score).toBe(5);
    expect(pinned.scores.find((score) => score.id === "fl-derivations")?.score).toBe(4);
  });

  it("agrees with the human on 16 of 33 nodes overall, and that number is the finding", () => {
    // Recorded rather than asserted-away. #9's ground truth is the ORDERED DEEP
    // DIVES, and those match exactly; across the whole graph the model and the
    // hand-authored scores agree on well under half. That is expected - the
    // fixture's scores are the author's rather than a model's, and are not
    // internally consistent about their own floor (see rank.test.ts) - but it is
    // the kind of number that should move visibly rather than drift unnoticed,
    // so it is pinned here.
    //
    // It moved from 13 to 14 when the rubric gained two bands: one saying value
    // is comparative against THIS subject's record, and one distinguishing an
    // orientation figure from inventory. Every stat tile scored higher than
    // before - still below what the human gave them, so none of them is what
    // moved the count - and the ordered deep dives, which are #9's actual ground
    // truth, did not move at all. A rubric edit that changed the ground truth
    // would be a different matter and would fail the test above. It moved again
    // from 14 to 16 when Flow criteria were added; the two reference Flows kept
    // their human scores and the ordered deep dives remained unchanged.
    const agree = atlas.nodes.filter(
      (n) => pinned.scores.find((s) => s.id === n.id)!.score === n.interview_value,
    ).length;
    expect(agree).toBe(16);
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

  it("offers the whole graph again when a reply comes back short", async () => {
    // A model asked for 32 scores in one reply sometimes returns 31, and this
    // happened on a real pipeline run. The refusal below is right - an unscored
    // node is not a zero - but failing a whole run on a transient slip is not.
    // The retry offers the graph WHOLE rather than asking for the stragglers:
    // #9 makes scoring comparative, and three leftovers scored in isolation
    // would not be ranked against the set.
    const partial = JSON.stringify({ scores: [{ id: "a", score: 5 }] });
    let calls = 0;
    const retries: string[][] = [];
    const scored = await modelScorer({
      ask: async () => (++calls === 1 ? partial : good),
      onRetry: (_attempt, missing) => retries.push(missing),
    })({ nodes, profile: INTERVIEW, rubric: "r" });
    expect(calls).toBe(2);
    expect(retries).toEqual([["b"]]);
    expect(scored.map((s) => s.score)).toEqual([5, 2]);
  });

  it("refuses when a node is still unscored after every attempt", async () => {
    // An unscored node is not a zero. Defaulting it would delete the node while
    // the deletion record claimed it had been weighed - the same rule the score
    // file loader enforces, applied at the other end of the seam. The retry above
    // makes a slip survivable; it does not make a persistent omission acceptable.
    const partial = JSON.stringify({ scores: [{ id: "a", score: 5 }] });
    let calls = 0;
    await expect(
      modelScorer({
        ask: async () => {
          calls += 1;
          return partial;
        },
      })({ nodes, profile: INTERVIEW, rubric: "r" }),
    ).rejects.toThrow(ScorerError);
    expect(calls).toBe(3);
  });

  it("refuses when a node came back with a non-numeric score", async () => {
    // A present-but-non-numeric score is not a zero. Rounding it yields NaN, which
    // survives the missing-check and is then cut at the floor, deleting the node
    // while the record says it was weighed - the same failure as an absent score.
    const bad = JSON.stringify({ scores: [{ id: "a", score: "high" }, { id: "b", score: 2 }] });
    await expect(
      modelScorer({ ask: askReturning(bad) })({ nodes, profile: INTERVIEW, rubric: "r" }),
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

  it("shows Flow topology and seams without showing its evidence", async () => {
    const flow: FlowNode = {
      type: "flow",
      id: "fl-lineage",
      title: "One record drives two derivations",
      caption: "Two independently computed read models.",
      confidence: "verified",
      interview_value: 0,
      evidence: [{ kind: "file", path: "secret/node-evidence.ts", sha: "a".repeat(40) }],
      steps: [
        {
          id: "record",
          node: "Attempt record",
          detail: "durable state",
          evidence: { kind: "file", path: "secret/step-evidence.ts", sha: "a".repeat(40) },
        },
        {
          id: "learned",
          node: "Learned state",
          kind: "response",
          evidence: { kind: "command", cmd: "locate learned", output_excerpt: "LearnedCriterion" },
        },
        {
          id: "due",
          node: "Due state",
          kind: "response",
          evidence: { kind: "command", cmd: "locate due", output_excerpt: "Sm2Scheduler" },
        },
      ],
      links: [
        {
          id: "learned-link",
          from: "record",
          to: "learned",
          relation: "read",
          label: "passed rows",
          evidence: [{ kind: "file", path: "secret/link-evidence.ts", sha: "a".repeat(40) }],
        },
        {
          id: "due-link",
          from: "record",
          to: "due",
          relation: "read",
          label: "terminal reps",
          evidence: [{ kind: "command", cmd: "trace due read", output_excerpt: "terminal reps" }],
        },
      ],
    };
    let prompt = "";
    await modelScorer({
      ask: async (value) => {
        prompt = value;
        return JSON.stringify({ scores: [{ id: flow.id, score: 5, because: "lineage seam" }] });
      },
    })({ nodes: [flow], profile: INTERVIEW, rubric: "r" });

    expect(prompt).toContain('"archetype": "shared_state_lineage"');
    expect(prompt).toContain('"entry_kind": "durable_shared_state"');
    expect(prompt).toContain('"title": "Attempt record"');
    expect(prompt).toContain('"relation": "read"');
    expect(prompt).toContain('"label": "passed rows"');
    expect(prompt).toContain('"roots"');
    expect(prompt).toContain('"terminals"');
    expect(prompt).toContain('"architectural_boundaries"');
    expect(prompt).not.toContain("secret/");
    expect(prompt).not.toContain('"evidence"');
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
    expect(() => assertScoresFresh(pinned, "a rubric someone rewrote")).toThrow(StaleScoresError);
  });

  it("names both digests and what to do about it", () => {
    try {
      assertScoresFresh(pinned, "edited");
      throw new Error("expected a failure");
    } catch (e) {
      expect((e as Error).message).toContain(pinned.rubric_sha256!);
      expect((e as Error).message).toContain("repo-atlas score");
    }
  });

  it("refuses a stale set through the loader itself, not only the standalone check", () => {
    // The guarantee is the loader's, so no caller can rank under a stale set by
    // forgetting to run the check first.
    expect(() => scoresFromFile(pinned, INTERVIEW, "a rubric someone rewrote")).toThrow(
      StaleScoresError,
    );
  });

  it("accepts a set that predates the digest field rather than failing closed on it", () => {
    // The field is additive; a score file written before it existed is readable,
    // and its version check still applies.
    const { rubric_sha256: _drop, ...older } = pinned;
    expect(() => assertScoresFresh(older as ScoreFile, "anything")).not.toThrow();
  });
});
