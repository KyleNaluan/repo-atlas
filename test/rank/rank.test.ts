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
import { flowArchetype, flowScoringProjection } from "../../src/rank/flow.js";
import { absentCutsOf } from "../../src/assemble/assemble.js";
import { INTERVIEW, profile, rubricText, UnknownProfileError } from "../../src/rank/profile.js";
import {
  MissingScoreError,
  ProfileMismatchError,
  RubricMismatchError,
  scoresFromFile,
  type ScoreFile,
} from "../../src/rank/scorer.js";
import {
  InvalidOverrideError,
  validateOverrides,
  type Overrides,
  type ProjectOverride,
} from "../../src/rank/overrides.js";
import type { Atlas, AtlasNode, FlowNode, MechanismNode } from "../../src/schema/types.js";

const atlas = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/swe-prep.atlas.json", import.meta.url)), "utf8"),
) as Atlas;

const flowRanking = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/flow-ranking.json", import.meta.url)), "utf8"),
) as { scored: ScoredNode[] };

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

  it("retains both complementary reference Flows", () => {
    expect(result.nodes.filter((node) => node.type === "flow").map((node) => node.id)).toEqual([
      "fl-submission",
      "fl-derivations",
    ]);
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
      .filter((d) => d.section !== "interviewer_questions")
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
    expect(result.deletions.find((d) => d.id === "m-answer-tells")?.section).toBe("mechanisms");
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

  it("cuts an absent Flow independently of its score and any pin", () => {
    const absent: FlowNode = {
      type: "flow",
      id: "fl-quarantined",
      title: "one stale arrow",
      evidence: [],
      confidence: "absent",
      interview_value: 0,
      steps: [],
      links: [],
    };
    const overrides: Overrides = {
      overrides: [{ id: absent.id, pin: true, why: "even a pin cannot admit an unverified chain" }],
    };
    const result = rank([{ node: absent, score: 5 }], INTERVIEW, overrides);
    expect(result.nodes).toEqual([]);
    // Assemble records this in absent_cuts. It must stay distinct from a score
    // floor/budget deletion, rather than appearing in both ledgers.
    expect(result.deletions).toEqual([]);
  });
});

/* ------------------------------------------------------ Flow calibration */

