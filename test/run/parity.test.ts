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
  it("has not re-run the end-to-end pipeline since the producer existed", () => {
    // THE REMAINING SHORTFALL, and it is now a different one. The producer emits
    // both archetypes and the gate verifies both (above), but the COMMITTED
    // end-to-end artifact predates every Flow phase and still reports section 04
    // absent. Refreshing it needs a credentialed model score run, which CI does
    // not hold and which no Flow phase has taken on; this records that rather than
    // letting a green suite imply the artifact moved.
    expect(countByType(produced)["flow"]).toBeUndefined();
    expect(produced.record.section_presence["flows"]).toBe("absent");
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

  it("renders no boundaries, because the only probe that finds them finds test-file noise", () => {
    // Also pinned rather than hidden. Three boundary candidates were produced and
    // all three were cut at the floor, correctly: they are constructor-parameter
    // asymmetries in test classes, and the reference's four are architectural
    // seams. That is a probe-coverage gap, not a scoring one - rescoring noise
    // does not turn it into a seam.
    expect(countByType(produced)["boundary"]).toBeUndefined();
    expect(countByType(reference)["boundary"]).toBe(4);
  });

  it("produces fewer than half the reference's nodes, and the number is the finding", () => {
    // Recorded so it moves visibly. 15 against 33: the decisions, deep dives,
    // orientation figures and edges are there; the flows and boundaries are not.
    expect(produced.nodes).toHaveLength(15);
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
