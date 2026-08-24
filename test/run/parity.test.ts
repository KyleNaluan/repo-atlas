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
 *
 * Two things are measured here, and they are not the same thing. The artifact's
 * node count is what SHIPPED, and it moves only when a credentialed run is
 * repeated. What the engine can ESTABLISH is a property of the probes and the
 * gate, it moves whenever those do, and since #22's probe-coverage work it is
 * measured node by node against the reference in its own fixture rather than
 * inferred from the count. A coverage report that named only its wins would
 * communicate its own limits by silence, which is the one thing #6 forbids
 * everywhere else, so the fixture's second list - every reference node still
 * unminted, with the standing decision that forecloses it - is the half that
 * matters.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Atlas, DecisionNode, EdgeNode } from "../../src/schema/types.js";
import { PROBES } from "../../src/probes/registry.js";

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8")) as T;

/** The #7 prototype's recast of the maintainer's hand-made overview. */
const reference = read<Atlas>("swe-prep.atlas.json");
/** What the pipeline produced, end to end, at the same SHA. */
const produced = read<Atlas>("swe-prep.pipeline.atlas.json");

interface FlowProducerAdapter {
  probe_id: string;
  status: string;
  reason?: string;
  entries?: number;
  verified_by_the_gate?: {
    id: string;
    title: string;
    steps: number;
    links: number;
    narrative_depth: number;
    archetype: string;
    transport_links?: number;
  }[];
  cut_by_reason?: Record<string, number>;
}

/** What #35's producer yields on the same subject, measured against a real clone. */
const measured = read<{
  subject_sha: string;
  reference_narrative: {
    route: string;
    outcome: string;
    archetype: string;
    steps: number;
    links: number;
    transport_links: number;
    narrative_depth: number;
    components: string[];
  };
  lineage_narrative: {
    record: string;
    outcome: string;
    archetype: string;
    steps: number;
    links: number;
    narrative_depth: number;
    branches: { to: string; label: string; cited_spans: number }[];
    derivations: string[];
    closed_negative_claims: number;
    caption: string;
  };
  typescript_client: {
    modules_scanned: number;
    fetch_clients_closed_by_the_subject: string[];
    call_sites_resolved: number;
    call_sites_cut: number;
    routes_with_a_verified_caller: number;
  };
  adapters: FlowProducerAdapter[];
  entry_adapters: {
    spring_scheduled_annotations: number;
    spring_listener_annotations: number;
    systemd_unit_files: string[];
    units_stitched_to_a_subject_main: number;
    exec_start_read: string;
    reference_flows_unchanged: boolean;
  };
}>("swe-prep.flow-producer.json");

/** A reference node a named producer now reaches. */
interface CoveredRow {
  reference_node: string;
  by: string;
  candidate?: string;
  note?: string;
}

/**
 * A reference node nothing here mints, and why.
 *
 * `reason` and `would_need` are required in the shape for the same reason the
 * audit's `not_applicable` carries a mandatory reason: an unreached node with no
 * stated reason is absence communicated by silence (#6).
 */
interface UnmintedRow {
  reference_node: string;
  area: string;
  reason: string;
  would_need: string;
}

/**
 * How far extraction reaches on this subject, measured node by node against the
 * reference (#22). Like the Flow producer's yield, it needs a swe-prep clone and
 * so is pinned rather than computed here; unlike a count, it is a LIST, because
 * "27 against 33" says nothing about which six or why.
 */
const coverage = read<{
  subject_sha: string;
  gate: {
    candidates: number;
    confirmed: number;
    overturned: number;
    unresolved: number;
    confirmed_before_these_probes: number;
    confirmed_after: number;
  };
  reference: { nodes: number; by_type: Record<string, number>; covered: number; unminted: number };
  covered: CoveredRow[];
  unminted: UnmintedRow[];
  beyond_the_reference: { candidates: { id: string; title: string }[] };
  committed_artifact: {
    nodes_now: number;
    new_gate_confirmed_candidates_scored_and_ranked_in: number;
    model_deviation: string;
    recommended_follow_up: string;
  };
}>("swe-prep.probe-coverage.json");

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