describe("the Flow budget keeps two complementary interview stories", () => {
  const calibrated = () => rank(flowRanking.scored, INTERVIEW);

  it("keeps the request/response and shared-state signal flows", () => {
    expect(calibrated().nodes.map((node) => node.id)).toEqual([
      "fl-request-signal",
      "fl-lineage-signal",
    ]);
  });

  it("does not spend the lineage slot on near-duplicate routes", () => {
    const cuts = calibrated().deletions.filter((deletion) => deletion.section === "flows");
    expect(cuts.map((deletion) => deletion.id)).toEqual([
      "fl-lineage-wrapper",
      "fl-route-wrapper-a",
      "fl-route-wrapper-b",
    ]);
    for (const cut of cuts.filter((deletion) => deletion.id.startsWith("fl-route"))) {
      expect(cut).toMatchObject({ kind: "budget", section: "flows", unit: "node", score: 4 });
      expect(cut.reason).toContain("flows capped at 2");
      expect(cut.reason).toContain("request/response slot capped at 1");
    }
    expect(cuts.find((deletion) => deletion.id === "fl-lineage-wrapper")?.reason).toContain(
      "shared-state/data-lineage slot capped at 1",
    );
    expect(
      cuts
        .filter((deletion) => deletion.id.startsWith("fl-route"))
        .map((cut) => /ranked (\d+)/.exec(cut.reason)?.[1]),
    ).toEqual(["3", "4"]);
  });

  it("applies the floor before either archetype slot", () => {
    expect(calibrated().deletions.find((deletion) => deletion.id === "fl-under-floor")).toMatchObject({
      score: 2,
      kind: "floor",
      unit: "node",
    });
  });

  it("degrades honestly to one Flow instead of filling both slots with routes", () => {
    const routes = flowRanking.scored.filter((entry) =>
      ["fl-request-signal", "fl-route-wrapper-a", "fl-route-wrapper-b"].includes(entry.node.id),
    );
    const result = rank(routes, INTERVIEW);
    expect(result.nodes.map((node) => node.id)).toEqual(["fl-request-signal"]);
    const flowCuts = result.deletions.filter((deletion) => deletion.section === "flows");
    expect(flowCuts).toHaveLength(2);
    // Only the request/response slot ever bound - one Flow was kept, so the flows
    // section (cap 2) was never full. The recorded reason must name the archetype
    // slot alone and must not claim the section cap bound.
    for (const cut of flowCuts) {
      expect(cut.reason).toContain("request/response slot capped at 1");
      expect(cut.reason).not.toContain("flows capped at");
    }
  });

  it("degrades honestly to zero when no verified Flow clears the floor", () => {
    const weakOrAbsent = flowRanking.scored.filter((entry) =>
      ["fl-under-floor", "fl-absent"].includes(entry.node.id),
    );
    expect(rank(weakOrAbsent, INTERVIEW).nodes).toEqual([]);
  });

  it("a section-only cap does not claim an unused archetype slot is full", () => {
    // Lower the section budget so it binds while a different archetype's slot is
    // still empty. The kept request/response flow fills only its own slot, so the
    // cut lineage flow is bound by the section cap alone - its reason must not
    // claim the lineage slot is capped, since that record is #8's G2 evidence.
    const oneFlow = { ...INTERVIEW, budgets: { ...INTERVIEW.budgets, flows: 1 } };
    const pair = flowRanking.scored.filter((entry) =>
      ["fl-request-signal", "fl-lineage-signal"].includes(entry.node.id),
    );
    const result = rank(pair, oneFlow);
    expect(result.nodes.map((node) => node.id)).toEqual(["fl-request-signal"]);
    const cut = result.deletions.find((deletion) => deletion.id === "fl-lineage-signal")!;
    expect(cut).toMatchObject({ kind: "budget", section: "flows" });
    expect(cut.reason).toContain("flows capped at 1");
    expect(cut.reason).not.toContain("slot capped");
  });

  it("keeps rank deletions distinct from the gate's absent-cut record", () => {
    const result = calibrated();
    expect(result.deletions.some((deletion) => deletion.id === "fl-under-floor")).toBe(true);
    expect(result.deletions.some((deletion) => deletion.id === "fl-absent")).toBe(false);
    const absent = flowRanking.scored.find((entry) => entry.node.id === "fl-absent")!.node;
    expect(
      absentCutsOf([
        {
          probe_id: "flow-fixture",
          node: absent,
          verdict: "unresolved",
          finding: "one link could not be independently resolved",
        },
      ]),
    ).toEqual([
      {
        id: "fl-absent",
        candidate_type: "flow",
        reason: "one link could not be independently resolved",
        note: "no admissible evidence at this SHA (flow-fixture)",
      },
    ]);
  });
});

/* ------------------------------------ archetype classification precedence */

