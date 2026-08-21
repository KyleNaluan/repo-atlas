import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { memoryDiagramCache } from "../../src/render/cache.js";
import { disposeHighlighter } from "../../src/render/highlight.js";
import { sectionFlows } from "../../src/render/sections.js";
import type { Atlas, FlowNode } from "../../src/schema/types.js";

const read = <T>(name: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  ) as T;

const atlas = read<Atlas>("swe-prep.atlas.json");

afterAll(async () => {
  await disposeHighlighter();
});

describe("section 04's FlowLink bridge", () => {
  it("renders distinct fan-out labels, link-owned evidence, and rank attribution", async () => {
    const fanOut = read<FlowNode>("flow-fan-out.json");
    const rendered = (await sectionFlows(atlas, [fanOut], memoryDiagramCache())).toString();

    for (const label of ["PASSED rows", "terminal rep attempts", "terminal challenge attempts"]) {
      expect(rendered).toContain(label);
    }
    expect(rendered).toContain("Arrow evidence (3)");
    for (const command of [
      "trace learned predicate",
      "trace rep due predicate",
      "trace challenge predicate",
    ]) {
      expect(rendered).toContain(command);
    }
    expect(rendered).toContain('data-ev="fl-link-fan-out:links[0].evidence[0]"');
    expect(rendered).toContain("value 5/5");
    expect(rendered).toContain("rubric v1");
  });

  it("uses a generic aside legend", async () => {
    const linked = read<FlowNode>("flow-request-side-path.json");
    const rendered = (await sectionFlows(atlas, [linked], memoryDiagramCache())).toString();
    expect(rendered).toContain("side path or side effect");
    expect(rendered).not.toContain("outside the transaction");
  });

  it("keeps the approved honest-absence panel when no Flow survives", async () => {
    const rendered = (await sectionFlows(atlas, [], memoryDiagramCache())).toString();
    expect(rendered.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).toContain(
      "Traced flows - nothing surfaced. No flow survived the confidence gate.",
    );
  });
});
