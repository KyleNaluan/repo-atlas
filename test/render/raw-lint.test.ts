/**
 * The `raw()` single-call-site lint.
 *
 * #7 kept raw() to one call site (the Graphviz SVG) as a discipline; #8 made it
 * a contract, because raw HTML carries no `data-ev` and no `data-chrome`, so a
 * second call site is a hole in the provenance stamp that check E1 cannot see.
 * A lint is the only thing that keeps that true as the renderer grows - the
 * defect it prevents is invisible in review of the line that introduces it.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { SLOT_ATTR } from "../../src/artifact/audit-slot.js";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });

describe("the raw() escape hatch", () => {
  it("has exactly one call site in the whole renderer", () => {
    const sites: string[] = [];
    for (const file of walk(SRC)) {
      // html.ts declares raw(); everywhere else, a mention is a call site.
      if (file.endsWith(join("render", "html.ts"))) continue;
      // Comments discuss the rule; only code can break it.
      const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) =>
        m.replace(/[^\n]/g, " "),
      );
      for (const [index, line] of text.split("\n").entries()) {
        const code = line.replace(/\/\/.*$/, "");
        if (/(?<![\w.])raw\(/.test(code)) sites.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(sites, `raw() call sites:\n${sites.join("\n")}`).toHaveLength(1);
    expect(sites[0]).toContain("raw(svg)");
  });
});

describe("the audit slot marker", () => {
  it("is written literally in the renderer and matches the shared constant", () => {
    // The renderer writes the attribute as a literal rather than interpolating
    // SLOT_ATTR, because interpolating it would need a second raw() call site.
    // This test is what keeps the literal and the constant from drifting.
    const sections = readFileSync(join(SRC, "render", "sections.ts"), "utf8");
    expect(sections).toContain(`${SLOT_ATTR}="statement"`);
    expect(sections).toContain(`${SLOT_ATTR}="badge"`);
  });
});
