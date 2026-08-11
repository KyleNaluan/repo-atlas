/**
 * The rendered artifact's contract.
 *
 * Five properties, each one a thing a later stage or a reader depends on:
 *
 *  - determinism (byte-identical output for identical input), because #9's
 *    rubric fixture and every golden below depend on stable ordering;
 *  - self-containment, the property the whole "static artifact" claim rests on;
 *  - the two absence phrasings, golden-pinned so they cannot rot - #8 point 10
 *    puts this test in render CI rather than in the audit, because phrasing rot
 *    is a code change and this catches it in milliseconds with no subject;
 *  - the chrome inventory, which is how the renderer DECLARES its own sentences
 *    so #8's check E1 can tell them from graph-derived prose;
 *  - no audit conclusion outside the audit slot, which is #8 ruling 1 and the
 *    single defect the whole audit contract was written around.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render } from "../../src/render/render.js";
import { disposeHighlighter } from "../../src/render/highlight.js";
import { memoryDiagramCache } from "../../src/render/cache.js";
import { findExternalRefs } from "../../src/artifact/self-contained.js";
import { contentHash, findSlots, writeSlot } from "../../src/artifact/audit-slot.js";
import { loadAtlas } from "../../src/schema/validate.js";
import type { Atlas } from "../../src/schema/types.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const goldenPath = (name: string): string =>
  fileURLToPath(new URL(`../golden/${name}`, import.meta.url));

/** `UPDATE_GOLDEN=1 npx vitest run` rewrites the goldens deliberately. */
const updating = process.env["UPDATE_GOLDEN"] === "1";

const golden = (name: string, actual: string): void => {
  if (updating || !existsSync(goldenPath(name))) {
    writeFileSync(goldenPath(name), actual, "utf8");
    if (!updating) throw new Error(`golden ${name} did not exist; wrote it - review and re-run`);
    return;
  }
  expect(actual, `golden ${name} differs; re-run with UPDATE_GOLDEN=1 once the change is intended`)
    .toBe(readFileSync(goldenPath(name), "utf8"));
};

let rich: string;
let degraded: string;
let richAtlas: Atlas;
let degradedAtlas: Atlas;

beforeAll(async () => {
  richAtlas = loadAtlas(fixturePath("swe-prep.atlas.json"));
  degradedAtlas = loadAtlas(fixturePath("degraded.atlas.json"));
  rich = await render(richAtlas, { cache: memoryDiagramCache() });
  degraded = await render(degradedAtlas, { cache: memoryDiagramCache() });
}, 120_000);

afterAll(async () => {
  await disposeHighlighter();
});

/** Every `<span data-chrome>` body, tags stripped and whitespace collapsed. */
const chromeStrings = (artifact: string): string[] => {
  const spans = [...artifact.matchAll(/<span data-chrome>((?:(?!<\/?span[\s>])[\s\S])*?)<\/span>/g)];
  const opens = (artifact.match(/<span data-chrome>/g) ?? []).length;
  expect(spans.length, "a chrome span contains a nested span, which this extractor cannot read")
    .toBe(opens);
  return [
    ...new Set(
      spans
        .map((m) =>
          (m[1] ?? "")
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            // Counts are data; the inventory is about PHRASING, which is what
            // #8 point 10 puts in render CI. Normalising digits keeps a
            // one-mechanism subject and a five-mechanism one on the same row,
            // so the golden moves only when the words move.
            .replace(/\d+/g, "#")
            .trim(),
        )
        .filter((s) => s.length > 0),
    ),
  ].sort();
};

describe("determinism", () => {
  it("renders byte-identically from the same input", async () => {
    const again = await render(richAtlas, { cache: memoryDiagramCache() });
    expect(again).toBe(rich);
  }, 120_000);

  it("does not depend on the diagram cache being warm or cold", async () => {
    const cache = memoryDiagramCache();
    const cold = await render(richAtlas, { cache });
    const warm = await render(richAtlas, { cache });
    expect(warm).toBe(cold);
  }, 120_000);

  it("pins the rendered bytes of both reference inputs", () => {
    // A hash rather than the whole 200 KB file: the readable goldens below carry
    // the diff signal, and this carries the byte-identity claim.
    golden(
      "artifact-hashes.txt",
      [
        `swe-prep.atlas.json  ${contentHash(rich)}`,
        `degraded.atlas.json  ${contentHash(degraded)}`,
        "",
      ].join("\n"),
    );
  });
});

describe("self-containment", () => {
  it("references no external resource in either artifact", () => {
    expect(findExternalRefs(rich)).toEqual([]);
    expect(findExternalRefs(degraded)).toEqual([]);
  });

  it("inlines the diagrams rather than linking them", () => {
    expect(rich).toContain('<svg class="atlas-diagram"');
    expect(rich).not.toMatch(/<img\b/);
  });

  it("highlights code without a second raw-HTML hole", () => {
    expect(rich).toMatch(/<code class="lang-java">/);
    expect(rich).toMatch(/<span style="color:#[0-9a-fA-F]{3,8}">/);
  });
});