describe("the two reference archetypes, both produced and both verified", () => {
  // THE TWO-FLOW PARITY PROPERTIES (report section 2). Until PR 7 this described
  // a GAP: the reference carries two Flows of two different kinds and the engine
  // produced neither, then one. It now describes what the producer yields, as
  // named properties rather than as a count - a count of two is satisfied by two
  // endpoint tours, which is exactly what the design says parity is not.
  const verified = (probe: string) =>
    measured.adapters.find((a) => a.probe_id === probe)!.verified_by_the_gate!;

  it("produces one Flow of each archetype, from adapters that ask different questions", () => {
    expect(countByType(reference)["flow"]).toBe(2);
    const request = verified("flow-java-spring-http");
    const lineage = verified("flow-java-shared-state");
    expect(request.every((f) => f.archetype === "request_response")).toBe(true);
    expect(lineage.every((f) => f.archetype === "shared_state_lineage")).toBe(true);
    // #39's budget of two, after the floor, now has both slots to fill from real
    // extraction rather than one archetype competing with itself.
    expect(measured.reference_narrative.archetype).toBe("request_response");
    expect(measured.lineage_narrative.archetype).toBe("shared_state_lineage");
    expect(produced.record.budgets["flows"]).toBe(2);
  });

  it("recovers the shared-state fan-out over the record the submission flow writes", () => {
    const lineage = measured.lineage_narrative;
    expect(lineage.outcome).toBe("verified");
    expect(lineage.record).toBe("SubmissionRepository");
    // AT LEAST THREE BRANCHES, each with its own evidence (report 5.5 point 4).
    expect(lineage.branches.length).toBeGreaterThanOrEqual(3);
    for (const branch of lineage.branches) expect(branch.cited_spans).toBeGreaterThanOrEqual(2);
    expect(new Set(lineage.branches.map((b) => b.to)).size).toBe(lineage.branches.length);
    // Labels are the tree's own words: a code identifier, and the literal SQL
    // predicate the read writes. The reference artifact's insight - the competence
    // signal is filtered in SQL rather than in a caller - is recovered, not narrated.
    expect(lineage.branches.map((b) => b.label).join("\n")).toContain("s.outcome = 'PASSED'");
    expect(lineage.branches.map((b) => b.label).join("\n")).toContain("s.outcome = 'FAILED'");
    // And each branch ends at a named pure derivation, as the hand-made one does.
    for (const derivation of ["LearnedCriterion", "ConfusionPairs", "ChallengeQuality"]) {
      expect(lineage.derivations, derivation).toContain(derivation);
    }
  });

  it("prints the independence claim only because a closed check established it", () => {
    // The hand-made caption says "None of the three reads either of the others".
    // That sentence is admissible only with a closed reachability proof per
    // ordered pair, and it is omitted entirely - never softened - without one.
    expect(measured.lineage_narrative.closed_negative_claims).toBeGreaterThanOrEqual(6);
    expect(measured.lineage_narrative.caption).toContain("No derivation drawn here reaches another");
    const lineage = verified("flow-java-shared-state");
    // The other record's story is the control: it draws three branches too, and
    // one of them CAN reach another's read model, so it prints no such sentence.
    expect(lineage.length).toBe(2);
  });

  it("reads as a strip: the fan-out sits beside the path, not along it", () => {
    expect(measured.lineage_narrative.narrative_depth).toBeLessThanOrEqual(8);
    expect(measured.lineage_narrative.steps).toBeGreaterThan(
      measured.lineage_narrative.narrative_depth,
    );
  });
});