describe("a request signal wins the archetype even alongside a read fan-out", () => {
  // A modern links-based Flow whose request entry also fans out over two read
  // links. The request signal takes precedence, so it belongs to the
  // request/response slot and never competes for the lineage slot #39 reserves
  // for Flows whose story is the lineage itself.
  const mixedTopology = (id: string, score: number): { score: number; node: FlowNode } => ({
    score,
    node: {
      type: "flow",
      id,
      title: "Route reads two repositories",
      evidence: [],
      confidence: "verified",
      interview_value: 0,
      steps: [
        { id: "route", node: "POST /submissions", kind: "request" },
        { id: "learned", node: "Learned state", kind: "response" },
        { id: "due", node: "Due state", kind: "response" },
      ],
      links: [
        { id: "route-learned", from: "route", to: "learned", relation: "read", evidence: [] },
        { id: "route-due", from: "route", to: "due", relation: "read", evidence: [] },
      ],
    },
  });

  it("classifies the mixed-topology Flow as request/response", () => {
    expect(flowArchetype(mixedTopology("fl-mixed", 5).node)).toBe("request_response");
  });

  it("does not read a process-boundary crossing as a request signal (#35, PR 8)", () => {
    // Until PR 8 the request signal was the `transport` RELATION, which was the
    // same thing while HTTP was the only boundary a Flow crossed. A systemd unit
    // launching a program crosses one too, and a timer firing is not a request -
    // so the signal is the `request` KIND the producer stamps on an HTTP arrow
    // and deliberately withholds from a launch arrow. Reading the relation would
    // hand a cron job the request/response slot #39 reserves for a verified
    // request signal.
    const launched: FlowNode = {
      type: "flow",
      id: "fl-unit",
      title: "cue.service starts a program",
      evidence: [],
      confidence: "verified",
      interview_value: 0,
      steps: [
        { id: "unit", node: "cue.service" },
        { id: "main", node: "Tool" },
        { id: "store", node: "CueRepository" },
      ],
      links: [
        { id: "unit-main", from: "unit", to: "main", relation: "transport", evidence: [] },
        { id: "main-store", from: "main", to: "store", relation: "write", evidence: [] },
      ],
    };
    expect(flowArchetype(launched)).toBe("unknown");
    // An HTTP transport arrow is unchanged: the producer stamps it `request`.
    expect(
      flowArchetype({
        ...launched,
        links: [{ ...launched.links![0]!, kind: "request" }, launched.links![1]!],
      }),
    ).toBe("request_response");
  });

  it("still reads the same fan-out as lineage once the request entry is removed", () => {
    const flow = mixedTopology("fl-mixed", 5).node;
    const lineageOnly: FlowNode = {
      ...flow,
      steps: flow.steps.map((step) => (step.id === "route" ? { ...step, kind: undefined } : step)),
    };
    expect(flowArchetype(lineageOnly)).toBe("shared_state_lineage");
  });

  it("takes the request/response slot without evicting a genuine lineage story", () => {
    const lineageSignal = flowRanking.scored.find((entry) => entry.node.id === "fl-lineage-signal")!;
    const routeWrapper = flowRanking.scored.find((entry) => entry.node.id === "fl-route-wrapper-a")!;
    const result = rank([mixedTopology("fl-mixed", 5), lineageSignal, routeWrapper], INTERVIEW);
    expect(result.nodes.map((node) => node.id)).toEqual(["fl-mixed", "fl-lineage-signal"]);
    const cut = result.deletions.find((deletion) => deletion.id === "fl-route-wrapper-a")!;
    expect(cut.reason).toContain("request/response slot capped at 1");
  });
});

/* ------------------------------ an unknown-entry Flow asserts no entry kind */

