/**
 * The pure folds.
 *
 * #7 puts the "generated, never re-derived" guarantee here, and these are the
 * easiest part of the whole engine to test, so they get tested hardest. The two
 * cases that matter most are the bound-answer rule (a fold that composes an
 * answer produces fluent wrong rows) and the absence of any budget (a fold that
 * slices becomes a second authority over what survives).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { qaIndex, ranked, sourceIndex, deletionsFor } from "../../src/render/projections.js";
import type { Atlas, AtlasNode, DecisionNode, MechanismNode } from "../../src/schema/types.js";

const atlas = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/swe-prep.atlas.json", import.meta.url)), "utf8"),
) as Atlas;

const decision = (over: Partial<DecisionNode>): DecisionNode => ({
  type: "decision",
  id: "d1",
  title: "A decision",
  evidence: [],
  confidence: "attested",
  interview_value: 4,
  question: "q",
  decision: "d",
  why: "w",
  rejected: [],
  rejected_absent_from_record: true,
  status: "decided",
  implemented_by: [],
  soundbite: "the decision's own answer",
  ...over,
});

const mechanism = (over: Partial<MechanismNode>): MechanismNode => ({
  type: "mechanism",
  id: "m1",
  title: "A mechanism",
  evidence: [],
  confidence: "verified",
  interview_value: 3,
  what: "what",
  why_interesting: "the mechanism's own answer",
  enforcement: "type-level",
  gotchas: [],
  ...over,
});

describe("the interviewer-questions fold", () => {
  it("groups two nodes declaring one question into a single row", () => {
    const rows = qaIndex([
      decision({ interviewer_questions: ["How is the seam enforced?"] }),
      mechanism({ interviewer_questions: ["How is the seam enforced?"] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.nodes.map((n) => n.id)).toEqual(["d1", "m1"]);
  });

  it("uses the highest-value declaring node's own short answer when none is bound", () => {
    const rows = qaIndex([
      decision({ interview_value: 5, interviewer_questions: ["Why?"] }),
      mechanism({ interview_value: 2, interviewer_questions: ["Why?"] }),
    ]);
    expect(rows[0]!.answer).toBe("the decision's own answer");
    expect(rows[0]!.answerProv).toEqual({ owner: "d1", field: "soundbite" });
  });

  it("prefers an explicitly bound answer over any node's own short answer", () => {
    // #7 section 4.2: a Decision's soundbite answers that decision's question,
    // not every question the decision touches. Folding it in anyway is how the
    // prototype produced confidently mismatched rows.
    const rows = qaIndex([
      decision({
        interview_value: 5,
        interviewer_questions: [
          { question: "What runs untrusted code?", answer: "A swappable runner behind a registry." },
        ],
      }),
    ]);
    expect(rows[0]!.answer).toBe("A swappable runner behind a registry.");
    expect(rows[0]!.answerProv.field).toMatch(/interviewer_questions\[0\]\.answer/);
  });

  it("stamps the question with the node that declared it", () => {
    const rows = qaIndex([mechanism({ interviewer_questions: ["Where?"] })]);
    expect(rows[0]!.questionProv).toEqual({
      owner: "m1",
      field: "interviewer_questions[0].question",
    });
  });

  it("applies no budget - deletion belongs to the rank stage", () => {
    const nodes = Array.from({ length: 25 }, (_, i) =>
      mechanism({ id: `m${i}`, interviewer_questions: [`Question ${i}?`] }),
    );
    expect(qaIndex(nodes)).toHaveLength(25);
  });

  it("orders by the highest declaring value, then by question, so runs are stable", () => {
    const a = qaIndex([
      mechanism({ id: "b", interview_value: 1, interviewer_questions: ["zzz?"] }),
      mechanism({ id: "a", interview_value: 5, interviewer_questions: ["aaa?"] }),
    ]);
    expect(a.map((r) => r.question)).toEqual(["aaa?", "zzz?"]);
  });
});

describe("the source index fold", () => {
  it("dedupes a file cited by several nodes into one row that counts them", () => {
    const grouped = sourceIndex(atlas.nodes, [], atlas.subject);
    const files = grouped.get("file") ?? [];
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files.map((f) => f.key)).size).toBe(files.length);
    expect(files[0]!.citedBy.length).toBeGreaterThanOrEqual(files[files.length - 1]!.citedBy.length);
  });

  it("keeps two comments on one issue distinct, and says which is which", () => {
    const issues = sourceIndex(atlas.nodes, [], atlas.subject).get("issue") ?? [];
    const two = issues.filter((s) => s.key.startsWith("issue:2:"));
    expect(two.length).toBe(2);
    expect(new Set(two.map((s) => s.label)).size).toBe(2);
    for (const s of two) expect(s.label).toMatch(/comment \d+/);
  });

  it("leaves a single-citation issue's label alone", () => {
    const issues = sourceIndex(atlas.nodes, [], atlas.subject).get("issue") ?? [];
    const solo = issues.filter((s) => s.key.startsWith("issue:12:"));
    expect(solo).toHaveLength(1);
    expect(solo[0]!.label).not.toMatch(/comment/);
  });
});

describe("ranking and the deletion record", () => {
  it("orders by value then id, so identical scores do not shuffle between runs", () => {
    const nodes: AtlasNode[] = [
      mechanism({ id: "b", interview_value: 4 }),
      mechanism({ id: "a", interview_value: 4 }),
      mechanism({ id: "c", interview_value: 5 }),
    ];
    expect(ranked(nodes).map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("reads section budget cuts structurally, not by matching the reason prose", () => {
    expect(deletionsFor(atlas, "mechanisms").map((d) => d.id)).toEqual(["m-answer-tells"]);
    expect(deletionsFor(atlas, "interviewer_questions")).toEqual([]);
  });
});
