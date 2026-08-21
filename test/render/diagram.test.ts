import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toDot } from "../../src/render/diagram.js";
import type { FlowLink, FlowNode } from "../../src/schema/types.js";

const fixture = (name: string): FlowNode =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
  ) as FlowNode;

const flow = (over: Partial<FlowNode>): FlowNode => ({
  type: "flow",
  id: "fl-test",
  title: "Test flow",
  evidence: [],
  confidence: "verified",
  interview_value: 3,
  steps: [],
  links: [],
  ...over,
});

describe("edge-level Flow links", () => {
  it("renders a linear request/response path and an explicitly dashed side path", () => {
    const dot = toDot(fixture("flow-request-side-path.json"));
    expect(dot).toContain("rankdir=TB");
    expect(dot).toContain('"entry" -> "service" [color="#7aa2f7", label="submit()"]');
    expect(dot).toContain(
      '"service" -> "response" [color="#7ec699", label="RunResponse"]',
    );
    expect(dot).toContain(
      '"service" -> "commit" [color="#d9a441", label="best effort", style=dashed]',
    );
  });

  it("keeps all distinct labels on a fan-out", () => {
    const dot = toDot(fixture("flow-fan-out.json"));
    for (const label of ["PASSED rows", "terminal rep attempts", "terminal challenge attempts"]) {
      expect(dot.match(new RegExp(`label="${label}"`, "g"))).toHaveLength(1);
    }
    expect(dot.match(/"attempt" ->/g)).toHaveLength(3);
  });

  it("renders a merge without duplicating its target", () => {
    const dot = toDot(
      flow({
        steps: [
          { id: "a", node: "A" },
          { id: "b", node: "B" },
          { id: "merge", node: "Merge", kind: "response" },
        ],
        links: [
          { id: "a-merge", from: "a", to: "merge", relation: "call", evidence: [] },
          { id: "b-merge", from: "b", to: "merge", relation: "call", evidence: [] },
        ],
      }),
    );
    expect(dot.match(/^  "merge" \[/gm)).toHaveLength(1);
    expect(dot).toContain('"a" -> "merge"');
    expect(dot).toContain('"b" -> "merge"');
  });

  it.each<[string, FlowLink]>([
    ["from", { id: "bad", from: "missing", to: "known", relation: "call", evidence: [] }],
    ["to", { id: "bad", from: "known", to: "missing", relation: "call", evidence: [] }],
  ])("refuses an unknown %s endpoint", (side, link) => {
    expect(() =>
      toDot(
        flow({
          steps: [{ id: "known", node: "Known" }],
          links: [link],
        }),
      ),
    ).toThrow(new RegExp(`link bad.*unknown ${side} step missing`));
  });

  it("keeps rendering legacy calls_next input", () => {
    const dot = toDot(fixture("flow-legacy.json"));
    expect(dot).toContain(
      '"old-source" -> "old-target" [color="#7ec699", label="legacy label"]',
    );
  });

  it("prefers an explicitly supplied links array over legacy edges", () => {
    const legacy = fixture("flow-legacy.json");
    expect(toDot({ ...legacy, links: [] })).not.toContain('"old-source" -> "old-target"');
  });
});