describe("a Flow with no entry signal is unknown, and claims no preferred slot", () => {
  // A modern links-based raw call graph: a single `call` arrow, no request step
  // and no read fan-out. flowArchetype's fallthrough used to label it
  // request/response, which then stamped entry_kind "request" onto the scorer
  // projection - an entry the topology never showed. It is `unknown` instead.
  const rawCallGraph = (id: string, score: number): { score: number; node: FlowNode } => ({
    score,
    node: {
      type: "flow",
      id,
      title: "Web layer calls service layer",
      evidence: [],
      confidence: "verified",
      interview_value: 0,
      steps: [
        { id: "web", node: "WebController" },
        { id: "svc", node: "ServiceBean" },
      ],
      links: [{ id: "web-svc", from: "web", to: "svc", relation: "call", evidence: [] }],
    },
  });

  it("classifies a modern raw call graph as unknown, not a default request/response", () => {
    expect(flowArchetype(rawCallGraph("fl-raw", 5).node)).toBe("unknown");
  });

  it("still reads a legacy calls_next Flow with no request signal as request/response", () => {
    // The legacy bridge keeps the reference submission-walkthrough shape: a
    // calls_next Flow with no request step is request/response, not unknown.
    const legacy = flowRanking.scored.find((entry) => entry.node.id === "fl-request-signal")!.node;
    const legacyBridge: FlowNode = {
      type: "flow",
      id: "fl-legacy-bridge",
      title: legacy.title,
      evidence: [],
      confidence: "verified",
      interview_value: 0,
      steps: [
        { id: "a", node: "A", calls_next: ["b"] },
        { id: "b", node: "B" },
      ],
    };
    expect(flowArchetype(legacyBridge)).toBe("request_response");
  });

  it("projects entry_kind unknown for the scorer rather than asserting request", () => {
    const projection = flowScoringProjection(rawCallGraph("fl-raw", 5).node);
    expect(projection.archetype).toBe("unknown");
    expect(projection.entry_kind).toBe("unknown");
    // And it says WHY, rather than leaving a bare "unknown" to be interpreted.
    // #39's archetype set is closed at two, so an entry family with no slot in it
    // is a different fact from a topology with no entry at all (#35, PR 8).
    expect(projection.unclassified_reason).toContain("no request signal");
  });

  it("fills a Flow slot the preferred archetypes leave genuinely open", () => {
    // Only one preferred Flow (a request/response route) qualifies, so one of the
    // two Flow slots is genuinely open. The unknown-entry Flow may take it.
    const route = flowRanking.scored.find((entry) => entry.node.id === "fl-route-wrapper-a")!;
    const result = rank([route, rawCallGraph("fl-raw", 3)], INTERVIEW);
    expect(result.nodes.map((node) => node.id).sort()).toEqual(["fl-raw", "fl-route-wrapper-a"]);
    expect(result.deletions.filter((deletion) => deletion.section === "flows")).toEqual([]);
  });

  it("never displaces a qualifying preferred Flow, even at a higher score", () => {
    // The two preferred slots are both claimed by a request/response and a
    // shared-state/data-lineage Flow. A higher-scoring unknown Flow must not evict
    // either - it competes for neither preferred slot - so it is cut for want of
    // fallback capacity while both preferred stories survive.
    const request = flowRanking.scored.find((entry) => entry.node.id === "fl-request-signal")!;
    const lineage = flowRanking.scored.find((entry) => entry.node.id === "fl-lineage-signal")!;
    const result = rank([rawCallGraph("fl-raw", 5), request, lineage], INTERVIEW);
    expect(result.nodes.map((node) => node.id)).toEqual(["fl-request-signal", "fl-lineage-signal"]);
    const cut = result.deletions.find((deletion) => deletion.id === "fl-raw")!;
    expect(cut).toMatchObject({ kind: "budget", section: "flows", unit: "node", score: 5 });
    expect(cut.reason).toContain("no open Flow slot remains for an unknown-entry Flow");
    expect(cut.reason).toContain("claimed 2 of 2 flow slots");
    expect(cut.reason).toContain("leaving 0 for unknown-entry Flows");
    // The record must not blame a preferred slot or the section cap it never
    // contended for - only the exhausted fallback capacity that actually bound.
    expect(cut.reason).not.toContain("slot capped");
    expect(cut.reason).not.toContain("flows capped at");
  });
});

/* ------------------------------------ the interviewer_questions budget */