describe("absence is stated in place, in one of two approved phrasings", () => {
  it("pins the phrasings", () => {
    const panels = [...degraded.matchAll(/<div class="absence">([\s\S]*?)<\/div>/g)].map((m) =>
      (m[1] ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
    );
    expect(panels.length).toBeGreaterThan(0);
    golden("absence-phrasing.txt", `${panels.join("\n\n")}\n`);
  });

  it('says "absent from the record" only in the decision section', () => {
    // #7 point 2: only the decision section makes a claim ABOUT a record. Using
    // that phrasing for a mechanism section would smuggle in a claim that some
    // record exists and was missed. #8 point 10 makes this a runtime gate too.
    for (const artifact of [rich, degraded]) {
      const sections = artifact.split(/<section id="/);
      for (const section of sections) {
        if (section.includes("absent from the record")) {
          expect(section.startsWith("decisions")).toBe(true);
        }
      }
    }
  });

  it('uses "nothing surfaced" for every other empty section', () => {
    expect(degraded).toContain("nothing surfaced");
  });

  it("renders exactly one absence panel per empty section, in its own slot", () => {
    const deep = degraded.split('<section id="deep"')[1]?.split("</section>")[0] ?? "";
    expect(deep.match(/<div class="absence">/g) ?? []).toHaveLength(1);
    // Section numbering stays stable across subjects: the slot is still there.
    for (const id of ["what", "qa", "shape", "flow", "decisions", "deep", "edges", "record", "index"]) {
      expect(degraded).toContain(`<section id="${id}">`);
    }
  });
});

describe("the chrome inventory", () => {
  it("pins every sentence the renderer is allowed to say on its own account", () => {
    // The union of both subjects, because a rich artifact and a degraded one
    // reach different chrome (absence panels, cut lines, pluralisation).
    const all = [...new Set([...chromeStrings(rich), ...chromeStrings(degraded)])].sort();
    golden("chrome-inventory.txt", `${all.join("\n")}\n`);
  });

  it("stamps graph-derived prose separately, and there is a lot of it", () => {
    const stamped = new Set(
      [...rich.matchAll(/data-ev="([^"]+)"/g)].map((m) => (m[1] ?? "").split(":")[0]),
    );
    // Every surviving node should have contributed at least one stamped passage.
    for (const node of richAtlas.nodes.filter((n) => n.confidence !== "absent")) {
      expect(stamped, `${node.id} contributed no stamped prose`).toContain(node.id);
    }
  });
});

describe("the audit slot", () => {
  it("reserves exactly two machine-addressable slots, and nothing else writes them", () => {
    expect(findSlots(rich).map((s) => s.name).sort()).toEqual(["badge", "statement"]);
  });

  it("renders the `not run` statement, because at render time that is the truth", () => {
    const statement = findSlots(rich).find((s) => s.name === "statement")?.content ?? "";
    expect(statement).toContain("Audit: not run.");
    expect(statement).toContain("Read it as asserted, not verified.");
  });

  it("hashes the same before and after the slot is rewritten", () => {
    // This is what makes "this page, excluding this box, hashes to X" a claim
    // the reader can check rather than one they have to take on trust.
    const before = contentHash(rich);
    const stamped = writeSlot(rich, "statement", "<p>Audit: passed. 15 hard checks passed.</p>");
    expect(stamped).not.toBe(rich);
    expect(contentHash(stamped)).toBe(before);
  });

  it("refuses to write a slot that is not there exactly once", () => {
    expect(() => writeSlot("<p>no slot</p>", "statement", "x")).toThrow(/found 0/);
  });
});

describe("no audit conclusion appears outside the audit slot", () => {
  const outsideSlots = (artifact: string): string =>
    artifact.replace(/<span class="audit-badge"[\s\S]*?<\/span>/, "").replace(
      /<div id="audit-statement"[\s\S]*?<\/div>/,
      "",
    );

  it("drops the prototype's unearned footer assertions", () => {
    // These were checks E1, E2, P1 and L1 of #8's register, asserted as fact by
    // the stage least able to establish them - while the same page said the
    // audit had never run.
    for (const artifact of [rich, degraded]) {
      const body = outsideSlots(artifact);
      expect(body).not.toMatch(/[Ee]very claim above traces/);
      expect(body).not.toMatch(/No private problem content/);
      expect(body).not.toMatch(/All file links resolve/);
      expect(body).not.toMatch(/Verified, not asserted/);
    }
  });

  it("says nothing about an audit outcome anywhere else on the page", () => {
    for (const artifact of [rich, degraded]) {
      expect(outsideSlots(artifact)).not.toMatch(/Audit: (not run|passed|FAILED)/);
    }
  });

  it("points the reader at the one box that does make that claim", () => {
    expect(rich).toContain('href="#audit-statement"');
  });
});

describe("the renderer is not a second authority over what survives", () => {
  it("renders every admissible node it is handed", () => {
    const admissible = richAtlas.nodes.filter((n) => n.confidence !== "absent");
    for (const n of admissible) expect(rich).toContain(`id="${n.id}"`);
  });

  it("renders no node the confidence gate cut", () => {
    const absent = richAtlas.nodes.filter((n) => n.confidence === "absent");
    for (const n of absent) expect(rich).not.toContain(`id="${n.id}"`);
  });

  it("reports the rank stage's section cuts without making them", () => {
    const text = rich.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
    expect(text).toContain("1 further mechanism scored above the value floor");
  });

  it("shows the deleted ids only as table text in the deletion record, never as an anchor", () => {
    // #8's G2: the check is structural. The ids appear in The record's collapsed
    // deletion table, which the `absent-cut-disclosure` ruling permits.
    for (const d of richAtlas.record.deletions) {
      expect(rich).toContain(`<code>${d.id}</code>`);
      expect(rich).not.toContain(`id="${d.id}"`);
      expect(rich).not.toContain(`href="#${d.id}"`);
    }
  });
});
