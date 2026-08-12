/**
 * The model SDK has exactly one call site, and this fails the build if a second
 * appears.
 *
 * The same shape as the renderer's `raw()` lint, for the same reason. Three
 * stages ask a model something and each one wrote its own options; all three got
 * the tool restriction wrong in the same way, because `allowedTools: []` reads
 * like it disables tools and does not - it is a permission allowlist, while
 * `tools: []` is what removes them from the model's context.
 *
 * A fourth caller writing its own options would reintroduce that silently: a
 * scorer or judge that can read the tree still returns plausible output, so
 * nothing fails and the guarantee just stops holding. Keeping the SDK behind one
 * function makes the restriction structural rather than remembered.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });

const rel = (path: string) => path.slice(SRC.length + 1);

describe("the model SDK is reached through one function", () => {
  const files = sources(SRC);

  it("is imported in exactly one file", () => {
    const importers = files.filter((f) =>
      readFileSync(f, "utf8").includes('from "@anthropic-ai/claude-agent-sdk"'),
    );
    expect(importers.map(rel)).toEqual(["model/ask.ts"]);
  });

  it("has no second place passing tool options to it", () => {
    // `allowedTools` outside ask.ts means someone is configuring a query
    // elsewhere, which is how the three copies drifted in the first place.
    const offenders = files.filter((f) => {
      if (rel(f) === "model/ask.ts") return false;
      const text = readFileSync(f, "utf8");
      // A mention inside a comment is a reference, not a call site; the check is
      // for the option actually being passed.
      return /allowedTools\s*:/.test(text) || /\btools\s*:\s*\[/.test(text);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("disables the built-in tools rather than only witholding permission", () => {
    // The distinction the whole file exists for, asserted rather than trusted to
    // a comment: `tools: []` empties the model's tool context; `allowedTools: []`
    // only governs what may execute.
    const ask = readFileSync(join(SRC, "model/ask.ts"), "utf8");
    expect(ask).toMatch(/tools:\s*\[\]/);
    expect(ask).toMatch(/allowedTools:\s*\[\]/);
  });
});
