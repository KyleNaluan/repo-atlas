/**
 * The CLI's honesty at print time, for the two precondition shapes runAudit can
 * return.
 *
 * runAudit (K1) preserves pass A's real results when a later pass throws, and
 * names every pass B check not_run with the cause - the AuditOutcome is correct.
 * The defect this guards is the CLI dropping that report: a PRE-FLIGHT failure
 * (nothing ran) has nothing to print but the problems, but a MID-RUN failure has
 * eight established gates that must be shown, or the command communicates absence
 * by the very silence #6 forbids. Both exit 78; a passing run is unchanged.
 *
 * runAudit is mocked so the display contract is tested on its own, without a real
 * browser render - the AuditOutcome shapes it returns are already proven by
 * pass-b-boundary.test.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../src/audit/run.js", () => ({
  audit: vi.fn(),
  runAudit: vi.fn(),
}));

import { auditCommand } from "../../src/commands/audit.js";
import { runAudit, type AuditOutcome } from "../../src/audit/run.js";
import { REGISTER } from "../../src/audit/register.js";
import { passed, notRun } from "../../src/audit/types.js";

const atlasFixture = fileURLToPath(
  new URL("../fixtures/swe-prep.atlas.json", import.meta.url),
);

const dir = mkdtempSync(join(tmpdir(), "repo-atlas-cli-report-"));
const artifactPath = join(dir, "atlas.html");
writeFileSync(artifactPath, "<!doctype html><html></html>", "utf8");

const argv = [artifactPath, "--atlas", atlasFixture, "--clone", "."];

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

const preFlight: AuditOutcome = {
  status: "failed",
  failure_kind: "precondition",
  checks: REGISTER.map((s) => notRun(s, "a precondition failed before any check ran")),
  preconditions: ["clone at /x is not at the pinned SHA 086c999"],
  notes: [],
};

// Pass A ran and passed; pass B threw a load failure, so its checks are named
// not_run with the underlying cause - the shape runAudit's catch produces.
const midRunCause = "pass B could not run: net::ERR_FILE_NOT_FOUND";
const midRun: AuditOutcome = {
  status: "failed",
  failure_kind: "precondition",
  checks: REGISTER.map((s) => (s.pass === "A" ? passed(s) : notRun(s, midRunCause))),
  preconditions: [midRunCause],
  notes: [],
};

const passing: AuditOutcome = {
  status: "passed",
  checks: REGISTER.map((s) =>
    s.pass === "A" || s.pass === "B" ? passed(s) : notRun(s, "pass C/D is not built in this version"),
  ),
  preconditions: [],
  notes: [],
};

describe("repo-atlas audit reports what it established", () => {
  it("prints only the precondition problems on a pre-flight failure and exits 78", async () => {
    vi.mocked(runAudit).mockResolvedValue(preFlight);
    const code = await auditCommand(argv);
    expect(code).toBe(78);
    expect(err.join("\n")).toContain("failed: precondition");
    expect(err.join("\n")).toContain("086c999");
    // Nothing ran, so no check line is printed.
    expect(out.join("\n")).not.toMatch(/\bpass\b|\bFAIL\b|\bwarn\b/);
  });

  it("prints the preserved pass A report and the named not-run pass B checks on a mid-run failure, exiting 78", async () => {
    vi.mocked(runAudit).mockResolvedValue(midRun);
    const code = await auditCommand(argv);
    expect(code).toBe(78);
    const errText = err.join("\n");
    const outText = out.join("\n");
    // The precondition problem is still reported.
    expect(errText).toContain("failed: precondition");
    expect(errText).toContain("ERR_FILE_NOT_FOUND");
    // Pass A's established gates are shown, not silently dropped.
    for (const id of ["S1", "L1", "G1", "E2", "P1"]) {
      expect(outText, `${id} pass line should appear`).toMatch(new RegExp(`pass  ${id} `));
    }
    // Every pass B check is named as not run, carrying the cause.
    for (const id of ["S2", "S3", "S4", "L4", "E1", "V1", "V2", "V3"]) {
      expect(outText, `${id} should be reported not run`).toMatch(new RegExp(`----  ${id} `));
      expect(outText, `${id} should carry the cause`).toContain(`${id}: ${midRunCause}`);
    }
  });

  it("leaves a passing run unchanged", async () => {
    vi.mocked(runAudit).mockResolvedValue(passing);
    const code = await auditCommand(argv);
    expect(code).toBe(0);
    expect(err.join("\n")).not.toContain("precondition");
    expect(out.join("\n")).toMatch(/^passed: \d+ of \d+ hard gates passed$/m);
  });
});
