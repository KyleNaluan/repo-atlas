/**
 * `nodeEvidence` is the single definition of "the evidence a node carries". E1's
 * part-3 hard gate, L1 and L2 all route through it, so a node whose provenance
 * lives in a type-specific slot cannot be evidenced by one check and unevidenced
 * by another. These pin every evidence-bearing location the schema gives a node.
 */
import { describe, expect, it } from "vitest";
import { nodeEvidence } from "../../src/audit/checks/evidence.js";
import type {
  DecisionNode,
  Evidence,
  FlowNode,
  MechanismNode,
} from "../../src/schema/types.js";

const fileEv = (path: string): Evidence => ({ kind: "file", path, sha: "deadbeef" });

const baseDecision: DecisionNode = {
  id: "d-x",
  type: "decision",
  title: "a decision",
  evidence: [],
  confidence: "verified",
  interview_value: 3,
  question: "q",
  decision: "d",
  why: "w",
  status: "decided_and_built",
  rejected: [],
  implemented_by: [],
  soundbite: "s",
};

const baseMechanism: MechanismNode = {
  id: "m-x",
  type: "mechanism",
  title: "a mechanism",
  evidence: [],
  confidence: "verified",
  interview_value: 3,
  what: "what",
  why_interesting: "why",
  enforcement: "convention",
  gotchas: [],
};

const baseFlow: FlowNode = {
  id: "fl-x",
  type: "flow",
  title: "a flow",
  evidence: [],
  confidence: "verified",
  interview_value: 3,
  steps: [{ id: "s1", node: "n1", evidence: fileEv("a.ts") }],
};

describe("nodeEvidence", () => {
  it("counts a decision's implemented_by even when node.evidence is empty", () => {
    const d: DecisionNode = { ...baseDecision, implemented_by: [fileEv("impl.ts")] };
    expect(nodeEvidence(d)).toHaveLength(1);
  });

  it("counts a mechanism's code_excerpt evidence even when node.evidence is empty", () => {
    const m: MechanismNode = {
      ...baseMechanism,
      code_excerpt: { language: "ts", text: "x", evidence: fileEv("m.ts") },
    };
    expect(nodeEvidence(m)).toHaveLength(1);
  });

  it("counts a flow's per-step evidence even when node.evidence is empty", () => {
    expect(nodeEvidence(baseFlow)).toHaveLength(1);
  });

  it("returns nothing for a node with no evidence in any slot", () => {
    expect(nodeEvidence(baseDecision)).toHaveLength(0);
    expect(nodeEvidence(baseMechanism)).toHaveLength(0);
    expect(nodeEvidence({ ...baseFlow, steps: [{ id: "s1", node: "n1" }] })).toHaveLength(0);
  });

  it("sums node.evidence and the type-specific slot together", () => {
    const d: DecisionNode = {
      ...baseDecision,
      evidence: [fileEv("base.ts")],
      implemented_by: [fileEv("impl.ts")],
    };
    expect(nodeEvidence(d)).toHaveLength(2);
  });
});
