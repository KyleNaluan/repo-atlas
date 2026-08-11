/**
 * Every runtime asset the source loads must be in the published `files` list.
 *
 * `src/probes/java.ts` reads the vendored Java grammar with a URL relative to
 * the package root, so under npx / an installed package the file resolves next
 * to the package - and if `files` does not ship it, `readFileSync` throws ENOENT
 * and all three structural Java probes crash. Dev and test never catch this
 * because the source tree always has the asset; only a publish would. This test
 * fails the build if a runtime asset reference is not covered by `files`, so the
 * omission cannot recur silently.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
};

/** Distinct `assets/...` paths any source file loads at runtime. */
const referencedAssets = (): string[] => {
  const seen = new Set<string>();
  for (const file of sourceFiles(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/assets\/[A-Za-z0-9._/-]+/g)) seen.add(m[0]);
  }
  return [...seen];
};

/** npm publishes a `files` directory entry whole, so a prefix match covers it. */
const isCoveredBy = (asset: string, files: string[]): boolean =>
  files.some((f) => asset === f || asset.startsWith(`${f}/`));

describe("published package manifest", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };

  it("covers every runtime asset the source loads", () => {
    const assets = referencedAssets();
    // The guard only means something if it is watching a real reference.
    expect(assets).toContain("assets/tree-sitter-java.wasm");
    for (const asset of assets) {
      expect(existsSync(join(root, asset)), `${asset} is missing from the source tree`).toBe(true);
      expect(
        isCoveredBy(asset, pkg.files),
        `${asset} is loaded at runtime but not covered by package.json "files" (${pkg.files.join(", ")})`,
      ).toBe(true);
    }
  });
});
