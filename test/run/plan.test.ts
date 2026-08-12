/**
 * The orchestrator's planning: what runs, what is skipped, and what may not be.
 *
 * The skip logic is the only part of `run` with a decision in it, and the one
 * that can produce a wrong artifact rather than a slow one: skipping a stage
 * whose input has just been rebuilt would assemble a document from halves that
 * never saw each other.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALED, OUTPUT, PIPELINE, plan, workDir } from "../../src/run/run.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repo-atlas-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const built = (...stages: (typeof PIPELINE)[number][]) => {
  for (const s of stages) writeFileSync(join(dir, OUTPUT[s]), "{}", "utf8");
};

/** Write atlas.json with the audit result the audit stage mirrors in (#8, 7.1). */
const withAuditStatus = (status: string) => {
  writeFileSync(join(dir, OUTPUT["assemble"]), JSON.stringify({ record: { audit: { status } } }), "utf8");
};

describe("the pipeline order", () => {
  it("runs the stages in the order the design fixes", () => {
    // write BEFORE gate (the W1 ruling: decision candidates are gated exactly
    // like a probe's), and audit last, after render has something to audit.
    expect(PIPELINE).toEqual([
      "harvest",
      "write",
      "probe",
      "gate",
      "score",
      "rank",
      "assemble",
      "render",
      "audit",
    ]);
    expect(PIPELINE.indexOf("write")).toBeLessThan(PIPELINE.indexOf("gate"));
    expect(PIPELINE.indexOf("render")).toBeLessThan(PIPELINE.indexOf("audit"));
  });

  it("names the two stages that need a model", () => {
    expect(CREDENTIALED).toEqual(["write", "score"]);
  });
});

describe("what a run skips", () => {
  it("runs everything on a cold work directory", () => {
    expect(plan(dir).run).toEqual(PIPELINE);
    expect(plan(dir).skipped).toEqual([]);
  });

  it("skips a leading run of stages already built for this SHA", () => {
    // The point of the cache: a harvest over the network and a writer that calls
    // a model are payable once while the deterministic stages are iterated on.
    built("harvest", "write", "probe");
    const { run, skipped } = plan(dir);
    expect(skipped).toEqual(["harvest", "write", "probe"]);
    expect(run[0]).toBe("gate");
  });

  it("never skips a stage after one that is being re-run", () => {
    // The failure this prevents: ranked.json exists, so rank looks skippable -
    // but the gate has just been re-run, so ranking would be against a gate
    // result that no longer matches, which is the cross-stage mismatch assemble
    // refuses one stage later.
    built("harvest", "write", "probe", "score", "rank", "assemble");
    const { run, skipped } = plan(dir);
    expect(skipped).toEqual(["harvest", "write", "probe"]);
    expect(run).toEqual(["gate", "score", "rank", "assemble", "render", "audit"]);
  });

  it("re-runs a named stage and everything after it", () => {
    built(...PIPELINE);
    const { run, skipped } = plan(dir, { from: "rank" });
    expect(run).toEqual(["rank", "assemble", "render", "audit"]);
    expect(skipped).toEqual(["harvest", "write", "probe", "gate", "score"]);
  });

  it("re-runs the whole pipeline when forced from the first stage", () => {
    built(...PIPELINE);
    expect(plan(dir, { from: "harvest" }).run).toEqual(PIPELINE);
  });

  it("skips nothing at all when every output is missing but one late file exists", () => {
    // A stray atlas.html from an earlier subject must not make render skippable
    // while everything feeding it is rebuilt.
    built("render");
    expect(plan(dir).run).toEqual(PIPELINE);
  });

  it("re-runs an interrupted audit even though render's atlas.html is present", () => {
    // The hole audit's shared output name opens: a full run reached audit, render
    // wrote atlas.html, but audit failed or was interrupted before mirroring its
    // result. atlas.html exists, atlas.json exists, but record.audit.status is
    // still `not_run`. Keying audit on the file alone would skip it and copy an
    // unaudited artifact to the output path while exiting 0. The completion signal
    // is the mirrored status, not the file.
    built(...PIPELINE);
    withAuditStatus("not_run");
    const { run, skipped } = plan(dir);
    expect(run).toEqual(["audit"]);
    expect(skipped).not.toContain("audit");
  });

  it("never runs a supplied stage, even when an upstream stage is rebuilt", () => {
    // The cold-dir hole: --written/--scores are copied in, but harvest is not
    // cached so it runs, and the no-skip-after-a-rerun rule would then force write
    // and score to run too - overwriting the pinned files with a model call that
    // has no credential. A supplied stage is authoritative input, not a cache
    // entry, so it is skipped whatever ran before it. Nothing else is supplied
    // here, so a cold dir runs everything but the two pinned stages.
    const { run, skipped } = plan(dir, { supplied: ["write", "score"] });
    expect(run).toEqual(["harvest", "probe", "gate", "rank", "assemble", "render", "audit"]);
    expect(skipped).toEqual(["write", "score"]);
  });

  it("keeps forcing every stage after a supplied one, since supplied is not a re-run", () => {
    // A supplied stage is skipped but does not itself reset the re-run guard: the
    // stages after it still obey the rule that nothing following a rebuilt upstream
    // may be skipped. Here harvest re-runs, write is supplied (skipped), and probe
    // onward must all run against the fresh harvest.
    built(...PIPELINE);
    const { run, skipped } = plan(dir, { from: "harvest", supplied: ["write"] });
    expect(skipped).toContain("write");
    expect(run).toEqual(["harvest", "probe", "gate", "score", "rank", "assemble", "render", "audit"]);
  });

  it("skips an audit that has mirrored a real result", () => {
    for (const status of ["passed", "passed_with_warnings", "failed"] as const) {
      built(...PIPELINE);
      withAuditStatus(status);
      expect(plan(dir).run).toEqual([]);
      expect(plan(dir).skipped).toEqual(PIPELINE);
    }
  });
});

describe("the work directory", () => {
  it("keys on the pinned SHA, so two subjects cannot share a cache", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-atlas-root-"));
    try {
      const a = workDir(root, "a".repeat(40));
      const b = workDir(root, "b".repeat(40));
      expect(a).not.toBe(b);
      expect(a.endsWith("a".repeat(40))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives audit the file render wrote, so the audit stamps in place", () => {
    // Both name atlas.html deliberately: the audit rewrites the artifact's own
    // reserved slot (#8, 7.1) rather than emitting a second document.
    expect(OUTPUT["render"]).toBe(OUTPUT["audit"]);
  });
});
