/**
 * A consumer never imports `../../src/...` - it imports the published
 * subpath, resolved through `package.json`'s `exports` map against the
 * *built* `dist/`, the same way a downstream install would. This test
 * exercises exactly that seam for the render surface exposed at `./render`: it
 * builds the package first (a fresh consumer would receive it already
 * built), then imports `repo-atlas/render` by package name rather than by
 * relative path, and renders a fixture Flow to confirm the WASM Graphviz
 * dependency loads and produces real SVG outside this repo's own dev build.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

beforeAll(() => {
  if (!existsSync(join(root, "dist", "render", "index.js"))) {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  }
}, 60_000);

describe("repo-atlas/render (published subpath)", () => {
  it("renders a fixture FlowNode to non-empty SVG through the package export", async () => {
    const { renderFlow, toDot } = await import("repo-atlas/render");
    const flow = JSON.parse(
      readFileSync(join(root, "test", "fixtures", "flow-fan-out.json"), "utf8"),
    );

    const dot = toDot(flow);
    expect(dot).toContain("digraph flow");

    const { svg, dot: renderedDot, depth } = await renderFlow(flow);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(svg).not.toContain("<?xml");
    expect(renderedDot).toBe(dot);
    expect(depth).toBeGreaterThan(0);
  });
});
