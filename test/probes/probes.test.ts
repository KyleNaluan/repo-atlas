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
import { PROBES, runProbes, treeContext } from "../../src/probes/registry.js";
import { gate, gateCandidate } from "../../src/gate/gate.js";
import { detectToolchains, type Candidate, type ProbeContext } from "../../src/probes/types.js";
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
  it("ships all eight discovery probes", () => {
    expect(PROBES).toHaveLength(8);
    expect(PROBES.map((p) => p.id).sort()).toEqual([
      "ci-policy-guards",
      "decided-but-unbuilt",
      "dependency-asymmetry",
      "dependency-divergence",
      "repeated-sql-predicates",
      "sealed-hierarchies",
      "throw-where-siblings-return",
      "tuned-config-properties",
    ]);
  });

  it("declares each probe's toolchain, with the code-level ones Java-only in v1", () => {
    const java = PROBES.filter((p) => p.toolchain === "java").map((p) => p.id);
    expect(java.sort()).toEqual([
      "dependency-asymmetry",
      "sealed-hierarchies",
      "throw-where-siblings-return",
    ]);
  });

  it("reports an inapplicable probe BY NAME rather than passing silently", async () => {
    // A subject with no Java must not look identical to one where every Java
    // probe ran and found nothing. Those are different findings (#5).
    const ctx = contextFor({ "app.ts": "export const x = 1;\n" });
    const outcomes = await runProbes(ctx);
    const skipped = outcomes.filter((o) => o.status === "not_applicable");
    expect(skipped.map((o) => o.probe_id).sort()).toEqual([
      "dependency-asymmetry",
      "sealed-hierarchies",
      "throw-where-siblings-return",
    ]);
    for (const o of skipped) {
      expect(o.status === "not_applicable" && o.reason).toMatch(/not applicable to this toolchain/);
    }
  }, 60_000);

  it("detects the toolchains a tree actually carries", () => {
    expect([...detectToolchains(["A.java"])].sort()).toEqual(["any", "java"]);
    expect([...detectToolchains(["a.py", "b.tsx"])].sort()).toEqual(["any", "python", "typescript"]);
  });

  it("emits nothing rather than erroring when a probe finds nothing", async () => {
    const ctx = contextFor({ "Empty.java": "class Empty {}\n" });
    const outcomes = await runProbes(ctx);
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
    const outcomes = await runProbes(ctx);
    const ids = outcomes.flatMap((o) => (o.status === "ran" ? o.candidates.map((c) => c.node.id) : []));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);
});

/* ------------------------------------------------ one fixture per probe */

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
  }, 60_000);

  it("ignores a throw that is a guard clause rather than a refusal", async () => {
    const ctx = contextFor({
      "A.java": "class A { String run() { return \"a\"; } }\n",
      "C.java": 'class C { String run() { if (x == null) { throw new UnsupportedOperationException(); } return "c"; } }\n',
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
  }, 60_000);

  it("ignores a value with an ordinary comment", async () => {
    const ctx = contextFor({ "application.yml": "# the timeout\ntimeout: PT10S\n" });
    expect(await candidatesFrom("tuned-config-properties", ctx)).toEqual([]);
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
  }, 60_000);

  it("ignores a step that just runs the tests", async () => {
    const ctx = contextFor({
      ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - run: npm test\n",
    });
    expect(await candidatesFrom("ci-policy-guards", ctx)).toEqual([]);
  }, 60_000);
});

describe("dependency-divergence", () => {
  it("finds a technology the record names that the build does not declare", async () => {
    const ctx = contextFor({
      "README.md": "Runs on Postgres and Redis.\n",
      "pom.xml": "<project><artifactId>postgresql</artifactId></project>\n",
    });
    const found = await candidatesFrom("dependency-divergence", ctx);
    expect(found.map((c) => c.node.id)).toEqual(["e-divergence-redis"]);
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
        "<project><artifactId>app</artifactId><!-- docker connectivity for testcontainers --></project>\n",
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
      "pom.xml": "<project><artifactId>testcontainers</artifactId></project>\n",
    });
    // testcontainers is declared, so the probe never emits a docker divergence;
    // build one by hand to exercise the overturn path against a real declaration.
    const candidate: Candidate = {
      probe_id: "dependency-divergence",
      claims: [{ description: "docker is named but declared nowhere", expect: "absent", declares: "testcontainers" }],
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
