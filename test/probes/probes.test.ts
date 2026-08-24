/**
 * The probe library and the existence gate.
 *
 * #5 requires a fixture test per probe, and the fixtures here are small trees
 * built to contain exactly the shape each probe encodes. The gate tests are the
 * ones that matter most: #7's point 7 makes the gate bidirectional, and a gate
 * that can only confirm is the single-direction version that was already found
 * wrong on the reference subject.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  dedupeCandidateFindings,
  dedupeCandidateIds,
  PROBES,
  runProbes,
  treeContext,
} from "../../src/probes/registry.js";
import { gate, gateCandidate } from "../../src/gate/gate.js";
import {
  detectToolchains,
  type Candidate,
  type ExistenceClaim,
  type Probe,
  type ProbeContext,
  type ProbeOutcome,
} from "../../src/probes/types.js";
import type { DecisionNode } from "../../src/schema/types.js";
import {
  MIGRATION_EXTENSION_ERE,
  MIGRATION_PATH_ERE,
  SOURCE_EXTENSION_ERE,
  TEST_PATH_ERE,
} from "../../src/harvest/tree.js";
import type { Harvest, HarvestedIssue } from "../../src/harvest/types.js";

/* ---------------------------------------------------------- fixtures */

const buildTree = (files: Record<string, string>): { path: string; sha: string } => {
  const path = mkdtempSync(join(tmpdir(), "repo-atlas-probe-"));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), contents, "utf8");
  }
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "probe@test.invalid"]);
  git(["config", "user.name", "probe test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "subject"]);
  return { path, sha: git(["rev-parse", "HEAD"]).trim() };
};

const issue = (over: Partial<HarvestedIssue>): HarvestedIssue => ({
  number: 1,
  title: "An issue",
  body: "",
  state: "open",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  author: "u",
  labels: [],
  comment_count: 0,
  comments: [],
  ...over,
});

const harvestWith = (issues: HarvestedIssue[], sha: string): Harvest =>
  ({
    harvest_version: "1.0.0",
    subject: {
      owner: "o",
      repo: "r",
      url: "https://github.com/o/r",
      branch: "main",
      sha,
      read_on: "2026-08-10",
      visibility: "public",
    },
    issues,
    scale: { files: 0, lines: 0, commits: 1, first_commit: null, last_commit: null, days: null },
    density: {
      closed_issues_with_resolution_comment: { value: 0, of: 0 },
      comment_to_body_ratio: { value: 0, note: "" },
      source_files_citing_issues: { value: 0, of: 0 },
      adr_directory: { value: false, note: "" },
    },
    sources: [],
    private_split: { declared: false, readable_at_harvest: false },
    memory_files: [],
  }) as Harvest;

const contextFor = (files: Record<string, string>, issues: HarvestedIssue[] = []): ProbeContext => {
  const tree = buildTree(files);
  return treeContext(harvestWith(issues, tree.sha), tree.path);
};

const candidatesFrom = async (id: string, ctx: ProbeContext): Promise<Candidate[]> => {
  const probe = PROBES.find((p) => p.id === id)!;
  return probe.run(ctx);
};

/* ------------------------------------------------------- the manifest */

describe("the probe manifest", () => {
  it("ships all eight discovery probes, plus the two node types nothing else mints", () => {
    // #5's resolution names EIGHT discovery probes and all eight are here. The
    // ninth is not a discovery probe from that list: `unresolved-references` is
    // #6 point 3, which requires a source citation the record never explains to
    // become a coverage_gap edge rather than being silently dropped. It is built
    // as a probe because it fits the contract exactly - a pure deterministic
    // function over harvest artifacts - and #5 says adding one is a module, a
    // manifest entry and a fixture test with no core changes.
    // The ninth and tenth are not discovery probes from #5's list.
    // `unresolved-references` is #6 point 3. `measured-scale` restates figures the
    // harvest already measured as Fact nodes - the stat tiles the reference
    // overview opens with, which no stage produced at all.
    // The last seven are #35's Flow adapters. They are seven entries rather than
    // one for the same reason the list is enumerated at all: "this subject runs
    // no Spring", "this subject ships no runnable main", "this subject has no
    // frontend calling it", "this subject stores nothing it derives from", "this
    // subject runs no batch work", "this subject consumes no messages" and "this
    // subject ships no unit files" are different findings, and no one adapter can
    // report another's absence.
    // The last four close #22's probe-coverage gap: the reference overview's four
    // architectural boundaries had no producer at all (the only boundary probe was
    // `dependency-asymmetry`, whose findings on the reference subject were three
    // test-class constructor asymmetries), and its "a green suite is not evidence
    // a named test ran" coverage gap had none either. Three boundary probes rather
    // than one for the same reason the Flow adapters are seven: "these two closed
    // sets vary independently", "this abstraction does not require that package"
    // and "this enum carries a value that one cannot" are three different findings
    // about three different shapes, and no one of them can report another's
    // absence.
    expect(PROBES).toHaveLength(21);
    expect(PROBES.map((p) => p.id).sort()).toEqual([
      "ci-policy-guards",
      "decided-but-unbuilt",
      "dependency-asymmetry",
      "dependency-divergence",
      "flow-java-cli",
      "flow-java-shared-state",
      "flow-java-spring-http",
      "flow-java-spring-message",
      "flow-java-spring-scheduled",
      "flow-systemd-unit",
      "flow-typescript-http-client",
      "measured-scale",
      "orthogonal-hierarchies",
      "partitioned-implementations",
      "repeated-sql-predicates",
      "sealed-hierarchies",
      "self-disabling-tests",
      "superset-enum",
      "throw-where-siblings-return",
      "tuned-config-properties",
      "unresolved-references",
    ]);
  });

  it("declares each probe's toolchain, with the code-level ones Java-only in v1", () => {
    const java = PROBES.filter((p) => p.toolchain === "java").map((p) => p.id);
    expect(java.sort()).toEqual([
      "dependency-asymmetry",
      "flow-java-cli",
      "flow-java-shared-state",
      "flow-java-spring-http",
      "flow-java-spring-message",
      "flow-java-spring-scheduled",
      "orthogonal-hierarchies",
      "partitioned-implementations",
      "sealed-hierarchies",
      "self-disabling-tests",
      "superset-enum",
      "throw-where-siblings-return",
    ]);
    // The systemd adapter is `any` deliberately: a unit file is not source in any
    // language, so the toolchain test cannot answer for it and the adapter answers
    // its own applicability question instead (#35, PR 8).
    expect(PROBES.find((p) => p.id === "flow-systemd-unit")!.toolchain).toBe("any");
  });

  it("reports an inapplicable probe BY NAME rather than passing silently", async () => {
    // A subject with no Java must not look identical to one where every Java
    // probe ran and found nothing. Those are different findings (#5).
    const ctx = contextFor({ "app.ts": "export const x = 1;\n" });
    const { outcomes } = await runProbes(ctx);
    const skipped = outcomes.filter((o) => o.status === "not_applicable");
    expect(skipped.map((o) => o.probe_id).sort()).toEqual([
      "dependency-asymmetry",
      "flow-java-cli",
      "flow-java-shared-state",
      "flow-java-spring-http",
      "flow-java-spring-message",
      "flow-java-spring-scheduled",
      "flow-systemd-unit",
      "flow-typescript-http-client",
      "orthogonal-hierarchies",
      "partitioned-implementations",
      "sealed-hierarchies",
      "self-disabling-tests",
      "superset-enum",
      "throw-where-siblings-return",
    ]);
    for (const o of skipped) {
      // Two levels of the same rule. Seven of these are absent TOOLCHAINS; the
      // TypeScript client adapter has its toolchain and is still inapplicable
      // because this module calls nothing, and the systemd adapter has no
      // toolchain to be absent at all and is inapplicable because the subject
      // declares no unit file. Both are SUBJECT-level answers the toolchain test
      // cannot give, which is what `Probe.applies` exists for.
      expect(o.status === "not_applicable" && o.reason).toMatch(
        o.probe_id === "flow-typescript-http-client" || o.probe_id === "flow-systemd-unit"
          ? /not applicable to this subject/
          : /not applicable to this toolchain/,
      );
    }
  }, 60_000);

  it("detects the toolchains a tree actually carries", () => {
    expect([...detectToolchains(["A.java"])].sort()).toEqual(["any", "java"]);
    expect([...detectToolchains(["a.py", "b.tsx"])].sort()).toEqual(["any", "python", "typescript"]);
  });

  it("emits nothing rather than erroring when a probe finds nothing", async () => {
    const ctx = contextFor({ "Empty.java": "class Empty {}\n" });
    const { outcomes } = await runProbes(ctx);
    expect(outcomes.every((o) => o.status === "ran" || o.status === "not_applicable")).toBe(true);
  }, 60_000);

  it("mints a unique id for every candidate even when names collide across files", async () => {
    // id is used verbatim as the rendered element id, so two candidates for the
    // same simple name in two packages - or the same setting in two config
    // files - must not share one. Uniqueness is minted where the id is, by
    // including a path-derived component.
    const ctx = contextFor({
      "a/Grader.java": "package a;\nsealed interface Grader permits AnswerKey, SelfCheck {}\n",
      "b/Grader.java": "package b;\nsealed interface Grader permits AnswerKey, SelfCheck {}\n",
      "main/application.yml": "# measured: 10s is the p99 under load\ntimeout: PT10S\n",
      "test/application.yml": "# measured: 5s is enough for the suite\ntimeout: PT5S\n",
    });
    const { outcomes } = await runProbes(ctx);
    const ids = outcomes.flatMap((o) => (o.status === "ran" ? o.candidates.map((c) => c.node.id) : []));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it("mints a unique id even when names collide WITHIN one file", async () => {
    // A path-derived component is not enough on its own: two overloads that both
    // refuse outright share a name AND a file, and the same setting can be tuned
    // twice in one config file. A semantic within-file discriminator - the
    // parameter signature, the occurrence ordinal - is what keeps the id unique
    // by construction, which the audit's element-id lookups (G1/G2/E1) rely on.
    const ctx = contextFor({
      "col/Immutable.java":
        "class Immutable {\n" +
        "  void add(String e) { throw new UnsupportedOperationException(); }\n" +
        "  void add(int i, String e) { throw new UnsupportedOperationException(); }\n" +
        "}\n",
      "col/Mutable.java": "class Mutable {\n  String add(String e) { return e; }\n}\n",
      "svc/application.yml":
        "# measured: 10s is the p99 under load\n" +
        "timeout: PT10S\n" +
        "# tuned: the pool was sized by benchmark\n" +
        "timeout: PT20S\n",
    });
    const { outcomes } = await runProbes(ctx);
    const byProbe = new Map(outcomes.map((o) => [o.probe_id, o]));
    const refuse = byProbe.get("throw-where-siblings-return");
    const tuned = byProbe.get("tuned-config-properties");
    // Both within-file collision shapes must actually fire, or the test proves
    // nothing about disambiguation.
    expect(refuse?.status === "ran" && refuse.candidates.length).toBe(2);
    expect(tuned?.status === "ran" && tuned.candidates.length).toBe(2);
    const ids = outcomes.flatMap((o) => (o.status === "ran" ? o.candidates.map((c) => c.node.id) : []));
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it("drops the colliding candidates and reports them by name, rather than crashing the run", () => {
    // The structural backstop behind per-probe discriminators: a duplicate id is
    // a silent wrong answer in the audit's element-id lookups, so it must never
    // reach the artifact. But one defective probe must not make an entire subject
    // unprobeable, so the colliding candidates are dropped and reported - NOT
    // silently - while everything else survives. Two probes each producing
    // "m-dup" collide; a third candidate is untouched.
    const node = (id: string) => ({
      type: "mechanism" as const,
      id,
      title: "t",
      what: "w",
      why_interesting: "y",
      enforcement: "type-level" as const,
      gotchas: [],
      evidence: [],
      confidence: "verified" as const,
      interview_value: 0,
    });
    const outcomes: ProbeOutcome[] = [
      {
        probe_id: "probe-one",
        status: "ran",
        candidates: [
          { probe_id: "probe-one", node: node("m-dup") },
          { probe_id: "probe-one", node: node("m-keep") },
        ],
      },
      { probe_id: "probe-two", status: "ran", candidates: [{ probe_id: "probe-two", node: node("m-dup") }] },
    ];
    const { outcomes: cleaned, collisions } = dedupeCandidateIds(outcomes);
    // Reported by name, with every probe that minted it.
    expect(collisions).toEqual([{ id: "m-dup", probes: ["probe-one", "probe-two"] }]);
    // Only the colliding candidates are dropped; the untouched one survives.
    const survivors = cleaned.flatMap((o) => (o.status === "ran" ? o.candidates.map((c) => c.node.id) : []));
    expect(survivors).toEqual(["m-keep"]);
  });

  it("drops two candidates describing the same finding, though their ids differ", () => {
    // The id guard cannot see this: two candidates with DISTINCT ids that assert
    // the same (type, title) are one finding twice. The finding guard drops both
    // and reports the pair; a genuinely different finding is untouched.
    const edge = (id: string, title: string) => ({
      type: "edge" as const,
      kind: "divergence" as const,
      id,
      title,
      statement: "s",
      why_it_matters: "w",
      how_to_say_it: "h",
      evidence: [],
      confidence: "verified" as const,
      interview_value: 0,
    });
    const outcomes: ProbeOutcome[] = [
      {
        probe_id: "probe-one",
        status: "ran",
        candidates: [
          { probe_id: "probe-one", node: edge("e-a", "The record names postgres") },
          { probe_id: "probe-one", node: edge("e-distinct", "The record names redis") },
        ],
      },
      {
        probe_id: "probe-two",
        status: "ran",
        candidates: [{ probe_id: "probe-two", node: edge("e-b", "The record names postgres") }],
      },
    ];
    const { outcomes: cleaned, collisions } = dedupeCandidateFindings(outcomes);
    // Named by the (type, title) pair, with every probe that minted it.
    expect(collisions).toEqual([
      { type: "edge", title: "The record names postgres", probes: ["probe-one", "probe-two"] },
    ]);
    // Both duplicates are dropped; the similar-but-different finding survives.
    const survivors = cleaned.flatMap((o) => (o.status === "ran" ? o.candidates.map((c) => c.node.id) : []));
    expect(survivors).toEqual(["e-distinct"]);
  });
});

/* --------------------------------------------------- library-wide naming */

describe("library-wide naming invariants", () => {
  // A tree that fires the type-naming structural probes on nested types sharing
  // a simple name across different enclosing types in one file, plus a
  // collaborator whose type carries selector-hostile characters (an array).
  const nestedTree: Record<string, string> = {
    "s/Sealed.java":
      "class A { sealed interface Shape permits Sq, Ci {} }\n" +
      "class B { sealed interface Shape permits Sq, Ci {} }\n",
    "t/Throw.java":
      "class A { class Inner { void foo() { throw new UnsupportedOperationException(); } } }\n" +
      "class B { class Inner { void foo() { throw new UnsupportedOperationException(); } } }\n" +
      "class C { String foo() { return \"c\"; } }\n",
    "d/One.java": "class One { private Runner[] runner; }\n",
    "d/Two.java": "class Two { private Runner[] runner; }\n",
    "d/Three.java": "class Three { private Runner[] runner; }\n",
    "d/Four.java": "class Four { private String key; }\n",
  };

  // A CSS id selector matches this without escaping, so an id that satisfies it
  // round-trips through the querySelector("#id") lookups the audit's G1/G2/E1
  // checks resolve nodes by. Brackets, dots and the like would break that.
  const SELECTOR_SAFE = /^[A-Za-z][A-Za-z0-9_-]*$/;

  it("mints only selector-safe candidate ids across the whole run", async () => {
    const { outcomes } = await runProbes(contextFor(nestedTree));
    const ids = outcomes.flatMap((o) => (o.status === "ran" ? o.candidates.map((c) => c.node.id) : []));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(SELECTOR_SAFE);
    // And unique, so a selector never resolves two nodes.
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it("carries the full enclosing type path into both id and title, so they cannot drift", async () => {
    const { outcomes } = await runProbes(contextFor(nestedTree));
    const titleFor = (probe: string): string[] =>
      outcomes
        .filter((o) => o.status === "ran")
        .flatMap((o) => (o.status === "ran" && o.probe_id === probe ? o.candidates : []))
        .map((c) => c.node.title)
        .sort();

    // sealed and throw both see two nested types sharing a simple name; each
    // node names its OWN full path, and the two ids differ by construction.
    expect(titleFor("sealed-hierarchies")).toEqual([
      "A.Shape is sealed over 2 permitted types",
      "B.Shape is sealed over 2 permitted types",
    ]);
    const throwTitles = titleFor("throw-where-siblings-return");
    expect(throwTitles[0]).toContain("A.Inner.foo");
    expect(throwTitles[1]).toContain("B.Inner.foo");
  }, 60_000);
});

/* ------------------------------------------------ one fixture per probe */

/* ------------------------------ #28: what a probe's own reading may claim */

describe("a probe may not mint verified for what its reading did not establish", () => {
  /**
   * #28's contract rule, exercised through the REAL collection path.
   *
   * The three text probes now emit `attested` in their own source, so on its own
   * that says nothing about a FOURTH grep-class probe written next year - and
   * relying on every future one being right first time is option 1, the option
   * #28 rejected because it is exactly what failed during the #19 build. These
   * tests register a synthetic probe and run it through `runProbes`, so what is
   * proved is that the contract holds for a probe nobody has reviewed.
   */
  const synthetic = (over: Partial<Probe>, candidate: Partial<Candidate> = {}): Probe => ({
    id: "synthetic-grep-probe",
    finds: "a line of text that looks like something",
    toolchain: "any",
    run: () => [
      {
        probe_id: "synthetic-grep-probe",
        node: {
          type: "fact",
          id: "f-synthetic",
          label: "a setting",
          value: "10",
          source: "file",
          title: "A finding read out of a line of text",
          evidence: [{ kind: "file", path: "notes.txt", line_start: 1, line_end: 1, sha: "" }],
          confidence: "verified",
          interview_value: 0,
        },
        ...candidate,
      },
    ],
    ...over,
  });

  const ranCandidates = async (probe: Probe): Promise<Candidate[]> => {
    const ctx = contextFor({ "notes.txt": "a line\n" });
    const outcome = (await runProbes(ctx, [probe])).outcomes[0]!;
    expect(outcome.status).toBe("ran");
    return outcome.status === "ran" ? outcome.candidates : [];
  };

  it("holds a new grep-class probe to attested without it opting in", async () => {
    // THE MUTANT. A probe that declares no reading and states no claim is the
    // #19 defect class in its purest form: a text heuristic minting a confidence
    // level nothing downstream re-checks. `heuristic` is the DEFAULT precisely so
    // this needs no vigilance from whoever writes the probe.
    const found = await ranCandidates(synthetic({}));
    expect(found[0]!.node.confidence).toBe("attested");
  }, 60_000);

  it("leaves a probe alone when its own reading is the finding", async () => {
    const found = await ranCandidates(synthetic({ reading: "direct" }));
    expect(found[0]!.node.confidence).toBe("verified");
  }, 60_000);

  it("does not lower the ceiling: a grep-class probe that states a claim keeps verified", async () => {
    // #28's cost is meant to be unearned confidence, not reachable confidence.
    // A text probe that can say something checkable hands the gate an obligation,
    // and the gate - not the clamp - then settles it.
    const claims: ExistenceClaim[] = [
      { description: "the tree carries notes.txt", expect: "present", paths: ["notes.txt"] },
    ];
    const found = await ranCandidates(synthetic({}, { claims }));
    expect(found[0]!.node.confidence).toBe("verified");

    const ctx = contextFor({ "notes.txt": "a line\n" });
    expect(gateCandidate(ctx, found[0]!).verdict).toBe("confirmed");
    expect(gateCandidate(ctx, found[0]!).node.confidence).toBe("verified");
  }, 60_000);

  it("still demotes a claim the gate cannot settle, so the claim is not a loophole", async () => {
    // A claim exempts a candidate from the clamp because the GATE owns it from
    // there. That is only true because the gate demotes what it cannot resolve;
    // if it passed such a candidate through, stating an unreadable claim would be
    // a way to buy back exactly the confidence #28 removed.
    const claims: ExistenceClaim[] = [
      { description: "something the tree cannot settle", expect: "present" },
    ];
    const found = await ranCandidates(synthetic({}, { claims }));
    const gated = gateCandidate(contextFor({ "notes.txt": "a line\n" }), found[0]!);
    expect(gated.verdict).toBe("unresolved");
    expect(gated.node.confidence).toBe("attested");
  }, 60_000);

  it("only ever moves confidence downwards", async () => {
    // The clamp is not a second authority over what survives (#2, #5): an
    // `absent` candidate is the Flow producer's and the write stage's way of
    // saying a finding was cut, and promoting one to `attested` here would put
    // a cut finding back into the artifact behind the rank stage's back.
    const found = await ranCandidates(
      synthetic({
        run: () => [
          {
            probe_id: "synthetic-grep-probe",
            node: {
              type: "fact",
              id: "f-synthetic-absent",
              label: "a setting",
              value: "10",
              source: "file",
              title: "A finding with no admissible evidence",
              evidence: [],
              confidence: "absent",
              interview_value: 0,
            },
          },
        ],
      }),
    );
    expect(found[0]!.node.confidence).toBe("absent");
  }, 60_000);

  it("records which library probes claim their reading is the finding", () => {
    // The register is the decision record for #28's scope. The three text probes
    // named in the issue take the default; the three structural ones and the two
    // node producers whose reading IS a citation declare it, and each says why in
    // its own source. A probe moving between these lists is a change of what the
    // artifact asserts about its evidence, so it moves this test with it.
    const reading = (id: string) => PROBES.find((p) => p.id === id)!.reading ?? "heuristic";
    for (const id of ["ci-policy-guards", "repeated-sql-predicates", "tuned-config-properties"]) {
      expect(reading(id), id).toBe("heuristic");
    }
    for (const id of [
      "sealed-hierarchies",
      "throw-where-siblings-return",
      "dependency-asymmetry",
      "measured-scale",
      "unresolved-references",
    ]) {
      expect(reading(id), id).toBe("direct");
    }
  });

  it("leaves the Flow adapters to the Flow gate, which earns verified for them", async () => {
    // A Flow candidate reaches `verified` carrying `flow_claims`, so it is
    // gate-obligated in the same way a claim-bearing candidate is - the atomic
    // Flow gate re-resolves every arrow independently (#35) and quarantines the
    // whole story otherwise. The clamp must not touch it, or the producer's
    // verified chain would arrive demoted and the gate's re-resolution would be
    // deciding something already decided.
    const found = await ranCandidates(
      synthetic({}, { flow_claims: [] }),
    );
    expect(found[0]!.node.confidence).toBe("attested");
    const withClaim = await ranCandidates(
      synthetic(
        {},
        {
          flow_claims: [
            {
              expect: "present",
              matcher: "direct_call",
              from: { path: "notes.txt", name: "x" },
              evidence: [],
            },
          ],
        },
      ),
    );
    expect(withClaim[0]!.node.confidence).toBe("verified");
  }, 60_000);
});

describe("sealed-hierarchies", () => {
  it("finds a sealed type and its permitted set", async () => {
    const ctx = contextFor({
      "Grader.java": "sealed interface Grader permits AnswerKeyGrader, SelfCheckGrader {}\n",
    });
    const found = await candidatesFrom("sealed-hierarchies", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.title).toContain("2 permitted types");
    expect(found[0]!.node.confidence).toBe("verified");
  }, 60_000);

  it("names the full enclosing path so same-named nested sealed types stay distinct", async () => {
    // Two nested sealed types sharing a simple name under different outer types
    // in one file resolve to the same simple name ("Shape"); only the full path
    // (A.Shape vs B.Shape) tells them apart in both the id and the title. The
    // simple-name title would name "Shape" without saying which - the same
    // identify-what-you-established failure the throw probe already fixed.
    const ctx = contextFor({
      "nest/Nest.java":
        "class A { sealed interface Shape permits Sq, Ci {} }\n" +
        "class B { sealed interface Shape permits Sq, Ci {} }\n",
    });
    const found = await candidatesFrom("sealed-hierarchies", ctx);
    expect(found).toHaveLength(2);
    const titles = found.map((c) => c.node.title).sort();
    expect(titles[0]).toContain("A.Shape");
    expect(titles[1]).toContain("B.Shape");
    const ids = found.map((c) => c.node.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it("ignores a type that is not sealed", async () => {
    const ctx = contextFor({ "Plain.java": "interface Plain { void go(); }\n" });
    expect(await candidatesFrom("sealed-hierarchies", ctx)).toEqual([]);
  }, 60_000);
});

describe("throw-where-siblings-return", () => {
  it("finds a method refusing outright where siblings return", async () => {
    const ctx = contextFor({
      "A.java": "class A { String run() { return \"a\"; } }\n",
      "B.java": "class B { String run() { return \"b\"; } }\n",
      "C.java": "class C { String run() { throw new UnsupportedOperationException(); } }\n",
    });
    const found = await candidatesFrom("throw-where-siblings-return", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.title).toContain("run");
    // Structural (#28): the parse tree is the reading, so this keeps verified.
    expect(found[0]!.node.confidence).toBe("verified");
  }, 60_000);

  it("names each candidate's OWN enclosing type, not a text-matched sibling", async () => {
    // Two sibling classes carrying a byte-identical refusing method each contain
    // the other's method text, so a text-substring owner walk resolved both to
    // the last-visited class - mis-attributing the title and minting one id
    // twice. The enclosing-type walk names the actual owner.
    const ctx = contextFor({
      "pair/Pair.java":
        "class A { void foo() { throw new UnsupportedOperationException(); } }\n" +
        "class B { void foo() { throw new UnsupportedOperationException(); } }\n" +
        "class C { String foo() { return \"c\"; } }\n",
    });
    const found = await candidatesFrom("throw-where-siblings-return", ctx);
    expect(found).toHaveLength(2);
    const titles = found.map((c) => c.node.title).sort();
    expect(titles[0]).toContain("A.foo");
    expect(titles[1]).toContain("B.foo");
    const ids = found.map((c) => c.node.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it("names the full enclosing path so same-named nested types stay distinct", async () => {
    // Two nested classes sharing a simple name under different outer types in one
    // file resolve to the same innermost owner ("Inner"); only the full path
    // (A.Inner vs B.Inner) tells them apart. The innermost-only id would collide
    // and trip the run-level uniqueness guard, and the title would name "Inner"
    // without saying which - the same identify-what-you-established failure.
    const ctx = contextFor({
      "nest/Nest.java":
        "class A { class Inner { void foo() { throw new UnsupportedOperationException(); } } }\n" +
        "class B { class Inner { void foo() { throw new UnsupportedOperationException(); } } }\n" +
        "class C { String foo() { return \"c\"; } }\n",
    });
    const found = await candidatesFrom("throw-where-siblings-return", ctx);
    expect(found).toHaveLength(2);
    const titles = found.map((c) => c.node.title).sort();
    expect(titles[0]).toContain("A.Inner.foo");
    expect(titles[1]).toContain("B.Inner.foo");
    const ids = found.map((c) => c.node.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it("keeps two overloads distinct across the array/varargs boundary", async () => {
    // slug strips `[]` and `...`, so write(byte) and write(byte[]) would mint the
    // same signature and the same id unless the marker is preserved before
    // slugging. A duplicate id trips the run-level uniqueness guard.
    const ctx = contextFor({
      "col/Stub.java":
        "class Stub {\n" +
        "  void write(byte b) { throw new UnsupportedOperationException(); }\n" +
        "  void write(byte[] b) { throw new UnsupportedOperationException(); }\n" +
        "}\n",
      "col/Real.java": "class Real {\n  int write(byte b) { return 0; }\n}\n",
    });
    const found = await candidatesFrom("throw-where-siblings-return", ctx);
    expect(found).toHaveLength(2);
    const ids = found.map((c) => c.node.id);
    expect(new Set(ids).size).toBe(2);
  }, 60_000);

  it("ignores a throw that is a guard clause rather than a refusal", async () => {
    const ctx = contextFor({
      "A.java": "class A { String run() { return \"a\"; } }\n",
      "C.java": 'class C { String run() { if (x == null) { throw new UnsupportedOperationException(); } return "c"; } }\n',
    });
    expect(await candidatesFrom("throw-where-siblings-return", ctx)).toEqual([]);
  }, 60_000);

  it("does not pair two unrelated types that merely share a method name", async () => {
    // A refusing iterator() in one hierarchy and a returning iterator() in an
    // unrelated one share no supertype and no directory. They are not siblings,
    // so pairing them would assert a seam between types that share no contract -
    // a fabricated relationship the bounded sibling set exists to refuse.
    const ctx = contextFor({
      "x/A.java": "class A { Object iterator() { throw new UnsupportedOperationException(); } }\n",
      "y/B.java": "class B { Object iterator() { return null; } }\n",
    });
    expect(await candidatesFrom("throw-where-siblings-return", ctx)).toEqual([]);
  }, 60_000);

  it("pairs implementations of a supertype the subject declares, even across directories", async () => {
    // The shared shape is what makes the asymmetry a design: one Grader refuses
    // where its fellow Graders return. The supertype binds them even though they
    // live in different directories - but only because the subject itself
    // declares Grader, so the shape is one it designed.
    const ctx = contextFor({
      "i/Grader.java": "interface Grader { Object grade(); }\n",
      "a/Self.java": "class Self implements Grader { Object grade() { throw new UnsupportedOperationException(); } }\n",
      "b/AnswerKey.java": "class AnswerKey implements Grader { Object grade() { return null; } }\n",
      "c/TestCase.java": "class TestCase implements Grader { Object grade() { return this; } }\n",
    });
    const found = await candidatesFrom("throw-where-siblings-return", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.title).toContain("Self.grade");
    // Two sibling implementations return, and the count reflects that.
    expect(found[0]!.node.type === "mechanism" && found[0]!.node.what).toContain("2 other");
  }, 60_000);

  it("does not pair two classes that share only a supertype the subject never declares", async () => {
    // A supertype the tree does not declare - a JDK interface like Comparable -
    // is shared by types that decided nothing together. A class throwing in
    // compareTo must not pair with an unrelated Comparable implementer in another
    // directory: they share no shape the subject designed, so no candidate.
    const ctx = contextFor({
      "x/A.java": "class A implements Comparable { int compareTo(Object o) { throw new UnsupportedOperationException(); } }\n",
      "y/B.java": "class B implements Comparable { int compareTo(Object o) { return 0; } }\n",
    });
    expect(await candidatesFrom("throw-where-siblings-return", ctx)).toEqual([]);
  }, 60_000);

  it("pairs directory peers when neither declares a supertype", async () => {
    // With no supertype to key on, the sibling set falls back to the directory -
    // the same peer notion dependency-asymmetry uses, so the two probes agree.
    const ctx = contextFor({
      "g/One.java": "class One { String run() { return \"a\"; } }\n",
      "g/Two.java": "class Two { String run() { return \"b\"; } }\n",
      "g/Three.java": "class Three { String run() { throw new UnsupportedOperationException(); } }\n",
    });
    const found = await candidatesFrom("throw-where-siblings-return", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.title).toContain("Three.run");
  }, 60_000);

  it("does not treat a class's own overload as its sibling", async () => {
    // One class whose overloads differ in refusing-vs-returning may be a real
    // finding, but it is not the one this probe makes: a type is never its own
    // sibling, and the title would say "siblings" of something with none.
    const ctx = contextFor({
      "one/X.java":
        "class X {\n" +
        "  void f() { throw new UnsupportedOperationException(); }\n" +
        "  String f(int i) { return \"x\"; }\n" +
        "}\n",
    });
    expect(await candidatesFrom("throw-where-siblings-return", ctx)).toEqual([]);
  }, 60_000);
});

describe("dependency-asymmetry", () => {
  it("finds the one sibling missing a collaborator the others hold", async () => {
    const ctx = contextFor({
      "g/One.java": "class One { private Runner runner; }\n",
      "g/Two.java": "class Two { private Runner runner; }\n",
      "g/Three.java": "class Three { private Runner runner; }\n",
      "g/Four.java": "class Four { private String key; }\n",
    });
    const found = await candidatesFrom("dependency-asymmetry", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.title).toContain("Four holds no Runner");
    // Structural (#28): the field declarations of each sibling ARE the reading,
    // so this side of the split keeps verified.
    expect(found[0]!.node.confidence).toBe("verified");
  }, 60_000);

  it("slugs a bracketed or qualified collaborator type into a selector-safe id", async () => {
    // The collaborator type is interpolated into the element id. An array type
    // ("Runner[]") or a qualified one ("java.util.Map") carries characters that
    // are legal in an HTML id but break querySelector("#id") - the lookup the
    // audit's G1/G2/E1 checks resolve nodes by. slug() keeps the id selector-safe.
    const ctx = contextFor({
      "g/One.java": "class One { private Runner[] runner; }\n",
      "g/Two.java": "class Two { private Runner[] runner; }\n",
      "g/Three.java": "class Three { private Runner[] runner; }\n",
      "g/Four.java": "class Four { private String key; }\n",
    });
    const found = await candidatesFrom("dependency-asymmetry", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
  }, 60_000);

  it("does not attribute an inner class's field to its enclosing class", async () => {
    // One's Db field lives on its inner Helper, not on One itself. Walking the
    // whole subtree would let One appear to hold Db, so "every sibling holds Db"
    // would read true and the probe would assert a boundary that does not exist.
    // Only One's own body counts, so held(Db) never reaches every-sibling.
    const ctx = contextFor({
      "g/One.java": "class One { class Helper { private Db db; } }\n",
      "g/Two.java": "class Two { private Db db; }\n",
      "g/Three.java": "class Three { private Db db; }\n",
      "g/Four.java": "class Four { private String key; }\n",
    });
    expect(await candidatesFrom("dependency-asymmetry", ctx)).toEqual([]);
  }, 60_000);

  it("compares repo-root classes as siblings of one another", async () => {
    // A root-level file has no slash; a bare slice would drop the last character
    // and strand each class in its own bogus directory, so they would never be
    // compared. Guarding the no-slash case puts them back in the shared root.
    const ctx = contextFor({
      "One.java": "class One { private Runner runner; }\n",
      "Two.java": "class Two { private Runner runner; }\n",
      "Three.java": "class Three { private Runner runner; }\n",
      "Four.java": "class Four { private String key; }\n",
    });
    const found = await candidatesFrom("dependency-asymmetry", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.title).toContain("Four holds no Runner");
  }, 60_000);

  it("does not count a nested helper as a directory sibling", async () => {
    // Outer.Helper is not a peer of the top-level classes in its directory.
    // Counting it as one would make it the odd sibling ("Helper holds no Runner,
    // and every sibling does"), a seam the record never drew. Nested types are
    // excluded from the sibling set, so no finding is synthesised.
    const ctx = contextFor({
      "g/One.java": "class One { private Runner runner; }\n",
      "g/Two.java": "class Two { private Runner runner; }\n",
      "g/Outer.java": "class Outer { private Runner runner; class Helper { private String key; } }\n",
    });
    expect(await candidatesFrom("dependency-asymmetry", ctx)).toEqual([]);
  }, 60_000);
});

describe("repeated-sql-predicates", () => {
  it("finds a predicate repeated across queries", async () => {
    const q = "where outcome = 'PASSED'";
    const ctx = contextFor({
      "A.java": `String a = "select 1 ${q}";\n`,
      "B.java": `String b = "select 2 ${q}";\n`,
      "C.java": `String c = "select 3 ${q}";\n`,
    });
    const found = await candidatesFrom("repeated-sql-predicates", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.title).toContain("3 queries");
    // Grep-class (#28): the recurrence is read out of the text, and nothing here
    // hands the gate a claim, so the finding ships attested.
    expect(found[0]!.node.confidence).toBe("attested");
    expect(found[0]!.claims ?? []).toEqual([]);
  }, 60_000);

  it("mints distinct ids for two predicates sharing a 40-char prefix", async () => {
    // The id slugs the predicate and truncates it for legibility, so two
    // predicates differing only past 40 chars would collide on the readable
    // part alone; a digest of the full predicate keeps the ids distinct.
    const p1 = "status = 'active-tenant-in-region-europe-primary-shard-one'";
    const p2 = "status = 'active-tenant-in-region-europe-primary-shard-two'";
    const ctx = contextFor({
      "A.java": `String a = "select 1 where ${p1}";\nString b = "select 2 where ${p2}";\n`,
      "B.java": `String c = "select 3 where ${p1}";\nString d = "select 4 where ${p2}";\n`,
      "C.java": `String e = "select 5 where ${p1}";\nString f = "select 6 where ${p2}";\n`,
    });
    const found = await candidatesFrom("repeated-sql-predicates", ctx);
    expect(found).toHaveLength(2);
    const ids = found.map((c) => c.node.id);
    // The readable, truncated prefixes are identical - the collision the digest exists to break.
    expect(ids[0]!.slice(0, 55)).toBe(ids[1]!.slice(0, 55));
    expect(new Set(ids).size).toBe(2);
  }, 60_000);

  it("ignores a predicate used twice, which is a coincidence", async () => {
    const ctx = contextFor({
      "A.java": "String a = \"select 1 where x = 'Y'\";\n",
      "B.java": "String b = \"select 2 where x = 'Y'\";\n",
    });
    expect(await candidatesFrom("repeated-sql-predicates", ctx)).toEqual([]);
  }, 60_000);
});

describe("tuned-config-properties", () => {
  it("finds a value documented as measured rather than chosen", async () => {
    const ctx = contextFor({
      "application.yml": "# measured: 10s is the p99 under load\ntimeout: PT10S\n",
    });
    const found = await candidatesFrom("tuned-config-properties", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.title).toContain("timeout");
    // Grep-class (#28): a comment saying a value was measured is not the
    // measurement, so the finding ships attested.
    expect(found[0]!.node.confidence).toBe("attested");
    expect(found[0]!.claims ?? []).toEqual([]);
  }, 60_000);

  it("ignores a value with an ordinary comment", async () => {
    const ctx = contextFor({ "application.yml": "# the timeout\ntimeout: PT10S\n" });
    expect(await candidatesFrom("tuned-config-properties", ctx)).toEqual([]);
  }, 60_000);

  it("emits one candidate for a setting introduced by a multi-line rationale", async () => {
    // A setting is the unit of finding: a rationale spread over several comment
    // lines is one tuning, and each of those lines must not mint its own node.
    // The merged block is carried as the note so no rationale is lost.
    const ctx = contextFor({
      "application.yml":
        "# We measured this under load.\n" +
        "# Found that PT10S is the sweet spot.\n" +
        "timeout: PT10S\n",
    });
    const found = await candidatesFrom("tuned-config-properties", ctx);
    expect(found).toHaveLength(1);
    const note = found[0]!.node.evidence[0]?.note ?? "";
    expect(note).toContain("We measured this under load.");
    expect(note).toContain("Found that PT10S is the sweet spot.");
  }, 60_000);

  it("still emits two candidates for two distinct tuned settings in one file", async () => {
    const ctx = contextFor({
      "application.yml":
        "# measured: 10s is the p99 under load\n" +
        "timeout: PT10S\n" +
        "# tuned: the pool was sized by benchmark\n" +
        "poolSize: 32\n",
    });
    const found = await candidatesFrom("tuned-config-properties", ctx);
    expect(found).toHaveLength(2);
  }, 60_000);

  it("cites only the comment lines directly above the setting", async () => {
    const ctx = contextFor({
      "application.yml":
        "# We measured this under load.\n" + // line 1
        "# Found that PT10S is the sweet spot.\n" + // line 2
        "timeout: PT10S\n", // line 3
    });
    const found = await candidatesFrom("tuned-config-properties", ctx);
    expect(found).toHaveLength(1);
    const ev = found[0]!.node.evidence[0]!;
    if (ev.kind !== "file") throw new Error("expected file evidence");
    expect(ev.line_start).toBe(1);
    expect(ev.line_end).toBe(3);
    expect(ev.note).toBe("We measured this under load. Found that PT10S is the sweet spot.");
  }, 60_000);

  it("does not merge an unrelated block separated by a blank line", async () => {
    // A licence header / section divider above a blank line above the real tuning
    // comment must not be pulled into the rationale, and line_start must point at
    // the tuning comment, not the unrelated block - else the citation range would
    // not contain the text it cites.
    const ctx = contextFor({
      "application.yml":
        "# Copyright 2026 Acme. All rights reserved.\n" + // line 1
        "\n" + // line 2
        "# measured: 10s is the p99 under load\n" + // line 3
        "timeout: PT10S\n", // line 4
    });
    const found = await candidatesFrom("tuned-config-properties", ctx);
    expect(found).toHaveLength(1);
    const ev = found[0]!.node.evidence[0]!;
    if (ev.kind !== "file") throw new Error("expected file evidence");
    expect(ev.line_start).toBe(3);
    expect(ev.line_end).toBe(4);
    expect(ev.note).toBe("measured: 10s is the p99 under load");
    expect(ev.note).not.toContain("Copyright");
  }, 60_000);
});

describe("ci-policy-guards", () => {
  it("finds a step guarding policy rather than running tests", async () => {
    const ctx = contextFor({
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - name: Check no private content is committed\n        run: ./scripts/check.sh\n",
    });
    const found = await candidatesFrom("ci-policy-guards", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.title).toContain("private content");
    // The #19 defect class, closed at the contract (#28): even a correct match
    // ships attested, because nothing downstream re-reads it.
    expect(found[0]!.node.confidence).toBe("attested");
    expect(found[0]!.claims ?? []).toEqual([]);
  }, 60_000);

  it("ignores a step that just runs the tests", async () => {
    const ctx = contextFor({
      ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - run: npm test\n",
    });
    expect(await candidatesFrom("ci-policy-guards", ctx)).toEqual([]);
  }, 60_000);

  it("does not mint a step from a comment carrying the policy vocabulary", async () => {
    // The probe asserts a guarding step exists, so a YAML comment that happens to
    // read like policy - even beside a real, unrelated step - must yield nothing.
    const ctx = contextFor({
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      # Guard: never commit a private key\n      - run: npm test\n",
    });
    expect(await candidatesFrom("ci-policy-guards", ctx)).toEqual([]);
  }, 60_000);

  it("ignores a policy-named step that only runs the tests", async () => {
    // The name reads as policy, but the step is a test run; a step is judged by
    // what it does, so this is not a guarding step.
    const ctx = contextFor({
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - name: Guard against a leaked secret\n        run: npm test\n",
    });
    expect(await candidatesFrom("ci-policy-guards", ctx)).toEqual([]);
  }, 60_000);

  it("emits one candidate when a step's name and run both read as policy", async () => {
    // Per-line matching double-emitted such a step; one step is one candidate.
    const ctx = contextFor({
      ".github/workflows/ci.yml":
        "jobs:\n  a:\n    steps:\n      - name: Guard a leaked secret\n        run: ./verify-no-secret-commit.sh\n",
    });
    const found = await candidatesFrom("ci-policy-guards", ctx);
    expect(found).toHaveLength(1);
  }, 60_000);

  it("keeps two jobs' identically-named policy steps distinct by construction", async () => {
    // GitHub step names are not unique: two jobs in one workflow commonly carry
    // the same policy step. Both match on their name line and resolve the same
    // step name, so without a job scope both would mint one id and trip the
    // run-level uniqueness guard. The job scopes the id; a same-job repeat falls
    // back to an occurrence index.
    const ctx = contextFor({
      ".github/workflows/ci.yml":
        "jobs:\n" +
        "  build:\n    steps:\n      - name: Block a leaked credential\n        run: ./scripts/guard.sh\n" +
        "  test:\n    steps:\n      - name: Block a leaked credential\n        run: ./scripts/guard.sh\n",
    });
    const found = await candidatesFrom("ci-policy-guards", ctx);
    expect(found).toHaveLength(2);
    const ids = found.map((c) => c.node.id);
    expect(new Set(ids).size).toBe(2);
    // The job is what tells them apart.
    expect(ids.some((id) => id.includes("build"))).toBe(true);
    expect(ids.some((id) => id.includes("test"))).toBe(true);
  }, 60_000);

  it("disambiguates two same-named policy steps within one job", async () => {
    // Same job, same step name: no semantic discriminator is left, so an
    // occurrence index keeps the ids distinct rather than the churning line number.
    const ctx = contextFor({
      ".github/workflows/ci.yml":
        "jobs:\n" +
        "  build:\n    steps:\n" +
        "      - name: Block a leaked credential\n        run: ./scripts/one.sh\n" +
        "      - name: Block a leaked credential\n        run: ./scripts/two.sh\n",
    });
    const found = await candidatesFrom("ci-policy-guards", ctx);
    expect(found).toHaveLength(2);
    expect(new Set(found.map((c) => c.node.id)).size).toBe(2);
  }, 60_000);
});

describe("dependency-divergence", () => {
  it("finds a technology the record names that the build does not declare", async () => {
    const ctx = contextFor({
      "README.md": "Runs on Postgres and Redis.\n",
      "pom.xml":
        "<project><dependencies><dependency><artifactId>postgresql</artifactId></dependency></dependencies></project>\n",
    });
    const found = await candidatesFrom("dependency-divergence", ctx);
    expect(found.map((c) => c.node.id)).toEqual(["e-divergence-redis"]);
  }, 60_000);

  it("reads a README that is not called README.md, and cites it by its real name", async () => {
    // On a `README.markdown` subject the probe read `README.md`, got null, and
    // emitted NOTHING - silently finding no divergence at all. Worse, it also
    // hardcoded `README.md` into the statement and the evidence path, so on any
    // other README name it would cite a file that exists in no tree and audit L1
    // would fail it. The discovered name flows into both.
    const ctx = contextFor({
      "README.markdown": "Runs on Redis.\n",
      "pom.xml":
        "<project><dependencies><dependency><artifactId>guava</artifactId></dependency></dependencies></project>\n",
    });
    const found = await candidatesFrom("dependency-divergence", ctx);
    expect(found.map((c) => c.node.id)).toEqual(["e-divergence-redis"]);
    const node = found[0]!.node;
    if (node.type !== "edge") throw new Error("expected an edge");
    expect(node.statement).toContain("README.markdown");
    expect(node.statement).not.toContain("README.md refers");
    expect(node.evidence).toEqual([{ kind: "file", path: "README.markdown", sha: ctx.sha }]);
  }, 60_000);

  it("emits ONE candidate for a technology the README spells with an overlapping alias", async () => {
    // "PostgreSQL" is the common spelling and it contains "postgres", so a flat
    // vocabulary carrying both would match twice and emit two divergence edges
    // for one technology. Alias groups collapse that to a single candidate.
    const ctx = contextFor({
      "README.md": "Runs on PostgreSQL.\n",
      "pom.xml":
        "<project><dependencies><dependency><artifactId>guava</artifactId></dependency></dependencies></project>\n",
    });
    const found = await candidatesFrom("dependency-divergence", ctx);
    expect(found.map((c) => c.node.id)).toEqual(["e-divergence-postgres"]);
  }, 60_000);

  it("does not diverge when the manifest declares the technology under another alias", async () => {
    // A README saying "postgres" is satisfied by a dependency declared as
    // "postgresql": one technology, one concept, on both sides of the group.
    const ctx = contextFor({
      "README.md": "Runs on Postgres.\n",
      "pom.xml":
        "<project><dependencies><dependency><artifactId>postgresql</artifactId></dependency></dependencies></project>\n",
    });
    expect(await candidatesFrom("dependency-divergence", ctx)).toEqual([]);
  }, 60_000);

  it("does not treat an artifactId inside an XML comment as declared", async () => {
    // A commented-out dependency is not a declaration. Reading it as one would be
    // a false negative: the divergence a reviewer wants surfaced is silently
    // suppressed, and nothing appears in the artifact to look at. A real
    // dependency sits alongside so the build is not empty.
    const ctx = contextFor({
      "README.md": "Runs on Postgres.\n",
      "pom.xml":
        "<project><dependencies>" +
        "<dependency><artifactId>guava</artifactId></dependency>" +
        "<!-- <dependency><artifactId>postgresql</artifactId></dependency> -->" +
        "</dependencies></project>\n",
    });
    const found = await candidatesFrom("dependency-divergence", ctx);
    expect(found.map((c) => c.node.id)).toEqual(["e-divergence-postgres"]);
  }, 60_000);

  it("does not treat an artifactId inside a plugin block as declared", async () => {
    // A build plugin sharing a name with a runtime dependency is not that
    // dependency. Only <dependencies> declarations count; a real dependency
    // sits alongside so the build is not empty.
    const ctx = contextFor({
      "README.md": "Runs on Postgres.\n",
      "pom.xml":
        "<project>" +
        "<dependencies><dependency><artifactId>guava</artifactId></dependency></dependencies>" +
        "<build><plugins><plugin><artifactId>postgresql</artifactId></plugin></plugins></build>" +
        "</project>\n",
    });
    const found = await candidatesFrom("dependency-divergence", ctx);
    expect(found.map((c) => c.node.id)).toEqual(["e-divergence-postgres"]);
  }, 60_000);

  it("treats a real dependency declaration as declared", async () => {
    // The declaration that does count: an artifactId inside <dependencies>. A
    // <parent> coordinate sharing no name and a plugin are ignored around it.
    const ctx = contextFor({
      "README.md": "Runs on Postgres.\n",
      "pom.xml":
        "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent>" +
        "<dependencies><dependency><artifactId>postgresql</artifactId></dependency></dependencies>" +
        "<build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId></plugin></plugins></build></project>\n",
    });
    expect(await candidatesFrom("dependency-divergence", ctx)).toEqual([]);
  }, 60_000);

  it("recognises a Gradle dependency declared under runtimeOnly", async () => {
    // The shared rule must know the standard Gradle configurations, not only
    // implementation/api/compile, or a driver declared under runtimeOnly reads
    // as undeclared and the probe emits a spurious divergence.
    const ctx = contextFor({
      "README.md": "Runs on Postgres.\n",
      "build.gradle": "dependencies {\n  runtimeOnly 'org.postgresql:postgresql:42.7.1'\n}\n",
    });
    expect(await candidatesFrom("dependency-divergence", ctx)).toEqual([]);
  }, 60_000);

  it("demotes rather than confirms when the manifest syntax is unreadable", async () => {
    // A manifest present but in a form the rule cannot parse must not confirm the
    // divergence: "I could not read any declarations" is not "nothing is
    // declared". The gate returns unresolved and the candidate is demoted.
    const ctx = contextFor({
      "README.md": "Runs on Postgres.\n",
      "build.gradle": "dependencies {\n  someExoticConfig 'org.postgresql:postgresql:42.7.1'\n}\n",
    });
    const [candidate] = await candidatesFrom("dependency-divergence", ctx);
    expect(candidate).toBeDefined();
    const result = gateCandidate(ctx, candidate!);
    expect(result.verdict).toBe("unresolved");
    expect(result.node.confidence).toBe("attested");
  }, 60_000);
});

describe("decided-but-unbuilt", () => {
  const decision = issue({
    number: 2,
    state: "closed",
    title: "Runtime foundation",
    comment_count: 1,
    comments: [
      {
        id: 999,
        body: "## Resolution: adopt it\n\nSee #26 for the work.",
        created_at: "x",
        updated_at: "x",
        author: "u",
        bytes: 10,
      },
    ],
  });

  it("emits one candidate per open ticket, not one per decision citing it", async () => {
    // Nine decisions citing one ticket produced nine candidates sharing an id.
    const many = Array.from({ length: 4 }, (_, i) =>
      issue({
        number: 10 + i,
        state: "closed",
        comment_count: 1,
        comments: [
          { id: 100 + i, body: "## Resolution: x\n\nSee #26.", created_at: "x", updated_at: "x", author: "u", bytes: 5 },
        ],
      }),
    );
    const open = issue({ number: 26, title: "Second language adapter" });
    const ctx = contextFor({ "A.java": "class A {}\n" }, [...many, open]);
    const found = await candidatesFrom("decided-but-unbuilt", ctx);
    // Cited by four decisions, so it reads as a hub rather than a task.
    expect(found).toEqual([]);
  }, 60_000);

  it("skips a hub that every decision points at", async () => {
    const map = issue({ number: 1, title: "the way to a build-ready spec" });
    const decisions = Array.from({ length: 5 }, (_, i) =>
      issue({
        number: 20 + i,
        state: "closed",
        comment_count: 1,
        comments: [
          { id: 200 + i, body: "## Resolution: x\n\nPart of the map: #1", created_at: "x", updated_at: "x", author: "u", bytes: 5 },
        ],
      }),
    );
    const ctx = contextFor({ "A.java": "class A {}\n" }, [map, ...decisions]);
    expect((await candidatesFrom("decided-but-unbuilt", ctx)).map((c) => c.node.id)).not.toContain(
      "e-unbuilt-1",
    );
  }, 60_000);

  it("emits a candidate for an open ticket with a checkable name", async () => {
    const open = issue({ number: 26, title: "Second language adapter" });
    const ctx = contextFor({ "A.java": "class A {}\n" }, [decision, open]);
    const found = await candidatesFrom("decided-but-unbuilt", ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.node.id).toBe("e-unbuilt-26");
    expect(found[0]!.claims?.[0]?.expect).toBe("absent");
  }, 60_000);
});

/* ------------------------------------------------------------ the gate */

describe("the existence gate overturns the record in BOTH directions", () => {
  const openTicket = issue({ number: 26, title: "Second language adapter" });

  it("confirms when the tree agrees that the thing is not built", async () => {
    const ctx = contextFor({ "Unrelated.java": "class Unrelated {}\n" }, [openTicket]);
    const [candidate] = await candidatesFrom("decided-but-unbuilt", ctx);
    const result = gateCandidate(ctx, candidate!);
    expect(result.verdict).toBe("confirmed");
    expect(result.node.type === "edge" && result.node.kind).toBe("unbuilt");
  }, 60_000);

  it("OVERTURNS when the tree shows the open ticket is in fact built", async () => {
    // #7's live finding: an open ticket is not evidence of absence. The
    // single-direction gate takes the record's word and gets this wrong.
    const ctx = contextFor(
      { "LanguageAdapterRegistry.java": "class LanguageAdapterRegistry {}\n" },
      [openTicket],
    );
    const [candidate] = await candidatesFrom("decided-but-unbuilt", ctx);
    const result = gateCandidate(ctx, candidate!);
    expect(result.verdict).toBe("overturned");
    // A confirmed contradiction survives as a divergence edge rather than being
    // dropped: the record and the build disagreeing is the finding.
    expect(result.node.type).toBe("edge");
    expect(result.node.type === "edge" && result.node.kind).toBe("divergence");
    expect(result.node.evidence.length).toBeGreaterThan(1);
  }, 60_000);

  it("re-checks a divergence the SAME way the probe decided it, not by a looser proxy", async () => {
    // The probe reads declared dependency NAMES; the gate must too. A tech named
    // only in an XML comment (docker, in a note about Testcontainers) is not a
    // declaration, so the divergence stands rather than being overturned by a
    // substring hit the probe never counted.
    const ctx = contextFor({
      "README.md": "Runs with Docker via Testcontainers.\n",
      "pom.xml":
        "<project><dependencies><dependency><artifactId>testcontainers</artifactId></dependency></dependencies>" +
        "<!-- docker connectivity for testcontainers --></project>\n",
    });
    const [candidate] = await candidatesFrom("dependency-divergence", ctx);
    expect(candidate).toBeDefined();
    expect(gateCandidate(ctx, candidate!).verdict).toBe("confirmed");
  }, 60_000);

  it("overturns a divergence when the manifest really does declare the tech", async () => {
    // The mirror case: if the build file declares it, the README does not
    // diverge and the gate says so.
    const ctx = contextFor({
      "README.md": "Runs with Docker via Testcontainers.\n",
      "pom.xml":
        "<project><dependencies><dependency><artifactId>testcontainers</artifactId></dependency></dependencies></project>\n",
    });
    // testcontainers is declared, so the probe never emits a docker divergence;
    // build one by hand to exercise the overturn path against a real declaration.
    const candidate: Candidate = {
      probe_id: "dependency-divergence",
      claims: [{ description: "docker is named but declared nowhere", expect: "absent", declares: ["testcontainers"] }],
      node: {
        type: "edge",
        kind: "divergence",
        id: "e-divergence-testcontainers",
        title: "t",
        statement: "s",
        why_it_matters: "w",
        how_to_say_it: "h",
        evidence: [],
        confidence: "verified",
        interview_value: 0,
      },
    };
    expect(gateCandidate(ctx, candidate).verdict).toBe("overturned");
  }, 60_000);

  it("requires ADJACENCY, so an unrelated file does not overturn a real finding", async () => {
    // Co-occurrence anywhere in a file overturned two genuinely unbuilt tickets
    // on the reference subject. The gate saying "the tree says otherwise" about
    // something that is not built asserts a contradiction it did not establish.
    const ctx = contextFor(
      { "Notes.java": "// the language of the thing\n// an adapter elsewhere\nclass Notes {}\n" },
      [openTicket],
    );
    const [candidate] = await candidatesFrom("decided-but-unbuilt", ctx);
    expect(gateCandidate(ctx, candidate!).verdict).toBe("confirmed");
  }, 60_000);

  it("demotes rather than admits a claim nothing in the tree can settle", () => {
    const ctx = contextFor({ "A.java": "class A {}\n" });
    const candidate: Candidate = {
      probe_id: "test",
      claims: [{ description: "something unknowable", expect: "absent" }],
      node: {
        type: "edge",
        kind: "unbuilt",
        id: "e-x",
        title: "x",
        statement: "s",
        why_it_matters: "w",
        how_to_say_it: "h",
        evidence: [],
        confidence: "verified",
        interview_value: 0,
      },
    };
    const result = gateCandidate(ctx, candidate);
    expect(result.verdict).toBe("unresolved");
    // A claim nobody could check must never arrive looking checked.
    expect(result.node.confidence).toBe("attested");
  }, 60_000);

  it("demotes rather than crashes on a model-authored regex that will not compile", () => {
    // Claims now come from model output, so a malformed pattern is reachable
    // input, not a code bug. It must never throw out of the gate, and must never
    // pass as though the tree had been searched.
    const ctx = contextFor({ "A.java": "class A {}\n" });
    const candidate: Candidate = {
      probe_id: "write",
      claims: [{ description: "a Grader abstraction", expect: "present", pattern: { regex: "class (Grader" } }],
      node: {
        type: "mechanism",
        id: "m-bad-regex",
        title: "x",
        what: "w",
        why_interesting: "y",
        enforcement: "type-level",
        gotchas: [],
        evidence: [],
        confidence: "verified",
        interview_value: 0,
      },
    };
    const result = gateCandidate(ctx, candidate);
    expect(result.verdict).toBe("unresolved");
    expect(result.node.confidence).toBe("attested");
    // The finding names the pattern that would not compile.
    expect(result.finding).toContain("class (Grader");
  }, 60_000);

  it("demotes on a malformed include filter, not only a malformed regex", () => {
    const ctx = contextFor({ "A.java": "class A {}\n" });
    const candidate: Candidate = {
      probe_id: "write",
      claims: [
        {
          description: "a Grader abstraction",
          expect: "present",
          pattern: { regex: "class Grader", include: "src/**[" },
        },
      ],
      node: {
        type: "mechanism",
        id: "m-bad-include",
        title: "x",
        what: "w",
        why_interesting: "y",
        enforcement: "type-level",
        gotchas: [],
        evidence: [],
        confidence: "verified",
        interview_value: 0,
      },
    };
    const result = gateCandidate(ctx, candidate);
    expect(result.verdict).toBe("unresolved");
    expect(result.node.confidence).toBe("attested");
    expect(result.finding).toContain("src/**[");
  }, 60_000);

  it("passes through a candidate grounded in what the probe already read", () => {
    const ctx = contextFor({ "A.java": "class A {}\n" });
    const candidate: Candidate = {
      probe_id: "test",
      node: {
        type: "mechanism",
        id: "m-x",
        title: "x",
        what: "w",
        why_interesting: "y",
        enforcement: "type-level",
        gotchas: [],
        evidence: [],
        confidence: "verified",
        interview_value: 0,
      },
    };
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
    expect(gate(ctx, [candidate])).toHaveLength(1);
  }, 60_000);
});

describe("unresolved-references", () => {
  // #6 point 3 and #10's sharpest reason for the degradation subject: source
  // citing a bare issue number the record never explains must be reported as
  // referenced-but-unresolved, never given a synthesised rationale.
  const CITING = {
    "src/Ssl.java": "class Ssl {\n  // look at variable declaration why this line exists and #190\n  int x;\n}\n",
  };

  it("mints a coverage_gap edge for a citation the record does not resolve", async () => {
    const ctx = contextFor(CITING);
    const found = await candidatesFrom("unresolved-references", ctx);
    expect(found).toHaveLength(1);
    const node = found[0]!.node;
    expect(node.type).toBe("edge");
    expect(node.type === "edge" && node.kind).toBe("coverage_gap");
    expect(node.id).toBe("e-unresolved-190");
    expect(node.type === "edge" && node.statement).toContain("does not resolve it");
  });

  it("cites where the reference is, with the line, pinned at the SHA", async () => {
    const ctx = contextFor(CITING);
    const [candidate] = await candidatesFrom("unresolved-references", ctx);
    const file = candidate!.node.evidence.find((e) => e.kind === "file");
    expect(file!.kind === "file" && file!.path).toBe("src/Ssl.java");
    expect(file!.kind === "file" && file!.line_start).toBe(2);
    expect(file!.kind === "file" && file!.sha).toBe(ctx.sha);
  });

  it("says nothing about an issue the harvest does not hold", async () => {
    // A citation to an issue nobody fetched would not resolve, and #8's L3 would
    // be right to fail it, so only the source location is cited.
    const ctx = contextFor(CITING);
    const [candidate] = await candidatesFrom("unresolved-references", ctx);
    expect(candidate!.node.evidence.some((e) => e.kind === "issue")).toBe(false);
    expect(candidate!.node.type === "edge" && candidate!.node.statement).toContain("no issue with that number was harvested");
  });

  it("cites the issue, and says it carries no resolution, when the harvest holds it", async () => {
    const ctx = contextFor(CITING, [issue({ number: 190, state: "closed" })]);
    const [candidate] = await candidatesFrom("unresolved-references", ctx);
    expect(candidate!.node.evidence.some((e) => e.kind === "issue")).toBe(true);
    expect(candidate!.node.type === "edge" && candidate!.node.statement).toContain("no resolution-shaped comment");
  });

  it("stays silent about a citation the record DOES resolve", async () => {
    // A decision node already carries that trail; reporting it here too would
    // double-count the same record.
    const resolved = issue({
      number: 190,
      state: "closed",
      comments: [
        { id: 1, body: "## Resolution: because of X", created_at: "x", updated_at: "x", author: "u", bytes: 24 },
      ],
    });
    expect(await candidatesFrom("unresolved-references", contextFor(CITING, [resolved]))).toEqual([]);
  });

  it("emits nothing when no source cites an issue at all", async () => {
    expect(await candidatesFrom("unresolved-references", contextFor({ "src/A.java": "class A {}\n" }))).toEqual([]);
  });

  it("does not read a bare number outside a comment as a citation", async () => {
    // The same rule the density signal uses, read from one definition so the
    // measured signal and this finding cannot disagree about the same file.
    const ctx = contextFor({ "src/A.java": 'class A { String s = "#190"; }\n' });
    expect(await candidatesFrom("unresolved-references", ctx)).toEqual([]);
  });
});

describe("an overturned present-claim cites the search that came back empty", () => {
  // Audit check E2 refuses a node that states current behaviour while citing only
  // a record of intent, and a divergence edge from an overturned present-claim
  // has no file to point at - not finding the thing IS the finding. What
  // established it is a negative search result, which #8's M2 recognises as
  // witnessing absence, so the gate cites the search it actually performed.
  const candidate = (claim: ExistenceClaim): Candidate => ({
    probe_id: "write",
    node: {
      type: "decision",
      id: "d-1",
      title: "t",
      question: "q",
      decision: "d",
      why: "w",
      rejected: [],
      status: "decided",
      implemented_by: [],
      soundbite: "s",
      evidence: [{ kind: "issue", number: 10, comment_id: 1 }],
      confidence: "attested",
      interview_value: 0,
    },
    claims: [claim],
  });

  it("cites a runnable grep at the pinned SHA when a pattern found nothing", async () => {
    const ctx = contextFor({ "README.md": "nothing relevant here" });
    const result = gateCandidate(ctx, candidate({
      description: "an order_items table",
      expect: "present",
      pattern: { regex: "order_items" },
    }));
    expect(result.verdict).toBe("overturned");
    const command = result.node.evidence.find((e) => e.kind === "command");
    expect(command).toBeDefined();
    // Faithful and reproducible: the same search, at the same commit, in a form a
    // reader can actually run. A cited command that was never run would be a
    // fabricated citation, which is the defect one level down from the one this
    // evidence exists to fix.
    expect(command!.kind === "command" && command!.cmd).toContain(ctx.sha);
    expect(command!.kind === "command" && command!.cmd).toContain("order_items");
    expect(command!.kind === "command" && command!.output_excerpt).toMatch(/no file .* matches/);
    // No include, so the whole tree was searched: the command is unscoped and the
    // excerpt may speak universally.
    expect(command!.kind === "command" && command!.cmd).not.toContain("ls-tree");
  });

  it("cites the path check when a path claim found nothing", async () => {
    const ctx = contextFor({ "README.md": "x" });
    const result = gateCandidate(ctx, candidate({
      description: "a session controller",
      expect: "present",
      paths: ["src/main/java/Session.java"],
    }));
    const command = result.node.evidence.find((e) => e.kind === "command");
    expect(command!.kind === "command" && command!.cmd).toContain("git ls-tree");
    expect(command!.kind === "command" && command!.cmd).toContain("Session.java");
  });

  it("carries the path filter IN the runnable command, not a side note, so it searches exactly what the gate searched", async () => {
    // The gate restricted to files whose PATH matches `include`; an unscoped grep
    // searches a superset and can return matches from excluded files, which would
    // contradict the excerpt - the fabricated-citation failure one level down. The
    // filter lives in the command and the excerpt names the scope, not a side note.
    const ctx = contextFor({ "README.md": "x" });
    const result = gateCandidate(ctx, candidate({
      description: "a thing",
      expect: "present",
      pattern: { regex: "Grader", include: "\\.java$" },
    }));
    const command = result.node.evidence.find((e) => e.kind === "command");
    expect(command!.kind === "command" && command!.cmd).toBe(
      `git grep -I -i -E 'Grader' ${ctx.sha} -- $(git ls-tree -r --name-only ${ctx.sha} | grep -E '\\.java$')`,
    );
    expect(command!.kind === "command" && command!.output_excerpt).toBe(
      "(no output: no file whose path matches /\\.java$/ contains this pattern at this commit)",
    );
    expect(command!.kind === "command" && command!.note).toBeUndefined();
  });

  it("keeps citing the files when an ABSENT claim was overturned by finding them", async () => {
    // The mirror case still has something to point at, so it points at it.
    const ctx = contextFor({ "src/Security.java": "class Security {}" });
    const result = gateCandidate(ctx, candidate({
      description: "no security layer",
      expect: "absent",
      paths: ["src/Security.java"],
    }));
    expect(result.verdict).toBe("overturned");
    const file = result.node.evidence.find((e) => e.kind === "file");
    expect(file!.kind === "file" && file!.path).toBe("src/Security.java");
    expect(result.node.evidence.some((e) => e.kind === "command")).toBe(false);
  });
});

describe("a decision the gate found is a decision the artifact may call built", () => {
  const decision = (claims?: ExistenceClaim[]): Candidate => ({
    probe_id: "write",
    node: {
      type: "decision",
      id: "d-issue-6",
      title: "Grader/Runner split",
      question: "q",
      decision: "d",
      why: "w",
      rejected: [],
      // What the write stage emits, and must: a resolution comment states what
      // was decided, never that it was built.
      status: "decided",
      implemented_by: [],
      soundbite: "s",
      evidence: [{ kind: "issue", number: 6, comment_id: 1 }],
      confidence: "attested",
      interview_value: 0,
    },
    ...(claims === undefined ? {} : { claims }),
  });

  it("promotes on a confirmed present-claim and records where it looked", async () => {
    const ctx = contextFor({ "src/main/java/Grader.java": "interface Grader {}" });
    const result = gateCandidate(ctx, decision([
      { description: "a Grader abstraction", expect: "present", paths: ["src/main/java/Grader.java"] },
    ]));
    const node = result.node as DecisionNode;
    expect(result.verdict).toBe("confirmed");
    expect(node.status).toBe("decided_and_built");
    // The gate's own reading, pinned - never a path the writer proposed.
    expect(node.implemented_by).toEqual([
      { kind: "file", path: "src/main/java/Grader.java", sha: ctx.sha },
    ]);
    expect(result.finding).toContain("src/main/java/Grader.java");
  });

  it("leaves a decision alone when nothing was asked of the tree", async () => {
    // `decided` is the honest state for a decision no claim was checked for.
    // Promoting one would be asserting an implementation nobody verified, which
    // is the failure the promotion exists to avoid rather than commit.
    const ctx = contextFor({ "src/main/java/Grader.java": "interface Grader {}" });
    const node = gateCandidate(ctx, decision()).node as DecisionNode;
    expect(node.status).toBe("decided");
    expect(node.implemented_by).toEqual([]);
  });

  it("settles a confirmed ABSENT claim to decided_not_built with empty implemented_by", async () => {
    // The mirror of promotion: the gate confirmed the decision is not built, which
    // is a settlement the gate alone may make. implemented_by stays empty per #8's
    // E2 - confirming a thing is not there is never a citation of where it is built.
    const ctx = contextFor({ "README.md": "no statements here" });
    const result = gateCandidate(
      ctx,
      decision([{ description: "no problem prose", expect: "absent", paths: ["statements/"] }]),
    );
    const node = result.node as DecisionNode;
    expect(result.verdict).toBe("confirmed");
    expect(node.status).toBe("decided_not_built");
    expect(node.implemented_by).toEqual([]);
  });

  it("leaves a superseded decision alone even when the tree confirms its claim", async () => {
    // `superseded` is a statement about the decision's standing, not its build
    // state. Stale code a later decision has not yet removed is exactly what one
    // would expect to find, never grounds to relabel the node `decided_and_built`.
    const ctx = contextFor({ "src/main/java/Grader.java": "interface Grader {}" });
    const node: DecisionNode = { ...(decision().node as DecisionNode), status: "superseded" };
    const result = gateCandidate(ctx, {
      probe_id: "write",
      node,
      claims: [
        { description: "a Grader abstraction", expect: "present", paths: ["src/main/java/Grader.java"] },
      ],
    });
    const out = result.node as DecisionNode;
    expect(result.verdict).toBe("confirmed");
    expect(out.status).toBe("superseded");
    expect(out.implemented_by).toEqual([]);
  });

  it("does not promote a decision the tree overturned", async () => {
    const ctx = contextFor({ "README.md": "x" });
    const result = gateCandidate(ctx, decision([
      { description: "a Grader abstraction", expect: "present", paths: ["src/main/java/Grader.java"] },
    ]));
    expect(result.verdict).toBe("overturned");
    expect(result.node.type).toBe("edge");
  });

  it("records each path once when two claims land on the same file", async () => {
    const ctx = contextFor({ "src/main/java/Grader.java": "interface Grader {}" });
    const node = gateCandidate(ctx, decision([
      { description: "a Grader", expect: "present", paths: ["src/main/java/Grader.java"] },
      { description: "the same file again", expect: "present", paths: ["src/main/java/Grader.java"] },
    ])).node as DecisionNode;
    expect(node.implemented_by).toHaveLength(1);
  });

  it("leaves a non-decision node's fields alone", async () => {
    const ctx = contextFor({ "src/main/java/Grader.java": "interface Grader {}" });
    const candidate: Candidate = {
      probe_id: "p",
      node: {
        type: "mechanism",
        id: "m-1",
        title: "x",
        what: "w",
        why_interesting: "y",
        enforcement: "type-level",
        gotchas: [],
        evidence: [],
        confidence: "verified",
        interview_value: 0,
      },
      claims: [
        { description: "a Grader", expect: "present", paths: ["src/main/java/Grader.java"] },
      ],
    };
    const result = gateCandidate(ctx, candidate);
    expect(result.verdict).toBe("confirmed");
    expect(result.node).toEqual(candidate.node);
  });
});

/* --------------------------- #22: the boundary and coverage-gap producers */

describe("orthogonal-hierarchies", () => {
  // The reference overview's `Response ⟂ Grading`. Two sealed hierarchies and a
  // carrier holding one of each is a statement that the two vary independently -
  // a relationship neither declaration carries on its own, which is why
  // `sealed-hierarchies` reporting both closed sets could never mint it.
  const subject = {
    "e/Response.java": "package e;\nsealed interface Response permits Code, Choice, FreeText {}\n",
    "e/Grading.java": "package e;\nsealed interface Grading permits TestCases, AnswerKey {}\n",
    "e/Exercise.java": "package e;\nrecord Exercise(String id, Response response, Grading grading) {}\n",
  };

  it("finds two closed sets one type holds one of each of", async () => {
    const found = await candidatesFrom("orthogonal-hierarchies", contextFor(subject));
    expect(found).toHaveLength(1);
    const node = found[0]!.node;
    expect(node.type).toBe("boundary");
    expect(node.title).toBe("Grading ⟂ Response");
    // The product is arithmetic on two lengths read out of the tree, not a claim
    // about design intent: 2 permitted graders times 3 permitted responses.
    expect(node.type === "boundary" && node.enforced_by).toContain("all 6 pairings");
    expect(node.type === "boundary" && node.enforced_by).toContain("Exercise holds one of each");
    // Structural: two permits clauses and a record's own components (#28).
    expect(node.confidence).toBe("verified");
    // All three readings are cited, so a reader sees the relationship itself.
    expect(node.evidence.map((e) => (e.kind === "file" ? e.path : ""))).toEqual([
      "e/Grading.java",
      "e/Response.java",
      "e/Exercise.java",
    ]);
  }, 60_000);

  it("draws nothing when no type holds one of each", async () => {
    // Two closed sets that never meet decided nothing together. Emitting a
    // boundary for every pair of sealed types in a subject would be the probe
    // inventing the relationship rather than reading it.
    const found = await candidatesFrom(
      "orthogonal-hierarchies",
      contextFor({
        "e/Response.java": "package e;\nsealed interface Response permits Code, Choice {}\n",
        "e/Grading.java": "package e;\nsealed interface Grading permits TestCases, AnswerKey {}\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("refuses a pair where one hierarchy is a case of the other", async () => {
    // `Outer permits Inner` and `Inner permits ...` is ONE design axis wearing two
    // names. Calling it orthogonal would be exactly backwards, so the overlap and
    // containment guards drop it even with a carrier holding both.
    const found = await candidatesFrom(
      "orthogonal-hierarchies",
      contextFor({
        "e/Outer.java": "package e;\nsealed interface Outer permits Inner, Other {}\n",
        "e/Inner.java": "package e;\nsealed interface Inner extends Outer permits A, B {}\n",
        "e/Holder.java": "package e;\nrecord Holder(Outer outer, Inner inner) {}\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("sees through a qualified permits clause when checking containment", async () => {
    // A `permits` clause may name its members qualified. Comparing the clause
    // text verbatim would let `permits e.Inner` slip past a check looking for
    // `Inner`, and one hierarchy that is a CASE of the other would then be drawn
    // as orthogonal to it - exactly backwards.
    const found = await candidatesFrom(
      "orthogonal-hierarchies",
      contextFor({
        "e/Outer.java": "package e;\nsealed interface Outer permits e.Inner, e.Other {}\n",
        "e/Inner.java": "package e;\nsealed interface Inner extends Outer permits e.A, e.B {}\n",
        "e/Holder.java": "package e;\nrecord Holder(Outer outer, Inner inner) {}\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("does not count a collection of one side as holding one", async () => {
    // A type holding `List<Response>` is not answered by one response, so the
    // "every pairing is expressible" sentence would not follow from it. `holds`
    // strips generics to the base name, which is `List`, not `Response`.
    const found = await candidatesFrom(
      "orthogonal-hierarchies",
      contextFor({
        "e/Response.java": "package e;\nsealed interface Response permits Code, Choice {}\n",
        "e/Grading.java": "package e;\nsealed interface Grading permits TestCases, AnswerKey {}\n",
        "e/Bundle.java": "package e;\nrecord Bundle(java.util.List<Response> responses, Grading grading) {}\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("ignores a carrier that only exists in the tests", async () => {
    // A fixture wiring two hierarchies together is a test's convenience, not a
    // boundary the subject drew - the same discrimination that keeps the three
    // test-class asymmetries out of this section.
    const found = await candidatesFrom(
      "orthogonal-hierarchies",
      contextFor({
        "e/Response.java": "package e;\nsealed interface Response permits Code, Choice {}\n",
        "e/Grading.java": "package e;\nsealed interface Grading permits TestCases, AnswerKey {}\n",
        "test/e/Fixture.java": "package e;\nrecord Fixture(Response response, Grading grading) {}\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);
});

describe("partitioned-implementations", () => {
  // The reference overview's `Grader ⟂ Runner`. The finding is not that one
  // implementation executes code - it is that the others hold NOTHING from the
  // package that does, and the interface never asked them to.
  const subject = {
    "g/Grader.java": "package g;\ninterface Grader { void grade(); }\n",
    "g/TestCaseGrader.java": "package g;\nclass TestCaseGrader implements Grader { private RunnerRegistry runners; public void grade() {} }\n",
    "g/AnswerKeyGrader.java": "package g;\nclass AnswerKeyGrader implements Grader { private ObjectMapper mapper; public void grade() {} }\n",
    "g/SelfCheckGrader.java": "package g;\nclass SelfCheckGrader implements Grader { public void grade() {} }\n",
    "r/RunnerRegistry.java": "package r;\nclass RunnerRegistry {}\n",
  };

  it("splits an implementation set on a package rather than on a single field", async () => {
    const found = await candidatesFrom("partitioned-implementations", contextFor(subject));
    expect(found).toHaveLength(1);
    const node = found[0]!.node;
    expect(node.title).toBe("Grader ⟂ r");
    expect(node.type === "boundary" && node.enforced_by).toContain("1 of the 3 types implementing Grader holds");
    expect(node.type === "boundary" && node.enforced_by).toContain("AnswerKeyGrader, SelfCheckGrader hold nothing");
    expect(node.confidence).toBe("verified");
    // Every implementation is cited, so the partition can be checked either way.
    const cited = node.evidence.map((e) => (e.kind === "file" ? e.path : "")).sort();
    expect(cited).toContain("g/AnswerKeyGrader.java");
    expect(cited).toContain("g/TestCaseGrader.java");
  }, 60_000);

  it("says nothing when the package is a requirement rather than a boundary", async () => {
    // Every implementation holding something from the package means the
    // abstraction requires it. That is a dependency, and a boundary drawn over it
    // would assert a freedom the subject does not have.
    const found = await candidatesFrom(
      "partitioned-implementations",
      contextFor({
        "g/Grader.java": "package g;\ninterface Grader { void grade(); }\n",
        "g/A.java": "package g;\nclass A implements Grader { private RunnerRegistry r; public void grade() {} }\n",
        "g/B.java": "package g;\nclass B implements Grader { private RunnerRegistry r; public void grade() {} }\n",
        "g/C.java": "package g;\nclass C implements Grader { private RunnerRegistry r; public void grade() {} }\n",
        "r/RunnerRegistry.java": "package r;\nclass RunnerRegistry {}\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("leaves a lone dissenter to dependency-asymmetry", async () => {
    // Three of four holding and one not is the odd-one-out shape another probe
    // already reports. Emitting it here too would be the same finding in two
    // vocabularies, which the candidate-finding guard exists to catch.
    const found = await candidatesFrom(
      "partitioned-implementations",
      contextFor({
        "g/Grader.java": "package g;\ninterface Grader { void grade(); }\n",
        "g/A.java": "package g;\nclass A implements Grader { private RunnerRegistry r; public void grade() {} }\n",
        "g/B.java": "package g;\nclass B implements Grader { private RunnerRegistry r; public void grade() {} }\n",
        "g/C.java": "package g;\nclass C implements Grader { public void grade() {} }\n",
        "r/RunnerRegistry.java": "package r;\nclass RunnerRegistry {}\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("needs three implementations before a split is a rule", async () => {
    const found = await candidatesFrom(
      "partitioned-implementations",
      contextFor({
        "g/Grader.java": "package g;\ninterface Grader { void grade(); }\n",
        "g/A.java": "package g;\nclass A implements Grader { private RunnerRegistry r; public void grade() {} }\n",
        "g/B.java": "package g;\nclass B implements Grader { public void grade() {} }\n",
        "r/RunnerRegistry.java": "package r;\nclass RunnerRegistry {}\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("does not draw a boundary against the abstraction's own package", async () => {
    // Implementations holding a sibling from the package they live in have not
    // crossed a line the subject drew.
    const found = await candidatesFrom(
      "partitioned-implementations",
      contextFor({
        "g/Grader.java": "package g;\ninterface Grader { void grade(); }\n",
        "g/Helper.java": "package g;\nclass Helper {}\n",
        "g/A.java": "package g;\nclass A implements Grader { private Helper h; public void grade() {} }\n",
        "g/B.java": "package g;\nclass B implements Grader { public void grade() {} }\n",
        "g/C.java": "package g;\nclass C implements Grader { public void grade() {} }\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);
});

describe("superset-enum", () => {
  // The reference overview's `Machine verdict ⟂ self-rating`. The extra constant
  // is a boundary written into the type system: a value typed as the narrower
  // enum structurally cannot carry it.
  const subject = {
    "g/Verdict.java": "package g;\nclass Verdict { enum Outcome { PASSED, FAILED, ERROR } }\n",
    "a/SubmissionOutcome.java":
      "package a;\nimport g.Verdict;\nenum SubmissionOutcome { PASSED, FAILED, ERROR, SELF_RATED }\n",
  };

  it("names the constants one set has and the other cannot", async () => {
    const found = await candidatesFrom("superset-enum", contextFor(subject));
    expect(found).toHaveLength(1);
    const node = found[0]!.node;
    expect(node.title).toBe("SubmissionOutcome ⟂ Verdict.Outcome");
    expect(node.type === "boundary" && node.enforced_by).toContain("1 more: SELF_RATED");
    expect(node.type === "boundary" && node.enforced_by).toContain("can never carry SELF_RATED");
    expect(node.confidence).toBe("verified");
  }, 60_000);

  it("refuses two enums that share a spelling but never meet in the source", async () => {
    // Small vocabularies collide by accident: PASSED/FAILED/ERROR is a spelling
    // many enums reach for. Without the wider enum's file naming the narrower one,
    // the two decided nothing together and the superset is a coincidence.
    const found = await candidatesFrom(
      "superset-enum",
      contextFor({
        "g/Verdict.java": "package g;\nclass Verdict { enum Outcome { PASSED, FAILED, ERROR } }\n",
        "a/SubmissionOutcome.java": "package a;\nenum SubmissionOutcome { PASSED, FAILED, ERROR, SELF_RATED }\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("is not satisfied by a javadoc cross-reference alone", async () => {
    // A comment mentioning the other enum is prose, not a declaration that the
    // two are related - the same reason `reachability.ts` masks comments before
    // deciding what a file can reach.
    const found = await candidatesFrom(
      "superset-enum",
      contextFor({
        "g/Verdict.java": "package g;\nclass Verdict { enum Outcome { PASSED, FAILED, ERROR } }\n",
        "a/SubmissionOutcome.java":
          "package a;\n/** A superset of g.Verdict.Outcome. */\nenum SubmissionOutcome { PASSED, FAILED, ERROR, SELF_RATED }\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);

  it("says nothing about two sets that merely overlap", async () => {
    const found = await candidatesFrom(
      "superset-enum",
      contextFor({
        "g/Verdict.java": "package g;\nenum Outcome { PASSED, FAILED, ERROR }\n",
        "a/Other.java": "package a;\nimport g.Outcome;\nenum Other { PASSED, FAILED, SKIPPED, PENDING }\n",
      }),
    );
    expect(found).toEqual([]);
  }, 60_000);
});

describe("self-disabling-tests", () => {
  // The reference overview's "The real content is never verified in CI". A JUnit
  // assumption aborts its test rather than failing it, so a suite reports the
  // same colour whether the test exercised anything or not.
  const guarded =
    "package c;\n" +
    "import static org.junit.jupiter.api.Assumptions.assumeTrue;\n" +
    "import org.junit.jupiter.api.Test;\n" +
    "class RealContentSmokeTest {\n" +
    "    @Test\n" +
    "    void everyRealExerciseSolves() {\n" +
    "        Path dir = contentDir();\n" +
    "        assumeTrue(Files.isDirectory(dir), \"no local content clone\");\n" +
    "    }\n" +
    "    @Test\n" +
    "    void alwaysRuns() { assertTrue(true); }\n" +
    "}\n";

  it("names the tests that abort themselves, and how many of the class's tests they are", async () => {
    const found = await candidatesFrom(
      "self-disabling-tests",
      contextFor({ "src/test/java/c/RealContentSmokeTest.java": guarded }),
    );
    expect(found).toHaveLength(1);
    const node = found[0]!.node;
    expect(node.type === "edge" && node.kind).toBe("coverage_gap");
    expect(node.type === "edge" && node.statement).toContain("1 of RealContentSmokeTest's 2 tests");
    expect(node.type === "edge" && node.statement).toContain("everyRealExerciseSolves");
    // The unguarded test is not named as one that aborts.
    expect(node.type === "edge" && node.statement).not.toContain("alwaysRuns");
    expect(node.confidence).toBe("verified");
    // The import is cited beside the guards: it is what makes the call JUnit's.
    expect(node.evidence[0]!.kind === "file" && node.evidence[0]!.note).toContain("assumption import");
  }, 60_000);

  it("emits one candidate per class, not one per guarded test", async () => {
    const both =
      "package c;\n" +
      "import static org.junit.jupiter.api.Assumptions.assumeTrue;\n" +
      "import org.junit.jupiter.api.Test;\n" +
      "class TwoGuarded {\n" +
      "    @Test void a() { assumeTrue(here()); }\n" +
      "    @Test void b() { assumeTrue(here()); }\n" +
      "}\n";
    const found = await candidatesFrom(
      "self-disabling-tests",
      contextFor({ "src/test/java/c/TwoGuarded.java": both }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.node.type === "edge" && found[0]!.node.statement).toContain("2 of TwoGuarded's 2 tests");
    expect(found[0]!.node.type === "edge" && found[0]!.node.statement).toContain("all of them");
  }, 60_000);

  it("will not call a subject's own assumeTrue a JUnit guard", async () => {
    // Without the import the identifier is one this subject could have declared,
    // and "this test aborts" would be a judgement read out of a name rather than
    // the name itself - the #28 defect exactly.
    const own =
      "package c;\n" +
      "import org.junit.jupiter.api.Test;\n" +
      "class OwnHelper {\n" +
      "    @Test void a() { assumeTrue(here()); }\n" +
      "    private static void assumeTrue(boolean b) {}\n" +
      "}\n";
    expect(
      await candidatesFrom("self-disabling-tests", contextFor({ "src/test/java/c/OwnHelper.java": own })),
    ).toEqual([]);
  }, 60_000);

  it("does not read an annotation out of a comment or a string", async () => {
    // A raw-line scan for `@Test` matches both, which is how a YAML comment once
    // minted a verified CI mechanism (#28). The annotation is read off the
    // method's own modifiers instead.
    const commented =
      "package c;\n" +
      "import static org.junit.jupiter.api.Assumptions.assumeTrue;\n" +
      "class Commented {\n" +
      "    // @Test void ghost() { assumeTrue(false); }\n" +
      "    String doc = \"@Test\";\n" +
      "    void helper() { assumeTrue(false); }\n" +
      "}\n";
    expect(
      await candidatesFrom("self-disabling-tests", contextFor({ "src/test/java/c/Commented.java": commented })),
    ).toEqual([]);
  }, 60_000);

  it("looks only at test paths", async () => {
    expect(
      await candidatesFrom("self-disabling-tests", contextFor({ "src/main/java/c/NotATest.java": guarded })),
    ).toEqual([]);
  }, 60_000);
});

describe("measured-scale", () => {
  // The stat tiles the reference overview opens with, which no stage produced.
  // Every figure was already measured by harvest; this restates them and cites
  // the command that produces each, because a stat tile is the easiest place in
  // an artifact to put a number nobody checked.
  const withScale = (over: Record<string, unknown>): ProbeContext => {
    const ctx = contextFor({
      "src/main/java/A.java": "class A {}\n",
      "src/test/java/ATest.java": "class ATest {}\n",
    });
    return { ...ctx, harvest: { ...ctx.harvest, scale: { ...ctx.harvest.scale, ...over } } };
  };

  it("emits a tile per figure the harvest established", async () => {
    const found = await candidatesFrom("measured-scale", withScale({ lines: 13574, commits: 47, days: 7 }));
    const ids = found.map((c) => c.node.id);
    expect(ids).toContain("f-scale-lines");
    expect(ids).toContain("f-scale-files");
    expect(ids).toContain("f-scale-history");
    expect(ids).toContain("f-scale-tests");
  });

  it("states a test-line figure only after reconciling its reading with the harvest's", async () => {
    // `harvest.scale` carries production lines only, so this is the one tile the
    // probe MEASURES rather than restates - and measuring would break the
    // module's guarantee unless the two readings of "a line" agree. They are
    // checked against each other: the same helper over the production selection
    // must reproduce `scale.lines`, or no test-line figure is stated at all.
    const ctx = contextFor({
      "src/main/java/A.java": "one\ntwo\nthree\n",
      "src/test/java/ATest.java": "one\ntwo\n",
    });
    const reconciled = { ...ctx, harvest: { ...ctx.harvest, scale: { ...ctx.harvest.scale, lines: 3 } } };
    const tile = (await candidatesFrom("measured-scale", reconciled)).find(
      (c) => c.node.id === "f-scale-test-lines",
    );
    expect(tile!.node.type === "fact" && tile!.node.value).toBe("2");

    // A harvest whose production figure this probe cannot reproduce means the two
    // are not counting the same thing, and a second number counted the other way
    // would be exactly the unreproducible tile this module exists to refuse.
    const drifted = { ...ctx, harvest: { ...ctx.harvest, scale: { ...ctx.harvest.scale, lines: 999 } } };
    const ids = (await candidatesFrom("measured-scale", drifted)).map((c) => c.node.id);
    expect(ids).not.toContain("f-scale-test-lines");
  });

  it("counts schema migrations off one select, like every other tile", async () => {
    const ctx = contextFor({
      "db/migration/V1__baseline.sql": "create table a();\n",
      "db/migration/V2__more.sql": "create table b();\n",
      "db/migration/README.md": "not a migration\n",
      "src/main/java/A.java": "class A {}\n",
    });
    const tile = (await candidatesFrom("measured-scale", ctx)).find(
      (c) => c.node.id === "f-scale-migrations",
    );
    // The README in the same directory is not a migration; the extension test is
    // what keeps it out, on both sides of the select.
    expect(tile!.node.type === "fact" && tile!.node.value).toBe("2");
    const ev = tile!.node.evidence[0]!;
    const cmd = ev.kind === "command" ? ev.cmd : "";
    expect(cmd).toContain(`grep -iE '${MIGRATION_PATH_ERE}'`);
    expect(cmd).toContain(`grep -iE '${MIGRATION_EXTENSION_ERE}'`);
  });

  it("says nothing about migrations in a subject that has none", async () => {
    // A "0 migrations" tile is a claim about a schema this subject may not have.
    const ctx = contextFor({ "src/main/java/A.java": "class A {}\n" });
    const ids = (await candidatesFrom("measured-scale", ctx)).map((c) => c.node.id);
    expect(ids).not.toContain("f-scale-migrations");
  });

  it("cites the command that produces each figure, at the pinned SHA", async () => {
    const ctx = withScale({ lines: 100, commits: 3, days: 1 });
    for (const c of await candidatesFrom("measured-scale", ctx)) {
      const ev = c.node.evidence[0]!;
      expect(ev.kind).toBe("command");
      expect(ev.kind === "command" && ev.cmd).toContain(ctx.sha);
      expect(c.node.type === "fact" && c.node.source).toBe("command");
    }
  });

  it("emits nothing rather than a zero for a figure that was never established", async () => {
    // "0 commits" is a claim, and an unmeasured value rendered as 0 is a false
    // one. #5's emit-nothing rule applies per figure, not only per probe.
    const found = await candidatesFrom("measured-scale", withScale({ lines: 0, commits: 0, days: null }));
    const ids = found.map((c) => c.node.id);
    expect(ids).not.toContain("f-scale-lines");
    expect(ids).not.toContain("f-scale-history");
  });

  it("reports the commit count with the window it happened in", async () => {
    // A commit count alone says nothing without the calendar span; 47 commits
    // over 7 days and over 7 years are different findings.
    const [history] = (await candidatesFrom("measured-scale", withScale({ commits: 47, days: 7 })))
      .filter((c) => c.node.id === "f-scale-history");
    expect(history!.node.type === "fact" && history!.node.label).toContain("7 calendar days");
    expect(history!.node.type === "fact" && history!.node.value).toBe("47");
  });

  it("counts tests in EVERY source language, not a narrow subset", async () => {
    // The test counter reads the one shared 'is a source file' extension set, so
    // a JS or Rust or C++ subject with tests does not silently lose its "How much
    // of it is tested" tile - a missing tile reads as "this repo has no tests",
    // which is a claim.
    for (const [prod, test] of [
      ["src/app.js", "src/app.test.js"],
      ["src/lib.rs", "tests/lib_test.rs"],
      ["src/widget.cpp", "test/widget_test.cpp"],
    ] as const) {
      const ctx = contextFor({ [prod]: "x\n", [test]: "x\n" });
      const found = await candidatesFrom("measured-scale", { ...ctx, harvest: { ...ctx.harvest, scale: { ...ctx.harvest.scale, lines: 2 } } });
      const tile = found.find((c) => c.node.id === "f-scale-tests");
      expect(tile, `${test} should produce a test tile`).toBeDefined();
      expect(tile!.node.type === "fact" && tile!.node.value).toBe("1");
    }
  });

  it("treats .test.ts and .test.js alike", async () => {
    const tsCtx = contextFor({ "a.ts": "x\n", "a.test.ts": "x\n" });
    const jsCtx = contextFor({ "a.js": "x\n", "a.test.js": "x\n" });
    const tsTests = (await candidatesFrom("measured-scale", { ...tsCtx, harvest: { ...tsCtx.harvest, scale: { ...tsCtx.harvest.scale, lines: 2 } } })).find((c) => c.node.id === "f-scale-tests");
    const jsTests = (await candidatesFrom("measured-scale", { ...jsCtx, harvest: { ...jsCtx.harvest, scale: { ...jsCtx.harvest.scale, lines: 2 } } })).find((c) => c.node.id === "f-scale-tests");
    expect(tsTests!.node.type === "fact" && tsTests!.node.value).toBe("1");
    expect(jsTests!.node.type === "fact" && jsTests!.node.value).toBe("1");
  });

  it("cites a command that selects the same set the tile's value counts", async () => {
    // A filtered tile whose command lists the WHOLE tree ships a number a reader
    // running it cannot reproduce. The audit never executes the excerpt, so the
    // command has to carry the same filters as the predicate by construction. The
    // production tiles must scope to source extensions AND out of test paths; the
    // test tile must scope to source extensions AND into test paths.
    const cmdOf = async (id: string): Promise<string> => {
      const c = (await candidatesFrom("measured-scale", withScale({ lines: 100, commits: 3, days: 1 }))).find(
        (x) => x.node.id === id,
      );
      const ev = c!.node.evidence[0]!;
      return ev.kind === "command" ? ev.cmd : "";
    };
    for (const id of ["f-scale-lines", "f-scale-files"]) {
      const cmd = await cmdOf(id);
      expect(cmd, `${id} must carry the source-extension filter`).toContain(
        `grep -iE '${SOURCE_EXTENSION_ERE}'`,
      );
      expect(cmd, `${id} must exclude test paths`).toContain(`grep -ivE '${TEST_PATH_ERE}'`);
    }
    const testsCmd = await cmdOf("f-scale-tests");
    expect(testsCmd).toContain(`grep -iE '${SOURCE_EXTENSION_ERE}'`);
    expect(testsCmd, "the test tile must keep test paths, not drop them").toContain(
      `grep -iE '${TEST_PATH_ERE}'`,
    );
    expect(testsCmd).not.toContain(`grep -ivE '${TEST_PATH_ERE}'`);
  });

  it("counts the lines tile per file so wc -l reproduces countLines", async () => {
    // `scale.lines` counts a final unterminated line as a line; a bare `wc -l`
    // over concatenated blobs counts newline bytes, under-reporting by one per
    // file lacking a trailing newline and merging its last line into the next
    // file's first. Normalising each blob through `awk 1` before the count is what
    // makes the printed command reproduce the number the tile shows, so the raw
    // concatenation form must never come back.
    const lines = (await candidatesFrom("measured-scale", withScale({ lines: 100 }))).find(
      (c) => c.node.id === "f-scale-lines",
    );
    const ev = lines!.node.evidence[0]!;
    const cmd = ev.kind === "command" ? ev.cmd : "";
    expect(cmd, "each blob must be normalised per file, not concatenated raw").toContain(
      "xargs -I{} sh -c 'git cat-file -p",
    );
    expect(cmd, "awk 1 re-emits every record newline-terminated before wc -l").toContain("awk 1");
    expect(cmd).not.toMatch(/xargs -I\{\} git cat-file -p [^|]*\| wc -l/);
  });
});