describe("the interviewer_questions budget cuts questions, not nodes", () => {
  const numbered = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `q${String(i + 1).padStart(2, "0")}`);

  it("cuts the eleventh question, keeps ten, and records the cut in its section", () => {
    const node = mechanism("m", { interviewer_questions: numbered(11) });
    const result = rank([{ node, score: 5 }], INTERVIEW);
    const kept = result.nodes[0]!.interviewer_questions!;
    expect(kept).toHaveLength(10);
    expect(kept).not.toContain("q11");
    const cut = result.deletions.filter((d) => d.section === "interviewer_questions");
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({ kind: "budget", section: "interviewer_questions", score: 5 });
    expect(cut[0]!.id).toContain("m#interviewer_questions");
    // A trimmed question is a deletion but not a deleted node: the discriminator
    // is what keeps the record from counting it as one.
    expect(cut[0]!.unit).toBe("question");
    // The node that declared it lives; only the question was trimmed.
    expect(result.nodes.map((n) => n.id)).toEqual(["m"]);
  });

  it("marks a node cut as unit node and a question cut as unit question", () => {
    // One node falls below the floor; one question falls over the budget. The
    // record must be able to tell the two deletions apart.
    const weak = mechanism("weak", {});
    const busy = mechanism("busy", { interviewer_questions: numbered(11) });
    const result = rank([{ node: weak, score: 1 }, { node: busy, score: 5 }], INTERVIEW);
    const nodeCut = result.deletions.find((d) => d.id === "weak");
    const questionCut = result.deletions.find((d) => d.section === "interviewer_questions");
    expect(nodeCut!.unit).toBe("node");
    expect(questionCut!.unit).toBe("question");
  });

  it("folds a question declared by two nodes into one budget slot", () => {
    // Ten distinct questions, one of them shared: eleven declared entries but ten
    // rows, so the budget of 10 is met exactly and nothing is cut. Were the shared
    // question counted twice it would be eleven slots and one cut.
    const shared = "how is it enforced?";
    const a = mechanism("a", { interviewer_questions: [shared, ...numbered(9)] });
    const b = mechanism("b", { interviewer_questions: [shared] });
    const result = rank([{ node: a, score: 5 }, { node: b, score: 4 }], INTERVIEW);
    expect(result.deletions.filter((d) => d.section === "interviewer_questions")).toEqual([]);
    expect(result.nodes.find((n) => n.id === "a")!.interviewer_questions).toContain(shared);
    expect(result.nodes.find((n) => n.id === "b")!.interviewer_questions).toContain(shared);
  });

  it("records a shared cut question once and trims it from every declaring node", () => {
    // Ten high-value questions fill the budget; an eleventh, declared by two
    // lower-value nodes, falls over the line. It is one folded row, so it is one
    // deletion - if it were one per declaring node the renderer's "N questions
    // cut" count would overstate - and it is trimmed from both nodes.
    const shared = "shared, and cut";
    const top = mechanism("top", { interviewer_questions: numbered(10) });
    const b = mechanism("b", { interviewer_questions: [shared] });
    const c = mechanism("c", { interviewer_questions: [shared] });
    const result = rank(
      [{ node: top, score: 5 }, { node: b, score: 3 }, { node: c, score: 3 }],
      INTERVIEW,
    );
    const cut = result.deletions.filter((d) => d.section === "interviewer_questions");
    expect(cut).toHaveLength(1);
    expect(result.nodes.find((n) => n.id === "b")!.interviewer_questions).toEqual([]);
    expect(result.nodes.find((n) => n.id === "c")!.interviewer_questions).toEqual([]);
  });

  it("trims only the cut questions and leaves the surviving node otherwise unchanged", () => {
    const node = mechanism("m", { interviewer_questions: numbered(12), why_interesting: "intact" });
    const result = rank([{ node, score: 5 }], INTERVIEW);
    const returned = result.nodes[0]!;
    expect(returned.interviewer_questions).toEqual(numbered(10));
    const { interviewer_questions: _rq, interview_value: _rv, ...restReturned } = returned;
    const { interviewer_questions: _nq, interview_value: _nv, ...restOriginal } = node;
    expect(restReturned).toEqual(restOriginal);
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

/* ---------------------------------------------- override validation */

describe("overrides are validated at load, so a malformed one never passes silently", () => {
  it("rejects an override that selects nothing, naming the offending entry", () => {
    // An override with no selector matches nothing and does nothing: a human who
    // believes they pinned something gets an artifact that quietly disagrees.
    const bad: Overrides = { overrides: [{ boost: 1, why: "nothing selected" } as ProjectOverride] };
    expect(() => validateOverrides(bad)).toThrow(InvalidOverrideError);
    expect(() => validateOverrides(bad)).toThrow(/nothing selected/);
    expect(() => validateOverrides(bad)).toThrow(/no selector/);
  });

  it("rejects an override that selects on more than one axis", () => {
    const bad: Overrides = {
      overrides: [{ id: "a", type: "mechanism", boost: 1, why: "two selectors" } as ProjectOverride],
    };
    expect(() => validateOverrides(bad)).toThrow(InvalidOverrideError);
    expect(() => validateOverrides(bad)).toThrow(/2 selectors/);
  });

  it("rejects an override that carries no action, naming the offending entry", () => {
    // A selector with no pin/boost/suppress matches a node and then does nothing
    // to it: the same silent no-op the selector rule closes, one field over.
    const bad: Overrides = { overrides: [{ id: "a", why: "no action given" } as ProjectOverride] };
    expect(() => validateOverrides(bad)).toThrow(InvalidOverrideError);
    expect(() => validateOverrides(bad)).toThrow(/no action given/);
    expect(() => validateOverrides(bad)).toThrow(/no action/);
  });

  it("rejects an override that carries more than one action", () => {
    const bad: Overrides = {
      overrides: [{ id: "a", pin: true, suppress: true, why: "two actions" } as ProjectOverride],
    };
    expect(() => validateOverrides(bad)).toThrow(InvalidOverrideError);
    expect(() => validateOverrides(bad)).toThrow(/2 actions/);
  });

  it("accepts a well-formed override and still applies it", () => {
    const good: Overrides = { overrides: [{ id: "a", boost: 2, why: "under-rated" }] };
    expect(validateOverrides(good)).toBe(good);
    expect(rank(scored([["a", 2]]), INTERVIEW, good).nodes.map((n) => n.id)).toEqual(["a"]);
  });
});

/* -------------------------------------------------- profile and rubric */

describe("the profile is a named bundle of rubric and budgets", () => {
  it("v1 ships the interview profile with the seam concrete", () => {
    expect(profile("interview")).toBe(INTERVIEW);
    expect(INTERVIEW.budgets.mechanisms).toBe(5);
    expect(INTERVIEW.budgets.flows).toBe(2);
    expect(INTERVIEW.budgets.interviewer_questions).toBe(10);
    expect(INTERVIEW.budgets.interview_value_floor).toBe(3);
    expect(INTERVIEW.flow_archetype_budgets).toEqual({
      request_response: 1,
      shared_state_lineage: 1,
    });
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
    const [s] = scoresFromFile(file, INTERVIEW, rubricText(INTERVIEW))([mechanism("a")]);
    expect(s).toMatchObject({ score: 4, because: "a decision with a recorded alternative" });
  });

  it("refuses to rank a node nobody scored", () => {
    // An unscored node is not a zero. Ranking it as one would delete it while
    // the deletion record claimed it had been weighed.
    expect(() =>
      scoresFromFile(file, INTERVIEW, rubricText(INTERVIEW))([mechanism("a"), mechanism("b")]),
    ).toThrow(MissingScoreError);
  });

  it("refuses to mix two rubric versions in one ranking", () => {
    const stale: ScoreFile = { ...file, rubric_version: "v0" };
    expect(() => scoresFromFile(stale, INTERVIEW, rubricText(INTERVIEW))).toThrow(RubricMismatchError);
  });

  it("refuses scores produced under a different profile", () => {
    // A profile bundles a rubric with its budgets. The field is a guarantee, so
    // it is enforced like rubric_version rather than left as unchecked metadata.
    const other: ScoreFile = { ...file, profile: "onboarding" };
    expect(() => scoresFromFile(other, INTERVIEW, rubricText(INTERVIEW))).toThrow(ProfileMismatchError);
  });
});
