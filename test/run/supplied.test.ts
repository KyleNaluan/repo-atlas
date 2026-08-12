/**
 * The real CI case: a cold work directory, both credentialed stages supplied by
 * flag, and no credential to reach a model with.
 *
 * The hole this pins: --written/--scores are copied into the work dir under the
 * name each stage would have written, but on a cold dir harvest is not cached so
 * it runs - and the no-skip-after-a-rerun rule would then force write and score
 * to run too, calling a model that has no credential and OVERWRITING the very
 * files that were supplied to stand in for it. A supplied stage is authoritative
 * input, not a cache entry, so `plan` skips it whatever ran upstream and the
 * pipeline completes without either credentialed stage running.
 *
 * The stage runners are mocked: this exercises `run`'s orchestration - the copy,
 * the plan, the credential guard - without a network harvest or a model call,
 * which is exactly the seam the bug lived in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT, PIPELINE } from "../../src/run/run.js";

const passthrough = () => vi.fn(async () => 0);
const harvestCommand = passthrough();
const writeCommand = passthrough();
const probeCommand = passthrough();
const gateCommand = passthrough();
const scoreCommand = passthrough();
const rankCommand = passthrough();
const assembleCommand = passthrough();
const renderCommand = passthrough();
const auditCommand = passthrough();

vi.mock("../../src/commands/harvest.js", () => ({ harvestCommand }));
vi.mock("../../src/commands/write.js", () => ({ writeCommand }));
vi.mock("../../src/commands/probe.js", () => ({ probeCommand, gateCommand }));
vi.mock("../../src/commands/score.js", () => ({ scoreCommand }));
vi.mock("../../src/commands/rank.js", () => ({ rankCommand }));
vi.mock("../../src/commands/assemble.js", () => ({ assembleCommand }));
vi.mock("../../src/commands/render.js", () => ({ renderCommand }));
vi.mock("../../src/commands/audit.js", () => ({ auditCommand }));
vi.mock("../../src/harvest/tree.js", () => ({
  isRepo: () => true,
  headSha: () => "a".repeat(40),
  subjectRemote: () => "owner/subject",
}));

const { runCommand } = await import("../../src/commands/run.js");

let root: string;
let clone: string;
let written: string;
let scores: string;

const WRITTEN_BYTES = `${JSON.stringify({ subject_sha: "a".repeat(40), decisions: [] }, null, 2)}\n`;
const SCORES_BYTES = `${JSON.stringify({ rubric_sha256: "deadbeef", scores: [] }, null, 2)}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repo-atlas-supplied-"));
  clone = join(root, "clone");
  written = join(root, "written.json");
  scores = join(root, "scores.json");
  writeFileSync(written, WRITTEN_BYTES, "utf8");
  writeFileSync(scores, SCORES_BYTES, "utf8");
  for (const fn of [harvestCommand, writeCommand, probeCommand, gateCommand, scoreCommand, rankCommand, assembleCommand, renderCommand, auditCommand]) {
    fn.mockClear();
  }
  delete process.env["ATLAS_NO_MODEL"];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["ATLAS_NO_MODEL"];
});

describe("a cold run with both credentialed stages supplied and no model", () => {
  it("completes without running write or score, and leaves the supplied files untouched", async () => {
    // No credential at all: the flag that stands in for one.
    process.env["ATLAS_NO_MODEL"] = "1";
    const work = join(root, "work");

    const code = await runCommand([
      "--clone", clone,
      "--repo", "owner/subject",
      "--sha", "a".repeat(40),
      "--work", work,
      "--written", written,
      "--scores", scores,
      "--no-browser",
    ]);

    expect(code).toBe(0);
    // The two credentialed stages never ran, so the guard never fired and the
    // model was never reached.
    expect(writeCommand).not.toHaveBeenCalled();
    expect(scoreCommand).not.toHaveBeenCalled();
    // Everything else did, over the freshly-harvested cold dir.
    expect(harvestCommand).toHaveBeenCalledOnce();
    expect(assembleCommand).toHaveBeenCalledOnce();

    // The supplied files are byte-identical: nothing overwrote them.
    const dir = join(work, "a".repeat(40));
    expect(readFileSync(join(dir, "written.json"), "utf8")).toBe(WRITTEN_BYTES);
    expect(readFileSync(join(dir, "scores.json"), "utf8")).toBe(SCORES_BYTES);
  });
});

describe("a warm work dir given a --written file that differs from the cache", () => {
  // A fully-built cache for this SHA, its written.json holding OLD decisions.
  const warmDir = (work: string): string => {
    const dir = join(work, "a".repeat(40));
    mkdirSync(dir, { recursive: true });
    for (const stage of PIPELINE) writeFileSync(join(dir, OUTPUT[stage]), "{}", "utf8");
    // The cached decisions the supplied file will supersede.
    writeFileSync(join(dir, OUTPUT["write"]), `${JSON.stringify({ subject_sha: "a".repeat(40), decisions: ["old"] })}\n`, "utf8");
    // Assemble's atlas.json also carries the mirrored audit status, so audit is
    // otherwise cached: the only thing forcing it to re-run is the supersession.
    writeFileSync(join(dir, OUTPUT["assemble"]), JSON.stringify({ record: { audit: { status: "passed" } } }), "utf8");
    return dir;
  };

  it("re-runs every downstream stage so the artifact reflects the new decisions, without running write", async () => {
    const work = join(root, "work");
    warmDir(work);

    const code = await runCommand([
      "--clone", clone,
      "--repo", "owner/subject",
      "--sha", "a".repeat(40),
      "--work", work,
      "--written", written,
      "--no-browser",
    ]);

    expect(code).toBe(0);
    // The supplied stage never runs, and the cached upstream is untouched.
    expect(writeCommand).not.toHaveBeenCalled();
    expect(harvestCommand).not.toHaveBeenCalled();
    // Everything downstream of the superseded write re-runs against the new file.
    for (const fn of [probeCommand, gateCommand, rankCommand, assembleCommand, renderCommand, auditCommand]) {
      expect(fn).toHaveBeenCalledOnce();
    }
    // The supplied bytes replaced the cached ones.
    const dir = join(work, "a".repeat(40));
    expect(readFileSync(join(dir, "written.json"), "utf8")).toBe(WRITTEN_BYTES);
  });

  it("changes nothing when the supplied file is byte-identical to the cache", async () => {
    const work = join(root, "work");
    const dir = warmDir(work);
    // Seed the cache with exactly the bytes about to be supplied.
    writeFileSync(join(dir, OUTPUT["write"]), WRITTEN_BYTES, "utf8");

    const code = await runCommand([
      "--clone", clone,
      "--repo", "owner/subject",
      "--sha", "a".repeat(40),
      "--work", work,
      "--written", written,
      "--no-browser",
    ]);

    expect(code).toBe(0);
    // Identical input is not new input: the warm cache stays valid, nothing runs.
    for (const fn of [harvestCommand, writeCommand, probeCommand, gateCommand, scoreCommand, rankCommand, assembleCommand, renderCommand, auditCommand]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});
