/**
 * #22's parity criterion, measured against the hand-made overview.
 *
 * #1 accepts v1 when the engine "regenerates an overview of swe-prep that stands
 * comparison with the maintainer's hand-made overview". This test measures that
 * comparison rather than asserting it: the numbers below are the finding, and
 * where the engine falls short of the reference the shortfall is pinned here in
 * the open rather than left to be discovered by reading the artifact.
 *
 * It runs off the committed pipeline output, produced by a real end-to-end run at
 * the pinned SHA. What CI checks is that the deterministic machinery still turns
 * the committed inputs into this artifact; what a refresh measures is whether the
 * engine still finds what it found.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Atlas, DecisionNode, EdgeNode } from "../../src/schema/types.js";

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8")) as T;

/** The #7 prototype's recast of the maintainer's hand-made overview. */
const reference = read<Atlas>("swe-prep.atlas.json");
/** What the pipeline produced, end to end, at the same SHA. */
const produced = read<Atlas>("swe-prep.pipeline.atlas.json");

const countByType = (a: Atlas) =>
  a.nodes.reduce<Record<string, number>>((m, n) => ({ ...m, [n.type]: (m[n.type] ?? 0) + 1 }), {});

describe("the engine and the hand-made overview describe the same subject", () => {
  it("pins the same commit", () => {
    expect(produced.subject.sha).toBe(reference.subject.sha);
    expect(produced.subject.repo).toBe("swe-prep");
  });

  it("produces a document that satisfies the same contract", () => {
    expect(produced.schema_version).toBe(reference.schema_version);
    expect(produced.profile).toBe(reference.profile);
  });
});

describe("what the engine reproduces", () => {
  it("recovers the decision trail from the record", () => {
    // The half that had no producer at all when #22 opened. The reference carries
    // six decisions; the engine reads eight resolution comments into decisions and
    // sends the ninth to the gate, which overturns it.
    const decisions = produced.nodes.filter((n): n is DecisionNode => n.type === "decision");
    expect(decisions.length).toBeGreaterThanOrEqual(reference.nodes.filter((n) => n.type === "decision").length);
    for (const d of decisions) {
      expect(d.evidence.some((e) => e.kind === "issue"), d.id).toBe(true);
    }
  });

  it("selects as many deep dives as the reference does", () => {
    const dives = (a: Atlas) => a.nodes.filter((n) => n.type === "mechanism").length;
    expect(dives(produced)).toBe(dives(reference));
  });

  it("settles which decisions were actually built, against the tree", () => {
    // Not taken from the record: #7 point 7's bidirectional gate established each
    // of these by finding the implementation, and cites where.
    const built = produced.nodes.filter(
      (n): n is DecisionNode => n.type === "decision" && n.status === "decided_and_built",
    );
    expect(built.length).toBeGreaterThan(0);
    for (const d of built) expect(d.implemented_by.length, d.id).toBeGreaterThan(0);
  });

  it("finds a divergence the hand-made overview does not contain", () => {
    // The engine's own contribution, and the thing a summariser cannot produce:
    // the record specifies a schema the tree does not carry at this SHA.
    const divergences = produced.nodes.filter(
      (n): n is EdgeNode => n.type === "edge" && n.kind === "divergence",
    );
    expect(divergences.length).toBeGreaterThan(0);
    for (const d of divergences) {
      // It states a fact about the tree, so it cites what was actually read.
      expect(d.evidence.some((e) => e.kind === "command" || e.kind === "file"), d.id).toBe(true);
    }
  });

  it("carries orientation figures measured rather than asserted", () => {
    const facts = produced.nodes.filter((n) => n.type === "fact");
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f.evidence.some((e) => e.kind === "command"), f.id).toBe(true);
    }
  });
});

describe("where the engine falls short, and by how much", () => {
  it("renders seven of the reference's node types minus flows", () => {
    // THE PINNED SHORTFALL. Nothing in the pipeline mints a Flow node: #7's
    // section 04, "One submission end to end", has no producer, so the section
    // reports absent. That is honest - the renderer says so rather than omitting
    // it - but it is not parity, and this test records the gap rather than
    // letting a green suite imply there isn't one.
    expect(countByType(produced)["flow"]).toBeUndefined();
    expect(countByType(reference)["flow"]).toBe(2);
    expect(produced.record.section_presence["flows"]).toBe("absent");
  });

  it("renders no boundaries, because the only probe that finds them finds test-file noise", () => {
    // Also pinned rather than hidden. Three boundary candidates were produced and
    // all three were cut at the floor, correctly: they are constructor-parameter
    // asymmetries in test classes, and the reference's four are architectural
    // seams. That is a probe-coverage gap, not a scoring one - rescoring noise
    // does not turn it into a seam.
    expect(countByType(produced)["boundary"]).toBeUndefined();
    expect(countByType(reference)["boundary"]).toBe(4);
  });

  it("produces about half the reference's nodes, and the number is the finding", () => {
    // Recorded so it moves visibly. 18 against 33: the decisions, deep dives,
    // orientation figures and edges are there; the flows and boundaries are not.
    expect(produced.nodes).toHaveLength(18);
    expect(reference.nodes).toHaveLength(33);
  });
});

describe("the artifact the run emitted was audited and shipped", () => {
  it("passed with warnings, which is a real ship state", () => {
    // #8's classification read forward: a gate failure means the artifact makes an
    // untrue claim, a warning means it is worse than it should be. The model pass
    // raised warnings and the artifact still ships - by design, and the audit
    // record mirrored into the document says so.
    expect(produced.record.audit.status).toBe("passed_with_warnings");
    expect(produced.record.audit.failure_kind).toBeUndefined();
  });

  it("reports all twenty checks, every one by name", () => {
    // The failure this stage exists to prevent is a twenty-check contract that
    // quietly reports on nine.
    expect(produced.record.audit.checks).toHaveLength(20);
    for (const c of produced.record.audit.checks!) {
      expect(c.id, JSON.stringify(c)).toBeTruthy();
      if (c.outcome === "not_applicable" || c.outcome === "not_run") {
        expect(c.reason, `${c.id} gives no reason`).toBeTruthy();
      }
    }
  });

  it("passed fourteen of the fifteen hard gates, with the fifteenth inapplicable", () => {
    const gates = produced.record.audit.checks!.filter((c) => c.class === "gate");
    expect(gates).toHaveLength(15);
    expect(gates.filter((c) => c.outcome === "passed")).toHaveLength(14);
    // P1: the subject declares a private source that was not readable here, so no
    // leak check was performed. #8 insisted this middle state never be silent.
    const p1 = gates.find((c) => c.id === "P1")!;
    expect(p1.outcome).toBe("not_applicable");
    expect(p1.reason).toContain("private");
    expect(gates.some((c) => c.outcome === "failed")).toBe(false);
  });
});