describe("where the engine falls short, and by how much", () => {
  it("has re-run the end-to-end pipeline with the producer and a credentialed score", () => {
    // THE SHORTFALL THIS RECORDED, closed. The producer emitted both archetypes
    // and the gate verified both (above) since PR 7 (#35), but the committed
    // end-to-end artifact predated every Flow phase and still reported section
    // 04 absent because closing it needed a credentialed model score run, which
    // CI does not hold (README's own statement of the gap, before this run). A
    // real `repo-atlas run` against the pinned subject, with real write and
    // score calls, now sits behind this fixture, and both flows the two-Flow-
    // parity block above measures survive into the committed artifact.
    expect(countByType(produced)["flow"]).toBe(2);
    expect(produced.record.section_presence["flows"]).toBe("present");
  });

  it("records what the Flow producer now yields on this subject, rather than predicting it", () => {
    // PR 4 built the producer, so the shortfall above has a measurement behind it
    // for the first time. The measurement cannot run in CI - it needs a swe-prep
    // checkout, which this suite deliberately does not have - so it is pinned the
    // way the scores are: produced by a real run, committed, and regenerated by
    // the command the fixture itself carries.
    expect(measured.subject_sha).toBe(reference.subject.sha);
    const http = measured.adapters.find((a) => a.probe_id === "flow-java-spring-http")!;
    const cli = measured.adapters.find((a) => a.probe_id === "flow-java-cli")!;
    const client = measured.adapters.find((a) => a.probe_id === "flow-typescript-http-client")!;
    expect(http.status).toBe("ran");
    expect(cli.status).toBe("ran");
    // Three adapters, each reporting its own state. PR 6 adds the TypeScript one
    // and it ran and emitted nothing - which here means every client call it
    // resolved was stitched into a route's own Flow, not that it found nothing.
    expect(client.status).toBe("ran");
    expect(client.entries).toBe(0);

    // Every route the subject declares was inventoried, and every candidate ends
    // in exactly one of the two states this producer may report.
    const accounted = (a: FlowProducerAdapter): number =>
      a.verified_by_the_gate!.length + Object.values(a.cut_by_reason!).reduce((n, m) => n + m, 0);
    expect(accounted(http)).toBe(http.entries);
    expect(accounted(cli)).toBe(cli.entries);
    expect(http.entries).toBe(23);
    expect(cli.entries).toBe(2);

    // PR 5 closes the dispatch seam, and the measurement moves: twenty of the
    // twenty-three routes now survive independent re-resolution, and NOT ONE
    // candidate is cut at a dispatch any more. What still cuts is a different
    // limit, named as itself.
    expect(http.verified_by_the_gate!.length).toBe(20);
    expect(http.cut_by_reason!["unresolved_dispatch"]).toBeUndefined();
    expect(Object.keys(http.cut_by_reason!)).toEqual(["unresolved_receiver_type"]);

    // THE ONE THAT MATTERS. The submission walkthrough #35 exists to recover is
    // verified through the gate, not forced: every one of its fifty-three arrows
    // was independently re-resolved against the pinned tree, and a single
    // unresolvable arrow anywhere the entry reaches would have quarantined the
    // whole thing.
    const submission = http.verified_by_the_gate!.find((f) => f.title.includes("submissions"));
    expect(submission, "the submission narrative must survive the gate").toBeDefined();
    expect(measured.reference_narrative.outcome).toBe("verified");
    expect(measured.reference_narrative.links).toBe(submission!.links);
    expect(measured.reference_narrative.steps).toBe(submission!.steps);

    // PR 6: FULL UI-TO-RESPONSE PARITY. The hand-made overview starts in the
    // editor, and until a real caller existed the route could only be claimed in
    // a caption. Both frontend modules that POST this route are boxes of the
    // story now, and each arrow across the process boundary was independently
    // re-resolved at both ends.
    expect(submission!.title).toContain("browser to terminal");
    expect(submission!.transport_links).toBe(2);
    expect(measured.reference_narrative.transport_links).toBe(2);
    expect(measured.reference_narrative.components.slice(0, 2)).toEqual([
      "Practice.tsx",
      "Warmup.tsx",
    ]);
    // Every route that survives the gate has a caller in this subject; the three
    // that do not survive are cut in the BACKEND trace, not for want of one.
    expect(measured.typescript_client.routes_with_a_verified_caller).toBe(
      http.verified_by_the_gate!.length,
    );
    // The narrow adapter read the whole frontend and cut nothing: `apiFetch` is
    // the one function this subject's own wiring closes as a fetch client, and
    // all 28 call sites through it resolve to an exact verb and path.
    expect(measured.typescript_client.fetch_clients_closed_by_the_subject).toEqual([
      "frontend/src/api.ts#apiFetch",
    ]);
    expect(measured.typescript_client.call_sites_resolved).toBe(28);
    expect(measured.typescript_client.call_sites_cut).toBe(0);

    // THE READABILITY CRITERION (report 5.4), measured rather than declared. The
    // main narrative is what a reader follows - one execution - and it is eight
    // architectural landmarks deep. The other seventeen boxes are the branches
    // drawn BESIDE that path: not one of them was hidden to reach the number,
    // which is the failure the criterion names first.
    expect(measured.reference_narrative.narrative_depth).toBe(8);
    expect(submission!.narrative_depth).toBeLessThanOrEqual(8);
    expect(submission!.steps).toBeGreaterThan(submission!.narrative_depth);

    // And it is the SAME story the hand-made overview tells. The reference's own
    // `fl-submission` names these components; the engine reached each of them by
    // resolving calls rather than by being told.
    for (const component of [
      "AttemptService",
      "FileExerciseCatalog",
      "GraderRegistry",
      "TestCaseGrader",
      "JavaLanguageAdapter",
      "LocalJavaRunner",
      "Comparison",
      "Verdict",
      "SubmissionRepository",
      "AttemptRepository",
      "SolutionCommitService",
      "RunResponse",
    ]) {
      expect(measured.reference_narrative.components, component).toContain(component);
    }
    // Branch honesty: the non-coding graders are drawn as their own boxes rather
    // than spliced into the coding path, so nothing claims they run a runner.
    expect(measured.reference_narrative.components).toContain("AnswerKeyGrader");
    expect(measured.reference_narrative.components).toContain("SelfCheckGrader");
  });

  it("grows breadth without moving the first subject's yield (#35, PR 8)", () => {
    // PR 8 adds three entry families that have no caller in the tree - a clock, a
    // broker and a systemd unit - and the point of measuring it here is that
    // breadth must not be paid for out of the two reference archetypes. It is
    // not: every number the two describe blocks above assert is unchanged, and
    // the three new adapters contribute exactly one candidate, an absent cut that
    // names itself.
    const scheduled = measured.adapters.find((a) => a.probe_id === "flow-java-spring-scheduled")!;
    const message = measured.adapters.find((a) => a.probe_id === "flow-java-spring-message")!;
    const systemd = measured.adapters.find((a) => a.probe_id === "flow-systemd-unit")!;

    // RAN AND FOUND NOTHING, which is not the same finding as "did not apply".
    // Spring is here, so both Spring adapters applied; this subject declares no
    // clock trigger and no listener. Report 3.1 measured the same two zeros.
    for (const adapter of [scheduled, message]) {
      expect(adapter.status).toBe("ran");
      expect(adapter.entries).toBe(0);
      expect(adapter.verified_by_the_gate).toHaveLength(0);
    }
    expect(measured.entry_adapters.spring_scheduled_annotations).toBe(0);
    expect(measured.entry_adapters.spring_listener_annotations).toBe(0);

    // The systemd surface report 3.1 flagged - "filenames alone do not establish
    // a business Flow" - resolves to exactly that. One .service, one .timer, and
    // an ExecStart this reader will not follow: an install-time placeholder in
    // front of a wrapper script. It is CUT AND NAMED, never drawn and never
    // silent, which is the whole reason the adapter is registered.
    expect(systemd.status).toBe("ran");
    expect(systemd.entries).toBe(1);
    expect(systemd.verified_by_the_gate).toHaveLength(0);
    expect(systemd.cut_by_reason).toEqual({ unresolved_exec_target: 1 });
    expect(measured.entry_adapters.systemd_unit_files).toHaveLength(2);
    expect(measured.entry_adapters.units_stitched_to_a_subject_main).toBe(0);
    expect(measured.entry_adapters.exec_start_read).toContain("daily-cue.sh");
    expect(measured.entry_adapters.reference_flows_unchanged).toBe(true);

    // And the CLI adapter's own yield did not move under the new stitch: two
    // mains inventoried, one verified, one with no terminal to reach.
    const cli = measured.adapters.find((a) => a.probe_id === "flow-java-cli")!;
    expect(cli.entries).toBe(2);
    expect(cli.verified_by_the_gate).toHaveLength(1);
    expect(cli.cut_by_reason).toEqual({ no_terminal_reached: 1 });
  });

  it("renders the boundaries the new probes find, now that a credentialed run has scored them", () => {
    // THE SHORTFALL THIS USED TO RECORD is closed. It used to read "the only
    // probe that finds them finds test-file noise": three boundary candidates
    // were produced, all three cut at the floor, and all three constructor-
    // parameter asymmetries in test classes, while the reference's four are
    // architectural seams. That WAS a probe-coverage gap rather than a scoring
    // one, and the coverage block above is where it was measured: three of the
    // reference's four boundaries have producers that read shapes no earlier
    // probe could carry, and the fourth is already in this artifact as a
    // mechanism.
    //
    // A fresh credentialed `repo-atlas run` (per #50, #51) scored and ranked
    // those candidates in: five boundaries now render - the reference's three
    // plus two "beyond the reference" partitions the probes found independently
    // (see `beyond_the_reference` above) - all of them new, since the pre-#50
    // artifact carried none.
    expect(countByType(produced)["boundary"]).toBe(5);
    expect(countByType(reference)["boundary"]).toBe(4);
    expect(coverage.committed_artifact.recommended_follow_up).toContain("repo-atlas run");
  });

  it("closes most of the gap to the reference's node count, and the remainder is the finding", () => {
    // Recorded so it moves visibly. 27 against 33, now that the boundaries above
    // are in: the decisions, deep dives, orientation figures, edges, flows and
    // boundaries are all there. What remains unminted is the residual this
    // fixture's "unminted" list accounts for by name, not a mystery shortfall.
    //
    // The count is a property of the SHIPPED ARTIFACT, and it moved because this
    // branch repeated the credentialed run: the eight boundary/coverage-gap
    // candidates these probes confirmed are scored and ranked into the document,
    // not merely confirmed at the gate. Twenty-two of the reference's
    // thirty-three nodes have a named producer and the other eleven have a
    // stated reason - that split is unchanged by this run, because it is a
    // property of the probes and the gate, not of what got ranked in.
    expect(produced.nodes).toHaveLength(27);
    expect(reference.nodes).toHaveLength(33);
    expect(coverage.reference.covered).toBe(22);
    expect(coverage.reference.unminted).toBe(11);
    expect(coverage.committed_artifact.new_gate_confirmed_candidates_scored_and_ranked_in).toBe(8);
  });
});

