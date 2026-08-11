/**
 * Pass A, and the mutant fixtures that prove each gate can fail.
 *
 * The second describe block is the one #8 point 7 asks for:
 *
 * > No check ships without a mutant fixture proving it fails.
 *
 * Both halves are needed and neither is sufficient. A check that passes on a
 * clean artifact might be a check that passes on everything - the audit
 * prototype's first resolver was exactly that, reporting all 47 links missing
 * for a reason that had nothing to do with the links. Watching each gate reject
 * its own mutant, and only its own, is what tells them apart.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, truncateSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { render } from "../../src/render/render.js";
import { disposeHighlighter } from "../../src/render/highlight.js";
import { memoryDiagramCache } from "../../src/render/cache.js";
import { audit } from "../../src/audit/run.js";
import { runPassA } from "../../src/audit/pass-a.js";
import { eachEvidence, resolveFileEvidence } from "../../src/audit/checks/evidence.js";
import { blobAt } from "../../src/audit/git.js";
import { checkPreconditions } from "../../src/audit/preconditions.js";
import { checksInPass, GATES, REGISTER } from "../../src/audit/register.js";
import type { AuditContext } from "../../src/audit/types.js";
import type { Atlas, Evidence } from "../../src/schema/types.js";
import { buildPrivateCorpus, buildSyntheticSubject } from "./subject.js";
import { MUTANTS } from "../mutants/index.js";

const fixture = (name: string): Atlas =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  ) as Atlas;

let clean: AuditContext;

beforeAll(async () => {
  const subject = buildSyntheticSubject(fixture("swe-prep.atlas.json"));
  // The reference graph declares a private split; give the check something real
  // to run against so P1 is exercised in its gating state, not skipped.
  subject.atlas.record.private_source = {
    declared: true,
    repo: "KyleNaluan/swe-prep-content",
    readable_at_harvest: true,
  };
  clean = {
    artifact: await render(subject.atlas, { cache: memoryDiagramCache() }),
    atlas: subject.atlas,
    clone: subject.clone,
    privateClone: buildPrivateCorpus(),
  };
}, 120_000);

afterAll(async () => {
  await disposeHighlighter();
});

const byId = (ctx: AuditContext) => {
  const results = runPassA(ctx);
  return new Map(results.map((r) => [r.id, r]));
};

describe("the register", () => {
  it("declares twenty checks, fifteen of them hard gates", () => {
    expect(REGISTER).toHaveLength(20);
    expect(GATES).toHaveLength(15);
  });

  it("puts nine of them in pass A", () => {
    expect(checksInPass("A").map((c) => c.id)).toEqual([
      "S1",
      "L1",
      "L2",
      "L5",
      "G1",
      "G2",
      "G3",
      "E2",
      "P1",
    ]);
  });
});

describe("preconditions", () => {
  it("pass for a clean clone at the pinned SHA", () => {
    expect(checkPreconditions(clean.clone, clean.atlas.subject.sha).ok).toBe(true);
  });

  it("fail loudly when the path is not a repository at all", () => {
    // The failure this prevents: a resolver run outside the clone reports every
    // citation as missing, which reads as a broken artifact rather than a broken
    // audit - and its silently-inverted twin reports a clean pass.
    const result = checkPreconditions(mkdtempSync(join(tmpdir(), "not-a-repo-")), "0".repeat(40));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/not a git worktree/);
  });

  it("fail when HEAD is not the run's pinned SHA", () => {
    const result = checkPreconditions(clean.clone, "0".repeat(40));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/but this run is pinned to/);
  });

  it("fail when the worktree is dirty", () => {
    const dirty = buildSyntheticSubject(fixture("swe-prep.atlas.json"));
    writeFileSync(join(dirty.clone, "scratch.txt"), "uncommitted\n", "utf8");
    const result = checkPreconditions(dirty.clone, dirty.sha);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/uncommitted changes/);
  });

  it("are their own outcome, distinct from a gate failure", () => {
    const outcome = audit({ ...clean, clone: mkdtempSync(join(tmpdir(), "nope-")) });
    expect(outcome.status).toBe("failed");
    expect(outcome.failure_kind).toBe("precondition");
    // And nothing is reported as having passed.
    expect(outcome.checks.every((c) => c.outcome === "not_run")).toBe(true);
  });
});

describe("pass A on a clean artifact", () => {
  it("passes every gate it runs", () => {
    const results = runPassA(clean);
    const failures = results.filter((r) => r.outcome === "failed");
    expect(
      failures,
      failures.map((f) => `${f.id}: ${(f.findings ?? []).join("; ")}`).join("\n"),
    ).toEqual([]);
  });

  it("runs all nine, none skipped", () => {
    expect(runPassA(clean)).toHaveLength(9);
  });

  it("resolves every file citation, ranges included", () => {
    const results = byId(clean);
    expect(results.get("L1")?.outcome).toBe("passed");
    expect(results.get("L1")?.count).toBeGreaterThan(20);
    expect(results.get("L2")?.outcome).toBe("passed");
    expect(results.get("L2")?.count).toBeGreaterThan(0);
  });

  it("reports the run as passed overall", () => {
    expect(audit(clean).status).toBe("passed");
  });

  it("names every check it did not run, rather than omitting it", () => {
    // A twenty-check contract that quietly reports on nine is the failure this
    // whole stage exists to prevent.
    const outcome = audit(clean);
    expect(outcome.checks).toHaveLength(20);
    const notRun = outcome.checks.filter((c) => c.outcome === "not_run");
    expect(notRun.length).toBe(11);
    for (const c of notRun) expect(c.reason).toMatch(/not built in this version/);
  });
});

describe("every gate rejects its own mutant, and only its own", () => {
  it("has a mutant for every gate pass A runs", () => {
    expect(MUTANTS.map((m) => m.check).sort()).toEqual(
      checksInPass("A")
        .map((c) => c.id)
        .sort(),
    );
  });

  for (const mutant of MUTANTS) {
    it(`${mutant.check} rejects: ${mutant.breaks}`, () => {
      const results = byId(mutant.apply(clean));
      const target = results.get(mutant.check);
      // The check may not have been reached if an earlier gate stopped the pass;
      // that is itself a failure of this fixture, so assert it ran.
      expect(target, `${mutant.check} did not run against its own mutant`).toBeDefined();
      expect(target!.outcome, (target!.findings ?? []).join("; ")).toBe("failed");
      expect(target!.findings?.length ?? 0).toBeGreaterThan(0);
      // And only its own: no other check that ran may reject this artifact, or
      // the fixture is not isolating the failure mode it claims to.
      const others = [...results.values()].filter(
        (r) => r.id !== mutant.check && r.outcome === "failed",
      );
      expect(others.map((r) => r.id), "another check also failed on this mutant").toEqual([]);
    });
  }

  it("stops the pass at the first gate failure rather than measuring a doomed artifact", () => {
    const broken = MUTANTS.find((m) => m.check === "S1")!.apply(clean);
    const results = runPassA(broken);
    expect(results[results.length - 1]!.outcome).toBe("failed");
    expect(results.length).toBeLessThan(9);
  });

  it("marks the checks a stopped pass never reached as not run, not as passed", () => {
    const outcome = audit(MUTANTS.find((m) => m.check === "S1")!.apply(clean));
    expect(outcome.status).toBe("failed");
    expect(outcome.failure_kind).toBe("gate");
    const skipped = outcome.checks.filter((c) => c.reason?.includes("stopped at an earlier gate"));
    expect(skipped.length).toBeGreaterThan(0);
    expect(outcome.checks.some((c) => c.outcome === "passed")).toBe(false);
  });
});

describe("the private-source check has three states, and none of them is silence", () => {
  it("gates when the subject declares a split and the private side was readable", () => {
    expect(byId(clean).get("P1")?.outcome).toBe("passed");
  });

  it("says so when a split is declared but nothing private was readable at harvest", () => {
    const atlas = structuredClone(clean.atlas);
    atlas.record.private_source = {
      declared: true,
      repo: "KyleNaluan/swe-prep-content",
      readable_at_harvest: false,
    };
    const { privateClone: _drop, ...withoutCorpus } = clean;
    const result = byId({ ...withoutCorpus, atlas }).get("P1");
    expect(result?.outcome).toBe("not_applicable");
    expect(result?.reason).toMatch(/nothing private was readable at harvest/);
  });

  it("says so when the subject declares no split at all", () => {
    const atlas = structuredClone(clean.atlas);
    delete atlas.record.private_source;
    const result = byId({ ...clean, atlas }).get("P1");
    expect(result?.outcome).toBe("not_applicable");
    expect(result?.reason).toMatch(/declares no public\/private split/);
  });

  it("never counts a state it could not run as a pass", () => {
    const atlas = structuredClone(clean.atlas);
    delete atlas.record.private_source;
    const outcome = audit({ ...clean, atlas });
    expect(outcome.checks.find((c) => c.id === "P1")?.outcome).toBe("not_applicable");
    expect(outcome.checks.find((c) => c.id === "P1")?.outcome).not.toBe("passed");
  });
});

describe("L1/L2 when the graph cites no file evidence at all", () => {
  // A check that could not run never counts as passing, and absence is never
  // communicated by silence (#8): a file-free graph must report not_applicable
  // for both L1 and L2, not a hollow pass. The decision-poor subject in #10 can
  // produce exactly this graph.
  const stripFileEvidence = (atlas: Atlas): Atlas => {
    const a = structuredClone(atlas);
    const noFile = (list: Evidence[]) => list.filter((e) => e.kind !== "file");
    a.synopsis.evidence = noFile(a.synopsis.evidence);
    a.shape.evidence = noFile(a.shape.evidence);
    for (const n of a.nodes) {
      n.evidence = noFile(n.evidence);
      if (n.type === "decision") n.implemented_by = noFile(n.implemented_by);
      if (n.type === "mechanism" && n.code_excerpt?.evidence.kind === "file") delete n.code_excerpt;
      if (n.type === "flow") for (const s of n.steps) if (s.evidence?.kind === "file") delete s.evidence;
    }
    return a;
  };

  const bare = (): AuditContext => ({ ...clean, atlas: stripFileEvidence(clean.atlas) });

  it("reports not_applicable for both, each with a reason", () => {
    const [l1, l2] = resolveFileEvidence(bare());
    expect(l1.id).toBe("L1");
    expect(l1.outcome).toBe("not_applicable");
    expect(l1.reason).toMatch(/no path to resolve/);
    expect(l2.id).toBe("L2");
    expect(l2.outcome).toBe("not_applicable");
    expect(l2.reason).toMatch(/no line range to resolve/);
  });

  it("counts neither as a passing gate", () => {
    // Mirrors the exact predicate the verdict uses to tally hard gates passed.
    const passingGates = resolveFileEvidence(bare()).filter(
      (c) => c.class === "gate" && c.outcome === "passed",
    );
    expect(passingGates).toEqual([]);
  });
});

describe("L2 when the graph cites files but none carry a line range", () => {
  // line_start is optional (#3, settled), so a graph can cite paths with no
  // ranges. L1 examined a real population (the paths) and reports its outcome;
  // L2 resolved zero ranges, so it had no population and must report
  // not_applicable rather than a hollow pass (#8).
  const stripLineRanges = (atlas: Atlas): Atlas => {
    const a = structuredClone(atlas);
    const drop = (e: Evidence) => {
      if (e.kind === "file") {
        delete e.line_start;
        delete e.line_end;
      }
    };
    a.synopsis.evidence.forEach(drop);
    a.shape.evidence.forEach(drop);
    for (const n of a.nodes) {
      n.evidence.forEach(drop);
      if (n.type === "decision") n.implemented_by.forEach(drop);
      if (n.type === "mechanism" && n.code_excerpt) drop(n.code_excerpt.evidence);
      if (n.type === "flow") for (const s of n.steps) if (s.evidence) drop(s.evidence);
    }
    return a;
  };

  const pathOnly = (): AuditContext => ({ ...clean, atlas: stripLineRanges(clean.atlas) });

  it("reports L1 passed but L2 not_applicable with a reason", () => {
    const [l1, l2] = resolveFileEvidence(pathOnly());
    expect(l1.id).toBe("L1");
    expect(l1.outcome).toBe("passed");
    expect(l2.id).toBe("L2");
    expect(l2.outcome).toBe("not_applicable");
    expect(l2.reason).toMatch(/none carry a line range/);
  });

  it("does not count that L2 as a passing gate", () => {
    // Mirrors the exact predicate the verdict uses to tally hard gates passed.
    const l2 = resolveFileEvidence(pathOnly())[1];
    expect(l2.class === "gate" && l2.outcome === "passed").toBe(false);
  });
});

describe("L2 when the graph declares ranges but their paths do not resolve", () => {
  // L2's population is the ranges DECLARED in the graph, not the ones the check
  // managed to examine. A graph that declares ranges whose paths are missing at
  // the pinned SHA must not have L2 claim "no ranges to resolve" - that would
  // mis-describe the audit's own coverage to the very reader debugging the
  // failed run (#8). L1 stays unaffected: it examined the paths and fails.
  const reroute = (atlas: Atlas, pick: (path: string) => boolean): Atlas => {
    const a = structuredClone(atlas);
    eachEvidence(a, (e) => {
      if (e.kind === "file" && pick(e.path)) e.path = `does-not-exist/${e.path}`;
    });
    return a;
  };

  it("(b) all paths missing: L1 fails and L2 names the unresolved paths, not 'no ranges'", () => {
    const ctx: AuditContext = { ...clean, atlas: reroute(clean.atlas, () => true) };
    const [l1, l2] = resolveFileEvidence(ctx);
    expect(l1.outcome).toBe("failed");
    expect(l2.outcome).toBe("not_applicable");
    expect(l2.reason).toMatch(/could not be checked because their paths did not resolve/);
    expect(l2.reason).not.toMatch(/none carry a line range/);
  });

  it("(c) partially resolvable: L2 reports only the ranges it actually examined", () => {
    const examinedAll = resolveFileEvidence(clean)[1].count ?? 0;
    const ranged = new Set<string>();
    eachEvidence(clean.atlas, (e) => {
      if (e.kind === "file" && e.line_start !== undefined) ranged.add(e.path);
    });
    const one = [...ranged][0]!;
    const ctx: AuditContext = { ...clean, atlas: reroute(clean.atlas, (p) => p === one) };
    const [l1, l2] = resolveFileEvidence(ctx);
    expect(l1.outcome).toBe("failed");
    expect(l2.outcome).toBe("passed");
    expect(l2.count ?? 0).toBeGreaterThan(0);
    // Fewer ranges examined than the clean run: L2 never claims coverage it lost.
    expect(l2.count ?? 0).toBeLessThan(examinedAll);
  });
});

describe("P1 cannot pass on an incomplete corpus", () => {
  it("reports not_applicable, naming the skip, when a private file could not be read in full", () => {
    // A partial corpus can never support a passing truth gate: a leaked passage
    // in a skipped file would never be shingled. A clean artifact against a
    // corpus with a skipped file must come back not_applicable, not passed.
    const corpusRoot = mkdtempSync(join(tmpdir(), "repo-atlas-private-partial-"));
    writeFileSync(join(corpusRoot, "readable.txt"), "some harmless words in here\n", "utf8");
    // A sparse file past the 32 MB cap: no disk cost, but stat.size forces the
    // real size-cap skip inside readCorpus.
    const big = join(corpusRoot, "too-big.txt");
    writeFileSync(big, "");
    truncateSync(big, 33 * 1024 * 1024);

    const atlas = structuredClone(clean.atlas);
    atlas.record.private_source = {
      declared: true,
      repo: "KyleNaluan/swe-prep-content",
      readable_at_harvest: true,
    };
    const result = byId({ ...clean, atlas, privateClone: corpusRoot }).get("P1");
    expect(result?.outcome).not.toBe("passed");
    expect(result?.outcome).toBe("not_applicable");
    expect(result?.reason).toMatch(/could not be folded into the corpus/);
    expect(result?.reason).toContain("too-big.txt");
  });

  it("records a stat that throws as a skip rather than crashing the audit", () => {
    // A broken symlink makes statSync throw ENOENT mid-walk. Left uncaught that
    // propagates out of readCorpus -> privateSourceCheck -> runPassA -> audit()
    // and crashes the whole run: the same hollow-coverage failure arriving as a
    // throw instead of a false pass. It must be recorded as a skip, which per
    // the incomplete-corpus rule already makes a passing P1 unreachable.
    const corpusRoot = mkdtempSync(join(tmpdir(), "repo-atlas-private-broken-"));
    writeFileSync(join(corpusRoot, "readable.txt"), "some harmless words in here\n", "utf8");
    symlinkSync(join(corpusRoot, "does-not-exist"), join(corpusRoot, "broken-link"));

    const atlas = structuredClone(clean.atlas);
    atlas.record.private_source = {
      declared: true,
      repo: "KyleNaluan/swe-prep-content",
      readable_at_harvest: true,
    };
    const ctx: AuditContext = { ...clean, atlas, privateClone: corpusRoot };
    expect(() => audit(ctx)).not.toThrow();
    const result = byId(ctx).get("P1");
    expect(result?.outcome).not.toBe("passed");
    expect(result?.outcome).toBe("not_applicable");
    expect(result?.reason).toMatch(/could not be folded into the corpus/);
    expect(result?.reason).toContain("broken-link");
  });

  it("does not follow a directory symlink cycle, and does not skip a link covered inside the root", () => {
    // A private clone is an arbitrary git repo and can contain a directory
    // symlink pointing at an ancestor (link -> .). statSync follows it, so a
    // stat-driven walk recurses forever and dies with a stack overflow: a crash,
    // not a skip. The walk must terminate. A cycle-to-self points inside the
    // root, so it loses no coverage and must NOT force a skip on its own: a
    // benign internal link can still leave P1 passable when there is no leak.
    const corpusRoot = mkdtempSync(join(tmpdir(), "repo-atlas-private-cycle-"));
    writeFileSync(join(corpusRoot, "readable.txt"), "some harmless words in here\n", "utf8");
    symlinkSync(corpusRoot, join(corpusRoot, "self"));

    const atlas = structuredClone(clean.atlas);
    atlas.record.private_source = {
      declared: true,
      repo: "KyleNaluan/swe-prep-content",
      readable_at_harvest: true,
    };
    const ctx: AuditContext = { ...clean, atlas, privateClone: corpusRoot };
    expect(() => audit(ctx)).not.toThrow();
    const result = byId(ctx).get("P1");
    expect(result?.outcome).toBe("passed");
  });

  it("records a symlink leaving the corpus root as a skip", () => {
    // A symlink whose target is outside the root is uncovered private content:
    // the walk never reaches it, so following it is the only way it would be
    // shingled. Not following it must therefore be a skip, which per the
    // incomplete-corpus rule makes a passing P1 unreachable.
    const corpusRoot = mkdtempSync(join(tmpdir(), "repo-atlas-private-outlink-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "repo-atlas-private-outside-"));
    writeFileSync(join(corpusRoot, "readable.txt"), "some harmless words in here\n", "utf8");
    writeFileSync(join(outsideRoot, "leak.txt"), "content that lives outside the corpus\n", "utf8");
    symlinkSync(outsideRoot, join(corpusRoot, "escape"));

    const atlas = structuredClone(clean.atlas);
    atlas.record.private_source = {
      declared: true,
      repo: "KyleNaluan/swe-prep-content",
      readable_at_harvest: true,
    };
    const ctx: AuditContext = { ...clean, atlas, privateClone: corpusRoot };
    expect(() => audit(ctx)).not.toThrow();
    const result = byId(ctx).get("P1");
    expect(result?.outcome).not.toBe("passed");
    expect(result?.outcome).toBe("not_applicable");
    expect(result?.reason).toMatch(/could not be folded into the corpus/);
    expect(result?.reason).toContain("escape");
  });
});

describe("git plumbing", () => {
  it("tells a missing path apart from a broken repository", () => {
    // The distinction the whole precondition rule rests on: one is a finding
    // about the artifact, the other is a finding about the audit.
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clean.clone,
      encoding: "utf8",
    }).trim();
    expect(head).toBe(clean.atlas.subject.sha);
  });

  it("returns null for an absent path rather than throwing, whatever the locale", () => {
    // A path absent at the pinned SHA is a finding about the artifact: blobAt
    // must return null so L1 records a failing citation, never re-throw. The
    // decision keys off git's exit code, not its (translated) error text, so it
    // holds even under a non-English locale. LC_ALL is pinned to C inside the
    // helper regardless of the ambient value, so simulating one here only proves
    // the message text is never consulted.
    const prior = process.env.LC_ALL;
    process.env.LC_ALL = "fr_FR.UTF-8";
    try {
      expect(() => blobAt(clean.clone, clean.atlas.subject.sha, "no/such/path.txt")).not.toThrow();
      expect(blobAt(clean.clone, clean.atlas.subject.sha, "no/such/path.txt")).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = prior;
    }
  });

  it("treats an unresolvable SHA as a precondition failure, not an absent path", () => {
    // A bad object is a finding about the audit, not a false citation: blobAt
    // verifies the commit first and throws rather than reporting the path missing.
    expect(() => blobAt(clean.clone, "0".repeat(40), "no/such/path.txt")).toThrow();
  });
});
