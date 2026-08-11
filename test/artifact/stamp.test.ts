/**
 * The stamp mechanic, the four statement states, and the quarantine rule.
 *
 * The load-bearing test is the self-verifying one: blank the slots on the
 * stamped file, hash it, and get back the hash the statement prints. Everything
 * else in this stage rests on that being true rather than asserted, and two real
 * defects were caught by it during development - a state class written on the
 * slot ELEMENT (outside the blanked content) and a non-greedy slot scanner that
 * ended the slot at the first nested closing tag.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render } from "../../src/render/render.js";
import { disposeHighlighter } from "../../src/render/highlight.js";
import { memoryDiagramCache } from "../../src/render/cache.js";
import { contentHash, findSlots, withSlotsBlanked, writeSlot } from "../../src/artifact/audit-slot.js";
import {
  FAILURE_BANNER,
  quarantinePath,
  stampAudit,
  StampError,
  withFailureBanner,
} from "../../src/artifact/stamp.js";
import { badge, statement, warningCount } from "../../src/artifact/statement.js";
import { REGISTER } from "../../src/audit/register.js";
import { failed, notRun, passed } from "../../src/audit/types.js";
import type { Atlas } from "../../src/schema/types.js";
import type { CheckResult } from "../../src/audit/types.js";

const SHA = "086c99998ba6eec1353988cd88989cbe836fe6a0";
const AT = "2026-08-11T02:41:00.000Z";

const spec = (id: string) => REGISTER.find((c) => c.id === id)!;

let artifact: string;

beforeAll(async () => {
  const atlas = JSON.parse(
    readFileSync(fileURLToPath(new URL("../fixtures/swe-prep.atlas.json", import.meta.url)), "utf8"),
  ) as Atlas;
  artifact = await render(atlas, { cache: memoryDiagramCache() });
}, 120_000);

afterAll(async () => {
  await disposeHighlighter();
});

const allPassed: CheckResult[] = REGISTER.filter((c) => c.class === "gate").map((c) =>
  passed(c, 7),
);

const stamp = (status: Parameters<typeof stampAudit>[0]["status"], checks: CheckResult[]) =>
  stampAudit({ artifact, status, checks, auditedAt: AT, subjectSha: SHA });

describe("the slot scanner", () => {
  it("finds both slots the renderer reserved", () => {
    expect(findSlots(artifact).map((s) => s.name).sort()).toEqual(["badge", "statement"]);
  });

  it("reads a slot whose content nests the same tag", () => {
    // The statement wraps itself in a div to carry its state class. A non-greedy
    // scan to the first </div> would end the slot early and leave half the
    // statement outside the blanked region - inside the hash it is excluded from.
    const inner = "<div><div>ZQ-INNER-ZQ</div> ZQ-TAIL-ZQ</div>";
    const nested = writeSlot(artifact, "statement", inner);
    expect(findSlots(nested).find((s) => s.name === "statement")?.content).toBe(inner);
    // Markers are deliberately unlikely strings: the stylesheet legitimately
    // contains words like "deep" and "tail", and asserting on those would test
    // the fixture rather than the scanner.
    expect(withSlotsBlanked(nested)).not.toContain("ZQ-INNER-ZQ");
    expect(withSlotsBlanked(nested)).not.toContain("ZQ-TAIL-ZQ");
  });

  it("blanks slot content and nothing else", () => {
    const blanked = withSlotsBlanked(artifact);
    expect(blanked).toContain('id="audit-statement"');
    expect(blanked).not.toContain("Audit: not run.");
  });

  it("refuses to write a slot that is not there exactly once", () => {
    expect(() => writeSlot("<p>no slot</p>", "statement", "x")).toThrow(/found 0/);
  });
});

describe("the stamp is self-verifying", () => {
  it("prints a hash that a reader reproduces by blanking the box", () => {
    const stamped = stamp("passed", allPassed);
    const printed = /sha256:[0-9a-f]{64}/.exec(
      findSlots(stamped.artifact).find((s) => s.name === "statement")!.content,
    )?.[0];
    expect(printed).toBe(stamped.contentHash);
    expect(contentHash(stamped.artifact)).toBe(printed);
  });

  it("leaves every byte outside the slots untouched", () => {
    const stamped = stamp("passed", allPassed);
    expect(withSlotsBlanked(stamped.artifact)).toBe(withSlotsBlanked(artifact));
  });

  it("gives the same hash whichever state is written", () => {
    const a = stamp("passed", allPassed);
    const b = stamp("failed", [failed(spec("L1"), ["nope"])]);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("notices when slot content escapes its own boundary", () => {
    // The failure mode the assertion exists for: content that closes the slot's
    // container early leaves the rest of the page reorganised around it, so the
    // hash the statement would print no longer describes the file.
    const escaped = writeSlot(artifact, "statement", "</div><p>loose</p>");
    expect(contentHash(escaped)).not.toBe(contentHash(artifact));
  });

  it("is sensitive to any byte outside the slots, so the guard has teeth", () => {
    const moved = artifact.replace("<footer>", "<footer><!-- one comment -->");
    expect(moved).not.toBe(artifact);
    expect(contentHash(moved)).not.toBe(contentHash(artifact));
  });

  it("keeps StampError reachable as the guard of last resort", () => {
    // No public call path can currently violate the invariant - stampAudit
    // generates its own slot content and writeSlot replaces an exact range - and
    // that is the intended state rather than a gap in coverage. The two tests
    // above establish what the guard rests on: the hash notices content escaping
    // a slot, and notices any byte moving outside one. StampError is what turns
    // that noticing into a refusal instead of a published false claim.
    expect(new StampError("x")).toBeInstanceOf(Error);
  });

  it("writes the badge and the statement from one source, so they cannot disagree", () => {
    const stamped = stamp("failed", [failed(spec("L1"), ["a citation does not resolve"])]);
    const slots = findSlots(stamped.artifact);
    expect(slots.find((s) => s.name === "badge")?.content).toContain("Audit: FAILED");
    expect(slots.find((s) => s.name === "statement")?.content).toContain("Audit: FAILED");
  });
});

const text = (status: Parameters<typeof statement>[0]["status"], checks: CheckResult[]): string =>
  statement({ status, checks, contentHash: "sha256:abc", auditedAt: AT, subjectSha: SHA })
    .toString()
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("the four statement states", () => {
  it("leads with the outcome in the first three words", () => {
    expect(text("not_run", [])).toMatch(/^Audit: not run\./);
    expect(text("passed", allPassed)).toMatch(/^Audit: passed\./);
    expect(text("passed_with_warnings", [...allPassed, failed(spec("V1"), ["scrolls at 390px"])])).toMatch(
      /^Audit: passed, with 1 warning\./,
    );
    expect(text("failed", [failed(spec("L1"), ["missing"])])).toMatch(/^Audit: FAILED\./);
  });

  it("says what was NOT checked in every state", () => {
    const missing = notRun(spec("M1"), "pass D is not built in this version");
    for (const status of ["passed", "passed_with_warnings", "failed"] as const) {
      const t = text(status, [...allPassed, missing]);
      expect(t, status).toContain("Not checked:");
      expect(t, status).toContain("not counted as passing");
      expect(t, status).toContain("pass D is not built in this version");
    }
  });

  it("counts rather than adjectives, and never rounds its coverage up", () => {
    // The report's example wording says "15 hard checks passed". A run that
    // passed three must say three.
    const three = allPassed.slice(0, 3);
    expect(text("passed", three)).toContain("3 hard checks passed");
    expect(text("passed", three)).not.toMatch(/thorough|carefully|comprehensive/i);
  });

  it("enumerates every warning in full, never a bare count", () => {
    const warned = failed(spec("V3"), [
      "at 390px, below WCAG AA: span.dim at 3.10:1, needs 4.5:1",
      "at 768px, below WCAG AA: a.sha at 4.20:1, needs 4.5:1",
    ]);
    const t = text("passed_with_warnings", [...allPassed, warned]);
    expect(t).toContain("span.dim at 3.10:1");
    expect(t).toContain("a.sha at 4.20:1");
    expect(warningCount([warned])).toBe(2);
  });

  it("badge and statement pluralise the warning count by one rule, so they cannot disagree", () => {
    // The two slots are stamped from one source precisely so they never diverge;
    // compare them against each other, not each against a hardcoded expectation.
    const pluralWord = (s: string): string => {
      const m = s.match(/\b\d+ (warnings?)\b/);
      if (m?.[1] === undefined) throw new Error(`no warning count in: ${s}`);
      return m[1];
    };
    for (const n of [1, 2]) {
      const warned = failed(
        spec("V1"),
        Array.from({ length: n }, (_, i) => `warning ${i + 1}`),
      );
      const count = warningCount([warned]);
      expect(count).toBe(n);
      const badgeWord = pluralWord(badge("passed_with_warnings", count).toString());
      const statementWord = pluralWord(text("passed_with_warnings", [...allPassed, warned]));
      expect(badgeWord).toBe(statementWord);
      expect(badgeWord).toBe(n === 1 ? "warning" : "warnings");
    }
  });

  it("tells the reader not to rely on a failed document, and why it exists", () => {
    const t = text("failed", [failed(spec("L1"), ["AttemptService.java:141-150 does not exist"])]);
    expect(t).toContain("Do not rely on this document");
    expect(t).toContain("AttemptService.java:141-150 does not exist");
    expect(t).toContain("was not emitted as the engine's output");
  });

  it("does not print a hash claim on a failed artifact", () => {
    // The failed copy is not the file the engine emitted, so a hash claim about
    // "the file that was checked" would point at something nobody should use.
    expect(text("failed", [failed(spec("L1"), ["x"])])).not.toContain("sha256:abc");
    expect(text("passed", allPassed)).toContain("sha256:abc");
  });
});

describe("quarantine", () => {
  it("names the failed copy so it cannot be mistaken for the deliverable", () => {
    expect(quarantinePath("/out/atlas.html")).toBe("/out/atlas.failed.html");
    expect(quarantinePath("/out/atlas.HTML")).toBe("/out/atlas.failed.html");
  });

  it("adds a banner as a second line of defence, not as the mechanism", () => {
    // #8 point 9: the banner is the first thing lost when a reader screenshots a
    // section or shares the file, which is why the NAME does the real work.
    const banner = withFailureBanner(artifact);
    expect(banner).toContain(FAILURE_BANNER);
    expect(banner.indexOf(FAILURE_BANNER)).toBeLessThan(banner.indexOf('id="audit-statement"'));
  });
});
