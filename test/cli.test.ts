/**
 * The CLI's contract with a shell: exit codes and the honesty of the stage
 * register.
 *
 * The last case is the one worth having. #2 makes each stage a subcommand, and
 * stages land across a series of PRs; the failure mode to prevent is a stage
 * that exists in the help text and quietly no-ops. A stage that is not built
 * must say so and exit non-zero.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { STAGES } from "../src/stages.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("repo-atlas <stage>", () => {
  it("lists every stage in pipeline order in its usage", async () => {
    expect(await main(["--help"])).toBe(0);
    const names = new Set(STAGES.map((s) => s.name));
    const listed = out
      .join("\n")
      .split("\n")
      .map((l) => /^ {2}(\S+) {2}/.exec(l)?.[1])
      .filter((n): n is string => n !== undefined && names.has(n));
    // Pipeline order is the contract, not alphabetical order.
    expect(listed).toEqual(STAGES.map((s) => s.name));
  });

  it("exits non-zero with usage when invoked with no stage", async () => {
    expect(await main([])).toBe(1);
  });

  it("rejects an unknown stage with EX_USAGE", async () => {
    expect(await main(["summarise"])).toBe(64);
    expect(err.join("\n")).toContain('unknown stage "summarise"');
  });

  it("prints the tool version and the schema version together", async () => {
    expect(await main(["--version"])).toBe(0);
    expect(out.join("\n")).toMatch(/^repo-atlas \d+\.\d+\.\d+ \(atlas\.json schema \d+\.\d+\.\d+\)$/);
  });

  it("has every registered stage built, which is what v1 means", () => {
    // This assertion replaced one requiring at least one UNBUILT stage. That
    // test was right while the register documented gaps, and #22 closed the last
    // of them; keeping it would have made finishing the pipeline fail the suite.
    // The mechanism it protected is still tested, immediately below, against a
    // synthetic entry rather than a real gap - so the dispatcher's loud refusal
    // stays covered without the register having to carry a hole to prove it.
    expect(STAGES.filter((s) => !s.implemented)).toEqual([]);
  });

  it("refuses an unbuilt stage loudly instead of no-opping", async () => {
    // #2's rule: a stage cannot be documented without existing, and one that does
    // not exist exits 70 rather than quietly succeeding. Exercised through the
    // real dispatcher on a stage appended to the register for this test.
    const placeholder = { name: "fictional", summary: "not real", implemented: false, run: async () => 70 };
    STAGES.push(placeholder);
    try {
      expect(await main(["fictional"])).toBe(70);
      expect(err.join("\n")).toContain("not built yet");
    } finally {
      STAGES.pop();
    }
  });
});

describe("repo-atlas validate", () => {
  it("accepts a valid document and reports what it contains", async () => {
    expect(await main(["validate", fixture("swe-prep.atlas.json")])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("valid against atlas.json schema");
    expect(text).toContain("086c99998ba6eec1353988cd88989cbe836fe6a0");
  });

  it("exits EX_DATAERR and names each problem on an invalid document", async () => {
    expect(await main(["validate", fixture("../cli.test.ts")])).toBe(65);
    expect(err.join("\n")).toMatch(/not valid JSON|does not match/);
  });

  it("exits EX_USAGE with no argument", async () => {
    expect(await main(["validate"])).toBe(64);
  });
});

describe("repo-atlas gate", () => {
  it("refuses candidates and a harvest minted at different SHAs, naming both", async () => {
    // Re-checking a candidate against a tree it was not minted from silently
    // flips confirmed/overturned verdicts; the guard turns that into a loud,
    // defined failure before any candidate is resolved.
    const dir = mkdtempSync(join(tmpdir(), "repo-atlas-gate-"));
    const candidates = join(dir, "candidates.json");
    const harvest = join(dir, "harvest.json");
    writeFileSync(candidates, JSON.stringify({ subject_sha: "aaaaaaa", outcomes: [] }), "utf8");
    writeFileSync(harvest, JSON.stringify({ subject: { sha: "bbbbbbb", owner: "o", repo: "r" } }), "utf8");
    const code = await main(["gate", "--candidates", candidates, "--harvest", harvest, "--clone", dir]);
    expect(code).toBe(65);
    const message = err.join("\n");
    expect(message).toContain("aaaaaaa");
    expect(message).toContain("bbbbbbb");
  });
});

describe("repo-atlas audit", () => {
  it("exits EX_USAGE without the inputs it cannot invent", async () => {
    // The audit needs the artifact, the graph and a clone at the pinned SHA.
    // Defaulting any of them would be the audit guessing at what it is checking.
    expect(await main(["audit"])).toBe(64);
    expect(await main(["audit", "x.html"])).toBe(64);
    expect(await main(["audit", "x.html", "--atlas", "a.json"])).toBe(64);
  });

  it("documents that a missing precondition is its own outcome", async () => {
    expect(await main(["audit", "--help"])).toBe(0);
    expect(out.join("\n")).toMatch(/never a pass and never a silent skip/);
  });

  it("exits non-zero with a message, not a stack trace, when its inputs cannot be read", async () => {
    // The command must convert an unreadable input into a defined non-zero exit,
    // the same discipline the per-check boundary imposes inside the run: a throw
    // never escapes as a stack trace.
    const code = await main([
      "audit",
      "does-not-exist.html",
      "--atlas",
      fixture("swe-prep.atlas.json"),
      "--clone",
      ".",
    ]);
    expect(code).not.toBe(0);
    expect(err.join("\n")).toMatch(/^failed:/m);
    expect(err.join("\n")).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  });
});
