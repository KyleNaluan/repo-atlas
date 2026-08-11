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

  it("refuses an unbuilt stage loudly instead of no-opping", async () => {
    const unbuilt = STAGES.filter((s) => !s.implemented);
    expect(unbuilt.length).toBeGreaterThan(0);
    for (const stage of unbuilt) {
      err = [];
      expect(await main([stage.name])).toBe(70);
      expect(err.join("\n")).toContain("not built yet");
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