describe("how far extraction reaches, measured node by node against the reference", () => {
  // #22's coverage question, pinned the way the Flow producer's yield and the
  // scores are: measured by a real probe-and-gate run against a swe-prep clone at
  // the pinned SHA, committed, and regenerated by the command the fixture carries.
  // CI cannot run it - this suite deliberately has no swe-prep checkout - so what
  // CI checks here is that the measurement still accounts for every reference node
  // and still names a reason for each one it does not reach.
  //
  // The point of the fixture is the SECOND list. #6 refuses to communicate absence
  // by silence, and a coverage report that named only its wins would be doing
  // exactly that at the level of the engine's own capability.
  const covered = coverage.covered;
  const unminted = coverage.unminted;

  it("accounts for every node the reference carries, exactly once", () => {
    expect(coverage.subject_sha).toBe(reference.subject.sha);
    const accounted = [...covered, ...unminted].map((e) => e.reference_node).sort();
    const referenced = reference.nodes.map((n) => n.id).sort();
    expect(accounted).toEqual(referenced);
    expect(accounted).toHaveLength(reference.nodes.length);
    expect(coverage.reference.by_type).toEqual(countByType(reference));
    expect(coverage.reference.covered).toBe(covered.length);
    expect(coverage.reference.unminted).toBe(unminted.length);
  });

  it("names a probe for everything it claims, and a reason for everything it does not", () => {
    // The two halves are held to the same standard, which is the whole reason the
    // second list exists. A "covered" row without a producer is an aspiration
    // written as a result; an "unminted" row without a reason is silence.
    for (const row of covered) expect(row.by, row.reference_node).toBeTruthy();
    for (const row of unminted) {
      expect(row.reason, row.reference_node).toBeTruthy();
      expect(row.would_need, row.reference_node).toBeTruthy();
      expect(row.area, row.reference_node).toBeTruthy();
    }
  });

  it("closes the boundary section the shortfall named, with the fourth accounted for", () => {
    // "That is a probe-coverage gap, not a scoring one", said the block below
    // before this. Three of the reference's four boundaries now have producers,
    // each reading a shape no existing probe could carry: a relationship between
    // two sealed hierarchies, a partition of an implementation set, a difference
    // between two enums.
    const boundaries = reference.nodes.filter((n) => n.type === "boundary").map((n) => n.id);
    expect(boundaries).toHaveLength(4);
    const producers = new Map(covered.map((r) => [r.reference_node, r.by]));
    expect(producers.get("b-response-grading")).toBe("orthogonal-hierarchies");
    expect(producers.get("b-grader-runner")).toBe("partitioned-implementations");
    expect(producers.get("b-verdict-selfrating")).toBe("superset-enum");
    for (const probe of ["orthogonal-hierarchies", "partitioned-implementations", "superset-enum"]) {
      expect(PROBES.map((p) => p.id), probe).toContain(probe);
    }
    // The fourth is NOT a hole: the finding is already in the artifact under
    // another node type, and the reason says so rather than counting it as a win.
    const fourth = unminted.find((r) => r.reference_node === "b-engine-content")!;
    expect(fourth.reason).toContain("ci-policy-guards");
    expect(fourth.reason).toContain("mechanism");
  });

  it("recovers the coverage gap a suite's own summary line hides", () => {
    // The hand-made overview's sharpest edge about its own testing: five tests
    // that abort themselves rather than fail, inside a suite that still reports
    // success. Reached from the tree - a JUnit assumption call in an annotated
    // method, plus the import that makes it JUnit's - rather than from a run.
    const row = covered.find((r) => r.reference_node === "e-content-never-in-ci")!;
    expect(row.by).toBe("self-disabling-tests");
    expect(PROBES.map((p) => p.id)).toContain("self-disabling-tests");
  });

  it("states what the residual gap is made of, by area rather than as a number", () => {
    // Eleven reference nodes are unminted and they are not eleven instances of one
    // problem. Grouping them is what makes the residual an engineering fact: two
    // need a stage that runs the build, six need the write stage's reading of a
    // decision record, one is already present under another node type, one is a
    // tracker instance that closed, and one is a deliberate refusal to widen a
    // vocabulary until it matched.
    const byArea = unminted.reduce<Record<string, number>>(
      (m, r) => ({ ...m, [r.area]: (m[r.area] ?? 0) + 1 }),
      {},
    );
    expect(byArea).toEqual({ facts: 2, boundaries: 1, edges: 8 });
    // Every reason is grounded in a standing decision rather than in "not done
    // yet": each names the rule that forecloses it or the stage that owns it.
    for (const row of unminted) {
      expect(
        /#\d+|write stage|ci-policy-guards|tuned-config-properties|measured-scale|decided-but-unbuilt/.test(
          row.reason,
        ),
        `${row.reference_node} must say what forecloses it`,
      ).toBe(true);
    }
  });

  it("has not paid for breadth out of what already worked", () => {
    // The same discipline PR 8 applied to the Flow adapters: new producers must
    // not move the numbers the earlier ones established. Every candidate the gate
    // confirmed before these probes still confirms, and the nine unresolved are
    // the same nine Flow quarantines PR 8 measured - not a regression dressed up
    // as coverage.
    expect(coverage.gate.confirmed_after - coverage.gate.confirmed_before_these_probes).toBe(
      coverage.beyond_the_reference.candidates.length +
        covered.filter((r) => /orthogonal-hierarchies|partitioned-implementations|superset-enum|self-disabling-tests/.test(r.by)).length +
        covered.filter((r) => r.candidate === "f-scale-test-lines" || r.candidate === "f-scale-migrations").length,
    );
    expect(coverage.gate.overturned).toBe(0);
    expect(coverage.gate.unresolved).toBe(9);
    expect(coverage.gate.candidates).toBe(
      coverage.gate.confirmed + coverage.gate.unresolved + coverage.gate.overturned,
    );
  });

  it("says how the committed artifact came to carry it, and what deviated getting there", () => {
    // The honest half of this task's result. Eight new gate-confirmed candidates
    // existed and none of them was in the shipped document, because rank refuses
    // to run on a node nobody scored - until this run refreshed the scores.
    // Recorded here rather than left for a reader to discover from a node count
    // that moved without explanation, including the one deviation this run took:
    // claude-fable-5 was unusable, so claude-sonnet-5 scored and wrote it instead.
    expect(coverage.committed_artifact.nodes_now).toBe(produced.nodes.length);
    expect(coverage.committed_artifact.new_gate_confirmed_candidates_scored_and_ranked_in).toBe(
      coverage.gate.confirmed_after - coverage.gate.confirmed_before_these_probes,
    );
    expect(coverage.committed_artifact.model_deviation).toContain("claude-fable-5");
    expect(coverage.committed_artifact.model_deviation).toContain("claude-sonnet-5");
    expect(coverage.committed_artifact.recommended_follow_up).toContain("repo-atlas run");
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

/**
 * The second language, measured on its own two subjects (#52, D5).
 *
 * The Java producer is measured against one pinned subject with a regenerating
 * command; #52's D5 pins BOTH Python subjects because they test different halves -
 * futures-trading-bot exercises the tracer, and data-science-agent exercises the
 * declared-pipeline adapter, which nothing else reaches. The cost is one extra
 * fixture; the alternative is that half the adapter has no parity test.
 *
 * ftb is private, so its fixture is self-contained committed JSON and regenerating
 * it requires access - the same constraint the Java fixture already carries, since
 * that one needs a swe-prep clone.
 *
 * The number that matters most in these fixtures is `overturned_by_the_gate`. The
 * producer and the gate are independent derivations - a parse tree against a blob
 * reread - and the rule the whole adapter is built on is that they must fail closed
 * on the SAME line. Every disagreement is a place where a real chain would return as
 * a confusing quarantine, so the fixture counts them rather than trusting them to be
 * zero.
 */
interface PythonAdapter {
  probe_id: string;
  status: string;
  reason?: string;
  candidates?: number;
  verified_by_the_gate?: {
    title: string;
    steps: number;
    links: number;
    narrative_depth: number;
    archetype: string;
    components: string[];
  }[];
  cut_by_reason?: Record<string, number>;
  overturned_by_the_gate?: string[];
}

interface PythonFixture {
  subject_sha: string;
  entry_inventory: Record<string, number>;
  survival: { candidates: number; verified_by_the_gate: number; overturned_by_the_gate: number };
  adapters: PythonAdapter[];
}

const dsa = read<PythonFixture>("data-science-agent.flow-producer.json");
const ftb = read<PythonFixture>("futures-trading-bot.flow-producer.json");

const adapterIn = (fixture: PythonFixture, id: string): PythonAdapter =>
  fixture.adapters.find((adapter) => adapter.probe_id === id)!;

const flowTitled = (fixture: PythonFixture, id: string, title: string) =>
  adapterIn(fixture, id).verified_by_the_gate!.find((flow) => flow.title === title)!;

describe("the Python adapter, measured on the two subjects #52 pins", () => {
  it("is pinned to the SHAs the design record was read at", () => {
    expect(dsa.subject_sha).toBe("6986cd419cd7ddaffb93888ff874c57f8967b9b3");
    expect(ftb.subject_sha).toBe("3e4d369dede2892afda0a60cdfd00b09964eb64d");
  });

  it("inventories the entry families the design record counted", () => {
    // These are the report's own section 3.1 counts, re-derived by the shipped
    // detectors rather than by the scout's throwaway scripts. Every family agrees.
    expect(dsa.entry_inventory).toMatchObject({
      fastapi_routes_with_a_literal_path: 9,
      program_entries: 1,
      declared_langgraph_topologies: 1,
      framework_callbacks_refused: 0,
    });
    expect(ftb.entry_inventory).toMatchObject({
      fastapi_routes_with_a_literal_path: 14,
      program_entries: 17,
      declared_langgraph_topologies: 0,
      framework_callbacks_refused: 6,
    });
  });

  it("has the producer and the gate failing closed on the same lines", () => {
    // The rule the whole adapter rests on, as a number. Not one candidate the
    // producer proposed as a complete chain was overturned by the gate's own
    // independent reread.
    expect(dsa.survival.overturned_by_the_gate).toBe(0);
    expect(ftb.survival.overturned_by_the_gate).toBe(0);
    for (const fixture of [dsa, ftb]) {
      for (const adapter of fixture.adapters) {
        expect(adapter.overturned_by_the_gate ?? []).toEqual([]);
      }
    }
  });

  it("records the survival rate rather than predicting it (risk R1)", () => {
    // PR 4's first Java measurement was 3 of 23 routes. The report deliberately
    // declined to guess Python's, so this is the measured value: 15 of the 23
    // routes across both subjects verify, plus three program entries and the one
    // declared topology. dsa's `app` is declared in a `create_app()` factory, so
    // its routes verify only once the host reader recognises a factory-scoped app
    // (both producer and gate do); ftb's `prop_eval_backtest.main` joins on the
    // direct-import process-launch fix.
    const routes = (fixture: PythonFixture) =>
      adapterIn(fixture, "flow-python-fastapi-http").verified_by_the_gate!.length;
    expect(routes(dsa)).toBe(7);
    expect(routes(ftb)).toBe(8);
    expect(dsa.survival.verified_by_the_gate).toBe(8);
    expect(ftb.survival.verified_by_the_gate).toBe(11);
  });

  it("verifies the flagship route the design record hand-walked", () => {
    // Report section 5.1's first flagship, worked out step by step against the
    // source before any code existed: eight boxes, narrative depth five,
    // request/response. The producer reaches exactly that.
    const flow = flowTitled(ftb, "flow-python-fastapi-http", "GET /decision-logs/{}, entry to terminal");
    expect(flow.steps).toBe(8);
    expect(flow.links).toBe(7);
    expect(flow.narrative_depth).toBe(5);
    expect(flow.archetype).toBe("request_response");
    // The components the report predicted, in the story's own order.
    expect(flow.components).toEqual([
      "GET /decision-logs/{}",
      "decision_logs",
      "reader",
      "DecisionRecord",
      "SignalRecord",
      "GateRecord",
      "OrderEventRecord",
      "OperatorEventRecord",
    ]);
  });

  it("verifies the flagship topology the design record hand-walked", () => {
    // Report section 5.1's second flagship, and the reason the pipeline adapter is
    // not optional: EVERY dsa execution path funnels through a value the subject
    // annotates `-> Any`, so the CLI story and every route that reaches it are
    // quarantined. The topology is declared in literals ten lines apart, and it is
    // #39-`unknown` because a declared topology carries no request signal.
    const flow = flowTitled(
      dsa,
      "flow-python-langgraph-pipeline",
      "build_graph, declared pipeline entry to terminal",
    );
    expect(flow.steps).toBe(5);
    expect(flow.links).toBe(4);
    expect(flow.archetype).toBe("unknown");
    expect(flow.components).toEqual([
      "ingest",
      "sweep",
      "investigate",
      "report_assembly",
      "deliver",
    ]);
  });

  it("names every refusal by kind, so the record counts failures rather than sentences", () => {
    // #6 forbids communicating absence by silence, and the kind token is what lets
    // the record say WHICH failure this was. Every cut on both subjects carries one.
    const kinds = new Set<string>();
    for (const fixture of [dsa, ftb]) {
      for (const adapter of fixture.adapters) {
        for (const kind of Object.keys(adapter.cut_by_reason ?? {})) kinds.add(kind);
      }
    }
    expect([...kinds].sort()).toEqual([
      "chained_call",
      "framework_callback_unestablished",
      "no_arrow_drawn",
      "no_terminal_reached",
      "unresolved_dispatch",
      "unresolved_receiver_type",
    ]);
    // D1's refusal is emitted, once per declared callback, rather than left as an
    // absence: six on ftb, which is the count the report measured.
    expect(
      adapterIn(ftb, "flow-python-console-entry").cut_by_reason!["framework_callback_unestablished"],
    ).toBe(6);
  });

  it("says by name that the second subject runs no LangGraph, rather than finding nothing", () => {
    const adapter = adapterIn(ftb, "flow-python-langgraph-pipeline");
    expect(adapter.status).toBe("not_applicable");
    expect(adapter.reason).toContain("imports langgraph");
  });
});
