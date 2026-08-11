/**
 * The audit's per-check error boundary.
 *
 * Review rounds 3-7 on this branch were all one shape: a robustness hole
 * surfacing as crash-instead-of-report (uncaught readdir/stat, symlink
 * recursion, locale-dependent git error parsing, uncaught GitError). #8 defines
 * exactly four outcome states and a stack trace is not one of them, so an
 * unexpected throw from ANY check must become a defined `failed` outcome that
 * names the check, never an unhandled exception and never a pass. This proves
 * the boundary closes the class rather than one throw site: a check that throws
 * is reported as aborted by name, the run is not passed, and the checks it never
 * reached are still named.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A git backend failure that is not a numeric path-absent (a >64MB blob, git
// killed by a signal) makes blobAt throw GitError. Force exactly that so the
// L1/L2 step's boundary is exercised without a 64MB fixture.
vi.mock("../../src/audit/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/audit/git.js")>();
  return {
    ...actual,
    blobAt: () => {
      throw new actual.GitError("git cat-file could not run: the backend fell over");
    },
  };
});

import { render } from "../../src/render/render.js";
import { disposeHighlighter } from "../../src/render/highlight.js";
import { memoryDiagramCache } from "../../src/render/cache.js";
import { audit } from "../../src/audit/run.js";
import { runPassA } from "../../src/audit/pass-a.js";
import type { AuditContext } from "../../src/audit/types.js";
import type { Atlas } from "../../src/schema/types.js";
import { buildSyntheticSubject } from "./subject.js";

const fixture = (name: string): Atlas =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  ) as Atlas;

let ctx: AuditContext;

beforeAll(async () => {
  const subject = buildSyntheticSubject(fixture("swe-prep.atlas.json"));
  ctx = {
    artifact: await render(subject.atlas, { cache: memoryDiagramCache() }),
    atlas: subject.atlas,
    clone: subject.clone,
  };
}, 120_000);

afterAll(async () => {
  await disposeHighlighter();
});

describe("a check that throws becomes a defined failure, not a crash", () => {
  it("does not let the exception escape runPassA or audit()", () => {
    expect(() => runPassA(ctx)).not.toThrow();
    expect(() => audit(ctx)).not.toThrow();
  });

  it("records the throwing check as failed by name, with the underlying error", () => {
    const results = new Map(runPassA(ctx).map((r) => [r.id, r]));
    // resolveFileEvidence owns L1 and L2 together; blobAt throws inside it.
    for (const id of ["L1", "L2"]) {
      const r = results.get(id);
      expect(r, `${id} was not reported`).toBeDefined();
      expect(r!.outcome).toBe("failed");
      expect(r!.aborted).toBe(true);
      expect((r!.findings ?? []).join(" ")).toMatch(/the backend fell over/);
    }
    // An aborted check is never recorded as a pass.
    expect([...results.values()].some((r) => r.aborted && r.outcome === "passed")).toBe(false);
  });

  it("fails the overall verdict, classified as a precondition finding, never a pass", () => {
    const outcome = audit(ctx);
    expect(outcome.status).toBe("failed");
    expect(outcome.failure_kind).toBe("precondition");
    // The whole point: an aborted check must never count toward the passing gate
    // tally, and it does not, because it is `failed`.
    const passingGate = outcome.checks.some(
      (c) => c.aborted && c.class === "gate" && c.outcome === "passed",
    );
    expect(passingGate).toBe(false);
  });

  it("still names the checks it never reached rather than dropping them", () => {
    const outcome = audit(ctx);
    // The full register is still reported.
    expect(outcome.checks).toHaveLength(20);
    // P1 sits after L1/L2 in pass A; the abort stopped the pass, so it is carried
    // as not_run with a reason rather than silently omitted.
    const p1 = outcome.checks.find((c) => c.id === "P1");
    expect(p1?.outcome).toBe("not_run");
    expect(p1?.reason).toMatch(/stopped at an earlier gate/);
    for (const c of outcome.checks) {
      if (c.outcome === "not_run") expect(c.reason, `${c.id} not_run without a reason`).toBeTruthy();
    }
  });
});
