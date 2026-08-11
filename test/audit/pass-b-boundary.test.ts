/**
 * Pass B's per-check error boundary, and the browser it must not leak.
 *
 * The same crash-instead-of-report class the pass A boundary closes reaches pass
 * B the moment its checks run in a live browser: a destroyed page context or a
 * browser that dies mid-run makes `anchorsResolve` or `provenanceWalk` throw. #8
 * defines exactly four outcome states and a stack trace is not one of them, so a
 * throwing browser check must become a defined `aborted` failure named in the
 * report, never an exception that escapes runPassB and degrades an audit report
 * into a generic exit 70. This proves it, and proves the browser is still closed
 * on that path.
 *
 * The suite lives in its own file so its two mocks - one browser check forced to
 * throw, and a launch wrapper that records the browser so a leak can be seen -
 * do not touch the rest of pass B's tests.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Wrap the real launch so every browser this suite starts is recorded; a leak is
// then a recorded browser that is still connected after the call returned.
const { launched } = vi.hoisted(() => ({
  launched: [] as import("puppeteer-core").Browser[],
}));

vi.mock("puppeteer-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("puppeteer-core")>();
  return {
    ...actual,
    launch: async (options: Parameters<typeof actual.launch>[0]) => {
      const browser = await actual.launch(options);
      launched.push(browser);
      return browser;
    },
  };
});

// L4 stands in for any browser check whose page.evaluate throws. The rest of the
// gates stay real so the pass reaches L4 the way it would in production.
vi.mock("../../src/audit/checks/browser-gates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/audit/checks/browser-gates.js")>();
  return {
    ...actual,
    anchorsResolve: async () => {
      throw new Error("the page context was destroyed mid-run");
    },
  };
});

import { render } from "../../src/render/render.js";
import { disposeHighlighter } from "../../src/render/highlight.js";
import { memoryDiagramCache } from "../../src/render/cache.js";
import { browserAvailable, openArtifact } from "../../src/audit/browser.js";
import { runPassB } from "../../src/audit/pass-b.js";
import { runAudit } from "../../src/audit/run.js";
import type { Atlas } from "../../src/schema/types.js";
import type { AuditContext } from "../../src/audit/types.js";
import { buildSyntheticSubject } from "./subject.js";

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
  dir = mkdtempSync(join(tmpdir(), "repo-atlas-passb-boundary-"));
  artifactPath = join(dir, "atlas.html");
  writeFileSync(artifactPath, artifact, "utf8");
  ctx = { artifact, atlas: subject.atlas, clone: subject.clone };
}, 180_000);

afterAll(async () => {
  await disposeHighlighter();
});

describeBrowser("a throwing browser check becomes a defined failure, not a crash", () => {
  it("does not let the exception escape runPassB", async () => {
    const before = launched.length;
    const result = await runPassB(artifactPath, ctx.atlas);
    // The throwing check is aborted by name, carrying the underlying error.
    const l4 = result.checks.find((c) => c.id === "L4");
    expect(l4?.outcome).toBe("failed");
    expect(l4?.aborted).toBe(true);
    expect((l4?.findings ?? []).join(" ")).toMatch(/page context was destroyed/);
    // Never a pass.
    expect(result.checks.some((c) => c.aborted && c.outcome === "passed")).toBe(false);
    // A blocking abort stops the pass: the checks after L4 are not run, and no
    // layout was measured on a doomed page.
    expect(result.checks.map((c) => c.id)).toEqual(["S2", "S3", "S4", "L4"]);
    expect(result.measurements).toEqual([]);
    // And the browser it launched was closed on that path.
    const browser = launched[launched.length - 1];
    expect(launched.length).toBe(before + 1);
    expect(browser!.connected).toBe(false);
  }, 180_000);

  it("fails runAudit as a precondition and names the checks it never reached", async () => {
    const outcome = await runAudit(ctx, { artifactPath });
    expect(outcome.status).toBe("failed");
    expect(outcome.failure_kind).toBe("precondition");
    const l4 = outcome.checks.find((c) => c.id === "L4");
    expect(l4?.aborted).toBe(true);
    // The pass B checks after L4 are reported by name as not run, not dropped.
    for (const id of ["E1", "V1", "V2", "V3"]) {
      const c = outcome.checks.find((x) => x.id === id);
      expect(c?.outcome, `${id} should be not_run`).toBe("not_run");
      expect(c?.reason, `${id} not_run without a reason`).toBeTruthy();
    }
    // The full register is still reported, and an aborted check never counts as a
    // passing gate.
    expect(outcome.checks).toHaveLength(20);
    expect(outcome.checks.some((c) => c.aborted && c.outcome === "passed")).toBe(false);
  }, 180_000);
});

describeBrowser("a load failure leaves no browser behind", () => {
  it("closes the browser and surfaces the real error when the artifact cannot be opened", async () => {
    const before = launched.length;
    await expect(openArtifact(join(dir, "does-not-exist.html"))).rejects.toThrow(
      /ERR_FILE_NOT_FOUND/,
    );
    expect(launched.length).toBe(before + 1);
    expect(launched[launched.length - 1]!.connected).toBe(false);
  }, 120_000);
});

describeBrowser("a pass B load failure fails runAudit as a precondition, not a crash", () => {
  it("names the underlying error and preserves pass A rather than degrading to exit 70", async () => {
    // Pass A runs from ctx and passes; pass B is pointed at a path that cannot be
    // opened, so openArtifact throws a non-NoBrowserError before runPassB's own
    // boundary. runAudit must classify that as a precondition failure - the audit
    // could not see the artifact - never let the exception escape.
    // runAudit must resolve, never reject: an escaping exception here is the exit
    // 70 crash-instead-of-report this fix closes.
    const outcome = await runAudit(ctx, { artifactPath: join(dir, "does-not-exist.html") });

    expect(outcome.status).toBe("failed");
    expect(outcome.failure_kind).toBe("precondition");
    // The real cause is surfaced, not a bare classification.
    expect(outcome.preconditions.join(" ")).toMatch(/ERR_FILE_NOT_FOUND/);

    // Pass A's real answers survive rather than being thrown away: every pass A
    // check actually ran (never reported as not_run), and at least one passed.
    const passA = ["S1", "G1", "G2", "G3", "E2", "L5", "L1", "L2", "P1"];
    for (const id of passA) {
      const c = outcome.checks.find((x) => x.id === id);
      expect(c?.outcome, `${id} should have run in pass A`).not.toBe("not_run");
    }
    expect(passA.some((id) => outcome.checks.find((c) => c.id === id)?.outcome === "passed")).toBe(
      true,
    );

    // Every pass B check is reported by name as not run, carrying the cause.
    for (const id of ["S2", "S3", "S4", "L4", "E1", "V1", "V2", "V3"]) {
      const c = outcome.checks.find((x) => x.id === id);
      expect(c?.outcome, `${id} should be not_run`).toBe("not_run");
      expect(c?.reason ?? "", `${id} not_run without the cause`).toMatch(/ERR_FILE_NOT_FOUND/);
    }

    // The full register is still reported, and nothing was minted as a pass.
    expect(outcome.checks).toHaveLength(20);
    expect(outcome.checks.some((c) => c.outcome === "passed" && c.aborted)).toBe(false);
  }, 180_000);
});
