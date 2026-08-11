/**
 * Pass B: the gates and warnings that need a live DOM, and their mutants.
 *
 * These tests need a Chrome-family browser. When one is genuinely absent the
 * suite says so and skips - that is a statement about the test machine, not
 * about an artifact, and it is the one place the "never skip" rule does not
 * apply. The product makes the opposite call on purpose: a missing browser is a
 * PRECONDITION FAILURE for a real audit, because an audit that cannot open the
 * file must never be able to report on it. CI asserts a browser is present, so
 * this skip cannot quietly disable pass B's coverage there.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../../src/render/render.js";
import { disposeHighlighter } from "../../src/render/highlight.js";
import { memoryDiagramCache } from "../../src/render/cache.js";
import {
  browserAvailable,
  findBrowser,
  NoBrowserError,
  openArtifact,
} from "../../src/audit/browser.js";
import { runPassB } from "../../src/audit/pass-b.js";
import { oneFile, provenanceWalk } from "../../src/audit/checks/browser-gates.js";
import { runAudit } from "../../src/audit/run.js";
import { VIEWPORTS } from "../../src/audit/checks/visual.js";
import { checksInPass, GATES } from "../../src/audit/register.js";
import type {
  Atlas,
  DecisionNode,
  FlowNode,
  MechanismNode,
} from "../../src/schema/types.js";
import type { AuditContext } from "../../src/audit/types.js";
import { buildSyntheticSubject } from "./subject.js";
import { BROWSER_MUTANTS } from "../mutants/browser.js";

const hasBrowser = browserAvailable();
const describeBrowser = hasBrowser ? describe : describe.skip;

const fixture = (name: string): Atlas =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  ) as Atlas;

let ctx: AuditContext;
let artifactPath: string;
let dir: string;

beforeAll(async () => {
  const subject = buildSyntheticSubject(fixture("swe-prep.atlas.json"));
  const artifact = await render(subject.atlas, { cache: memoryDiagramCache() });
  dir = mkdtempSync(join(tmpdir(), "repo-atlas-passb-"));
  artifactPath = join(dir, "atlas.html");
  writeFileSync(artifactPath, artifact, "utf8");
  ctx = { artifact, atlas: subject.atlas, clone: subject.clone };
}, 180_000);

afterAll(async () => {
  await disposeHighlighter();
});

describe("browser discovery", () => {
  it("prefers an explicitly declared browser over the search path", () => {
    const previous = process.env["CHROME_PATH"];
    process.env["CHROME_PATH"] = "/definitely/not/here";
    try {
      expect(() => findBrowser()).toThrow(NoBrowserError);
      expect(() => findBrowser()).toThrow(/definitely\/not\/here/);
    } finally {
      if (previous === undefined) delete process.env["CHROME_PATH"];
      else process.env["CHROME_PATH"] = previous;
    }
  });

  it("explains that a missing browser is a precondition, not a skip", () => {
    expect(new NoBrowserError(["/x"]).message).toMatch(/precondition failure rather than a skip/);
    expect(new NoBrowserError(["/x"]).message).toMatch(/CHROME_PATH/);
  });
});

describeBrowser("pass B on a clean artifact", () => {
  it("passes every gate and every warning", async () => {
    const result = await runPassB(artifactPath, ctx.atlas);
    const failures = result.checks.filter((c) => c.outcome === "failed");
    expect(
      failures,
      failures.map((f) => `${f.id}: ${(f.findings ?? []).join("; ")}`).join("\n"),
    ).toEqual([]);
    expect(result.checks.map((c) => c.id)).toEqual(checksInPass("B").map((c) => c.id));
  }, 180_000);

  it("loads with the network disabled and makes exactly one request", async () => {
    const result = await runPassB(artifactPath, ctx.atlas);
    const s2 = result.checks.find((c) => c.id === "S2");
    expect(s2?.outcome).toBe("passed");
    expect(s2?.count).toBe(1);
  }, 180_000);

  it("attributes every wordy passage, and there are hundreds of them", async () => {
    // The number matters: a provenance walk that found nothing to attribute
    // would also report zero unattributed passages.
    const result = await runPassB(artifactPath, ctx.atlas);
    const e1 = result.checks.find((c) => c.id === "E1");
    expect(e1?.outcome).toBe("passed");
    expect(e1?.count).toBeGreaterThan(100);
  }, 180_000);

  it("measures every declared viewport with all details forced open", async () => {
    const result = await runPassB(artifactPath, ctx.atlas);
    expect(result.measurements.map((m) => m.width)).toEqual([...VIEWPORTS]);
    for (const m of result.measurements) {
      expect(m.scrollWidth, `page scrolls horizontally at ${m.width}px`).toBeLessThanOrEqual(
        m.clientWidth + 1,
      );
    }
  }, 180_000);

  it("keeps screenshots as artifacts of the audit, not as inputs to a check", async () => {
    const shots = join(dir, "shots");
    const result = await runPassB(artifactPath, ctx.atlas, { screenshotDir: shots });
    expect(result.screenshots).toHaveLength(VIEWPORTS.length);
    expect(readdirSync(shots).sort()).toEqual(VIEWPORTS.map((w) => `viewport-${w}.png`).sort());
    // No check reads them: the outcome is identical without them.
    const without = await runPassB(artifactPath, ctx.atlas);
    expect(without.checks.map((c) => `${c.id}:${c.outcome}`)).toEqual(
      result.checks.map((c) => `${c.id}:${c.outcome}`),
    );
  }, 240_000);

  it("keeps its verdict when screenshots cannot be written, recording a note instead", async () => {
    // A screenshot directory that cannot be created (its parent is a file, not a
    // directory) is a fact about the operator's machine, not the artifact.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const unwritable = join(blocker, "shots");

    const result = await runPassB(artifactPath, ctx.atlas, { screenshotDir: unwritable });
    // No screenshot was written, and the failure is surfaced as a note.
    expect(result.screenshots).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.notes.join("\n")).toContain(unwritable);

    // The checks are byte-identical to a run with screenshots disabled: the
    // verdict stands on the gates and warnings, never on the capture.
    const without = await runPassB(artifactPath, ctx.atlas);
    expect(result.checks).toEqual(without.checks);

    // And through the whole suite the audit still passes and never crashes; the
    // note rides along on the outcome.
    const outcome = await runAudit(ctx, { artifactPath, screenshotDir: unwritable });
    expect(outcome.status).toBe("passed");
    expect(outcome.notes.join("\n")).toContain(unwritable);
  }, 240_000);
});

describeBrowser("E1 traces a node's evidence through every slot the schema gives it", () => {
  // The DOM stamps a node's prose with its id whether the node's evidence lives
  // in node.evidence or in a type-specific slot. E1 must read the same locations,
  // or it fails an honest artifact whose provenance is real but slot-bound. The
  // page is rendered once and re-checked against mutated atlases, since part-3
  // reads the atlas for the lookup, not the DOM.
  const evidenced = (path: string, sha: string) => ({ kind: "file" as const, path, sha });

  it("passes when a decision is evidenced only through implemented_by", async () => {
    const loaded = await openArtifact(artifactPath);
    try {
      const atlas = structuredClone(ctx.atlas);
      const d = atlas.nodes.find(
        (n): n is DecisionNode => n.type === "decision" && n.confidence !== "absent",
      )!;
      d.evidence = [];
      d.implemented_by = [evidenced("impl.ts", atlas.subject.sha)];
      const e1 = await provenanceWalk(loaded.page, atlas);
      expect(e1.outcome, (e1.findings ?? []).join("; ")).toBe("passed");
    } finally {
      await loaded.close();
    }
  }, 120_000);

  it("passes when a mechanism is evidenced only through its code excerpt", async () => {
    const loaded = await openArtifact(artifactPath);
    try {
      const atlas = structuredClone(ctx.atlas);
      const m = atlas.nodes.find(
        (n): n is MechanismNode => n.type === "mechanism" && n.confidence !== "absent",
      )!;
      m.evidence = [];
      m.code_excerpt = { language: "ts", text: "x", evidence: evidenced("m.ts", atlas.subject.sha) };
      const e1 = await provenanceWalk(loaded.page, atlas);
      expect(e1.outcome, (e1.findings ?? []).join("; ")).toBe("passed");
    } finally {
      await loaded.close();
    }
  }, 120_000);

  it("passes when a flow is evidenced only through its steps", async () => {
    const loaded = await openArtifact(artifactPath);
    try {
      const atlas = structuredClone(ctx.atlas);
      const f = atlas.nodes.find(
        (n): n is FlowNode => n.type === "flow" && n.confidence !== "absent",
      )!;
      f.evidence = [];
      f.steps = f.steps.map((s) => ({ ...s, evidence: evidenced("f.ts", atlas.subject.sha) }));
      const e1 = await provenanceWalk(loaded.page, atlas);
      expect(e1.outcome, (e1.findings ?? []).join("; ")).toBe("passed");
    } finally {
      await loaded.close();
    }
  }, 120_000);

  it("still fails a node that carries no evidence in any slot", async () => {
    // The honesty case: the fix must not weaken part-3 into always passing.
    const loaded = await openArtifact(artifactPath);
    try {
      const atlas = structuredClone(ctx.atlas);
      const d = atlas.nodes.find(
        (n): n is DecisionNode => n.type === "decision" && n.confidence !== "absent",
      )!;
      d.evidence = [];
      d.implemented_by = [];
      const e1 = await provenanceWalk(loaded.page, atlas);
      expect(e1.outcome).toBe("failed");
      expect(e1.findings?.some((f) => f.includes("carries no evidence"))).toBe(true);
    } finally {
      await loaded.close();
    }
  }, 120_000);
});

describeBrowser("every pass B gate rejects its own mutant", () => {
  it("has a mutant for every gate in pass B", () => {
    const gates = checksInPass("B")
      .filter((c) => c.class === "gate")
      .map((c) => c.id);
    expect(BROWSER_MUTANTS.map((m) => m.check).sort()).toEqual([...gates].sort());
  });

  for (const mutant of BROWSER_MUTANTS) {
    it(`${mutant.check} rejects: ${mutant.breaks}`, async () => {
      const mutantDir = mkdtempSync(join(tmpdir(), `repo-atlas-mutant-${mutant.check}-`));
      const path = join(mutantDir, "atlas.html");

      if (mutant.usesDirectoryPath) {
        // A directory cannot be opened as an artifact at all, so this mutant is
        // put to the check directly rather than through the pass. Loading it
        // first would fail an earlier gate for a reason that has nothing to do
        // with the property S4 asserts.
        mkdirSync(path);
        const target = oneFile(path);
        expect(target.outcome).toBe("failed");
        expect(target.findings?.length ?? 0).toBeGreaterThan(0);
        return;
      }

      writeFileSync(path, mutant.apply!(ctx.artifact), "utf8");
      const result = await runPassB(path, ctx.atlas);
      const target = result.checks.find((c) => c.id === mutant.check);
      expect(target, `${mutant.check} did not run against its own mutant`).toBeDefined();
      expect(target!.outcome, (target!.findings ?? []).join("; ")).toBe("failed");
      expect(target!.findings?.length ?? 0).toBeGreaterThan(0);
      // And only its own: a fixture that trips two gates is not isolating the
      // failure mode it claims to.
      const others = result.checks.filter((c) => c.id !== mutant.check && c.outcome === "failed");
      expect(others.map((c) => c.id), "another check also failed on this mutant").toEqual([]);
    }, 180_000);
  }

  it("stops the pass at the first gate failure rather than measuring a doomed artifact", async () => {
    const mutantDir = mkdtempSync(join(tmpdir(), "repo-atlas-mutant-stop-"));
    const path = join(mutantDir, "atlas.html");
    writeFileSync(path, BROWSER_MUTANTS.find((m) => m.check === "S2")!.apply!(ctx.artifact), "utf8");
    const result = await runPassB(path, ctx.atlas);
    expect(result.checks[result.checks.length - 1]!.outcome).toBe("failed");
    expect(result.checks.length).toBeLessThan(checksInPass("B").length);
    expect(result.measurements).toEqual([]);
  }, 180_000);
});

describeBrowser("the whole deterministic suite", () => {
  it("reports thirteen of fifteen gates passing, and names the two it did not run", async () => {
    const outcome = await runAudit(ctx, { artifactPath });
    expect(outcome.status).toBe("passed");
    const gatesPassed = outcome.checks.filter(
      (c) => c.class === "gate" && c.outcome === "passed",
    ).length;
    expect(gatesPassed).toBe(13);
    expect(GATES).toHaveLength(15);
    const unrun = outcome.checks.filter((c) => c.outcome === "not_run");
    expect(unrun.map((c) => c.id).sort()).toEqual(["L3", "M1", "M2"]);
    for (const c of unrun) expect(c.reason).toMatch(/not built in this version/);
  }, 240_000);

  it("does not launch a browser when pass A already failed", async () => {
    // There is no point looking at an artifact whose evidence does not resolve.
    const broken = { ...ctx, atlas: structuredClone(ctx.atlas) };
    broken.atlas.nodes[0]!.confidence = "absent";
    const outcome = await runAudit(broken, { artifactPath });
    expect(outcome.status).toBe("failed");
    expect(outcome.checks.find((c) => c.id === "S2")?.outcome).toBe("not_run");
    expect(outcome.measurements).toBeUndefined();
  }, 120_000);
});
