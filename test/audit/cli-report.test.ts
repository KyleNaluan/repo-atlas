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
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { failed, passed, notRun } from "../../src/audit/types.js";
import { VIEWPORTS, type ViewportMeasurement } from "../../src/audit/checks/visual.js";
import { contentHash, withSlotsBlanked } from "../../src/artifact/audit-slot.js";
import type { Atlas, AuditRecord } from "../../src/schema/types.js";

const dir = mkdtempSync(join(tmpdir(), "repo-atlas-cli-report-"));

// The audit mirrors its result into the atlas it was given (#8, section 7.1), so
// the test works on a COPY. Pointing it at the committed fixture would have the
// suite rewrite its own input, which it silently did until this was caught.
const atlasFixture = join(dir, "atlas.json");
copyFileSync(
  fileURLToPath(new URL("../fixtures/swe-prep.atlas.json", import.meta.url)),
  atlasFixture,
);
const artifactPath = join(dir, "atlas.html");
// A real artifact always carries the two reserved audit slots; the stub has to
// as well, or it exercises a shape the renderer never emits.
writeFileSync(
  artifactPath,
  '<!doctype html><html><body>' +
    '<span class="audit-badge" data-atlas-audit="badge">Audit: not run</span>' +
    '<div id="audit-statement" data-atlas-audit="statement"><p>Audit: not run.</p></div>' +
    "</body></html>",
  "utf8",
);

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

// A run where pass B completed carries a measurement per declared viewport;
// that is the evidence the layout checks actually ran at those widths.
const measurements: ViewportMeasurement[] = VIEWPORTS.map((width) => ({
  width,
  scrollWidth: width,
  clientWidth: width,
  overflowing: [],
  clipped: [],
  lowContrast: [],
}));

const passing: AuditOutcome = {
  status: "passed",
  checks: REGISTER.map((s) =>
    s.pass === "A" || s.pass === "B" ? passed(s) : notRun(s, "pass C/D is not built in this version"),
  ),
  preconditions: [],
  notes: [],
  measurements,
};

// Pass A failed at a gate, so pass B never launched: the run is failed but not a
// precondition failure, and it carries no measurements. The stamp and record
// path is still reached, and the record must not claim the layout checks ran.
const passAGateFailed: AuditOutcome = {
  status: "failed",
  failure_kind: "gate",
  checks: REGISTER.map((s) =>
    s.id === "L1"
      ? failed(s, ["AttemptService.java:141-150 does not exist"])
      : s.pass === "A"
        ? passed(s)
        : notRun(s, "pass A stopped at an earlier gate failure"),
  ),
  preconditions: [],
  notes: [],
};

const recordedAudit = (): AuditRecord =>
  (JSON.parse(readFileSync(atlasFixture, "utf8")) as Atlas).record.audit;

const recordedViewports = (): number[] | undefined => recordedAudit().viewports;

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

describe("record.viewports records only the widths the layout checks ran at", () => {
  it("records the declared viewport matrix when pass B ran", async () => {
    vi.mocked(runAudit).mockResolvedValue(passing);
    const code = await auditCommand(argv);
    expect(code).toBe(0);
    expect(recordedViewports()).toEqual([...VIEWPORTS]);
  });

  it("records no viewports when pass A failed before pass B ran", async () => {
    // A failed run still reaches the stamp and record path; keying viewports on
    // the absence of --no-browser would falsely record all four while V1-V3 are
    // not_run. --out keeps the failed copy off the shared stub.
    vi.mocked(runAudit).mockResolvedValue(passAGateFailed);
    const code = await auditCommand([...argv, "--out", join(dir, "failed-out.html")]);
    expect(code).toBe(1);
    expect(recordedViewports()).toBeUndefined();
  });
});

describe("record.content_hash describes only a file a consumer can verify", () => {
  it("records a content_hash on a passing run that reproduces by blanking the emitted file's slots", async () => {
    vi.mocked(runAudit).mockResolvedValue(passing);
    const emitted = join(dir, "passed-out.html");
    const code = await auditCommand([...argv, "--out", emitted]);
    expect(code).toBe(0);
    const hash = recordedAudit().content_hash;
    expect(hash).toBeDefined();
    // The whole point of the recorded hash: a consumer blanks the slots of the
    // emitted file and reproduces it. On a passing run no banner is added.
    expect(contentHash(readFileSync(emitted, "utf8"))).toBe(hash);
    expect(withSlotsBlanked(readFileSync(emitted, "utf8"))).not.toContain("Audit: FAILED");
  });

  it("records no content_hash on a quarantined run, since no verifiable file is emitted", async () => {
    // The emitted .failed.html carries the failure banner outside the audit
    // slots, so blanking its slots reproduces no recorded hash - and on
    // quarantine there is no deliverable at the output path at all. A hash that
    // matches no file on disk is worse than no hash.
    vi.mocked(runAudit).mockResolvedValue(passAGateFailed);
    const code = await auditCommand([...argv, "--out", join(dir, "quarantined-out.html")]);
    expect(code).toBe(1);
    expect(recordedAudit().content_hash).toBeUndefined();
  });

  it("records no content_hash even under --allow-failed, because the emitted copy still carries the banner", async () => {
    vi.mocked(runAudit).mockResolvedValue(passAGateFailed);
    const code = await auditCommand([...argv, "--out", join(dir, "allowed-out.html"), "--allow-failed"]);
    expect(code).toBe(1);
    expect(recordedAudit().content_hash).toBeUndefined();
  });
});
