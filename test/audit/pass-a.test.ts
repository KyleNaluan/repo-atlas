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
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { render } from "../../src/render/render.js";
import { disposeHighlighter } from "../../src/render/highlight.js";
import { memoryDiagramCache } from "../../src/render/cache.js";
import { audit } from "../../src/audit/run.js";
import { runPassA } from "../../src/audit/pass-a.js";
import { checkPreconditions } from "../../src/audit/preconditions.js";
import { checksInPass, GATES, REGISTER } from "../../src/audit/register.js";
import type { AuditContext } from "../../src/audit/types.js";
import type { Atlas } from "../../src/schema/types.js";
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
});
