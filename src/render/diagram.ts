/**
 * Flow node -> Graphviz `dot` -> inline SVG.
 *
 * The one hard constraint from #7: no hand-placed coordinates, ever. Every box
 * position, every edge route and every label placement comes from Graphviz's own
 * layout, measured with Graphviz's own font metrics. The renderer decides what
 * the graph IS; it never decides where anything goes. Hand-authoring SVG cost as
 * much as the hardest deep dive in discovery and produced no comprehension.
 *
 * Graphviz runs as WebAssembly (`@hpcc-js/wasm-graphviz`), so there is no native
 * binary and no system package to install - `npx repo-atlas` works on a clean
 * machine - and the SVG is inlined at build time, so the artifact makes no
 * request and does not compute its own layout at read time.
 */
import { Graphviz } from "@hpcc-js/wasm-graphviz";
import { createHash } from "node:crypto";
import type { FlowLink, FlowNode, FlowStep } from "../schema/types.js";

/**
 * Graphviz measures Helvetica/Times/Courier with built-in metrics, needing no
 * fontconfig. The page CSS must NOT override font-family inside the SVG or the
 * boxes and the text stop agreeing - which is exactly the overflow bug that made
 * hand-authored SVG expensive.
 */
const TITLE_FONT = "Helvetica";
const DETAIL_FONT = "Courier";

/** #7 point 9: diagram quality is bounded by how a Flow is modelled. */
export const LONG_FLOW_STEPS = 8;

const COLORS = {
  box: "#39445a",
  boxFill: "#1c2129",
  boxFillResponse: "#12212a",
  boxStrokeResponse: "#28503f",
  boxFillAside: "#241f14",
  boxStrokeAside: "#5a4a2a",
  title: "#e6e9ee",
  detail: "#a3adbb",
  request: "#7aa2f7",
  response: "#7ec699",
  aside: "#d9a441",
  label: "#8b95a3",
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const quote = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

/** A step's HTML-like label: bold title, then left-aligned detail lines. */
const label = (step: FlowStep): string => {
  const title = `<b><font point-size="12" face="${TITLE_FONT}" color="${COLORS.title}">${esc(step.node)}</font></b>`;
  if (!step.detail) return `<${title}>`;
  const lines = step.detail
    .split("\\l")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `${esc(l)}<br align="left"/>`)
    .join("");
  const detail = `<font point-size="9" face="${DETAIL_FONT}" color="${COLORS.detail}">${lines}</font>`;
  return `<${title}<br/><br align="left"/>${detail}>`;
};

const nodeAttrs = (step: FlowStep): string => {
  const kind = step.kind ?? "request";
  const fill =
    kind === "response"
      ? COLORS.boxFillResponse
      : kind === "aside"
        ? COLORS.boxFillAside
        : COLORS.boxFill;
  const stroke =
    kind === "response"
      ? COLORS.boxStrokeResponse
      : kind === "aside"
        ? COLORS.boxStrokeAside
        : COLORS.box;
  return [
    `label=${label(step)}`,
    `shape=box`,
    `style="filled,rounded"`,
    `fillcolor=${quote(fill)}`,
    `color=${quote(stroke)}`,
    `penwidth=1.2`,
    `margin="0.16,0.11"`,
  ].join(", ");
};

type FlowKind = NonNullable<FlowLink["kind"]>;

const edgeAttrs = (kind: FlowKind, edgeLabel?: string): string => {
  const color =
    kind === "response" ? COLORS.response : kind === "aside" ? COLORS.aside : COLORS.request;
  const attrs = [`color=${quote(color)}`];
  if (edgeLabel) attrs.push(`label=${quote(edgeLabel)}`);
  if (kind === "aside") attrs.push(`style=dashed`);
  return attrs.join(", ");
};

export const toDot = (flow: FlowNode): string => {
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  const lines: string[] = [
    "digraph flow {",
    `  rankdir=${flow.orientation ?? "LR"};`,
    `  bgcolor="transparent";`,
    `  nodesep=0.42; ranksep=0.62;`,
    `  node [fontname="${TITLE_FONT}"];`,
    `  edge [fontname="${DETAIL_FONT}", fontsize=9, fontcolor="${COLORS.label}", penwidth=1.4, arrowsize=0.75];`,
  ];
  for (const step of flow.steps) lines.push(`  ${quote(step.id)} [${nodeAttrs(step)}];`);

  // Presence, not length, selects the new contract. An explicit empty links
  // array means this graph has no edges; falling back in that case would merge
  // two authorities and resurrect legacy edges the author deliberately replaced.
  if (flow.links !== undefined) {
    for (const link of flow.links) {
      const from = byId.get(link.from);
      const to = byId.get(link.to);
      if (!from || !to) {
        const endpoint = !from ? `from step ${link.from}` : `to step ${link.to}`;
        throw new Error(`flow ${flow.id}: link ${link.id} points at unknown ${endpoint}`);
      }
      // An explicit link kind owns its own presentation. The endpoint fallback
      // preserves the legacy colour convention for link authors who omit it.
      const kind = link.kind ?? to.kind ?? from.kind ?? "request";
      lines.push(
        `  ${quote(link.from)} -> ${quote(link.to)} [${edgeAttrs(kind, link.label)}];`,
      );
    }
  } else {
    for (const step of flow.steps) {
      for (const target of step.calls_next ?? []) {
        const to = byId.get(target);
        if (!to) throw new Error(`flow ${flow.id}: step ${step.id} points at unknown step ${target}`);
        // Legacy edge colour follows the target's kind, as it did before #37.
        const kind = to.kind ?? step.kind ?? "request";
        lines.push(`  ${quote(step.id)} -> ${quote(target)} [${edgeAttrs(kind, step.edge_label)}];`);
      }
    }
  }
  lines.push("}");
  return lines.join("\n");
};

/**
 * Strip everything Graphviz emits that would either reference an external
 * resource or fight the page: the XML prolog, the SVG 1.1 DTD (a w3.org URL -
 * browsers do not fetch it, but a "zero external references" artifact should not
 * contain one), the generator comments, and the opaque white canvas polygon.
 *
 * The width/height Graphviz computed are deliberately KEPT. Stretching the SVG
 * to the container width rescales Graphviz's own text metrics, which is how a
 * layout-engine diagram reacquires exactly the overflow problems hand-authored
 * SVG has. The frame scrolls instead (#8 point 11: wide content scrolls in its
 * own frame, at every declared viewport).
 */
const clean = (svg: string, title: string): string => {
  let out = svg
    .replace(/<\?xml[\s\S]*?\?>\s*/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>\s*/g, "")
    .replace(/<!--[\s\S]*?-->\s*/g, "");
  // The first polygon inside <g class="graph"> is the canvas background.
  out = out.replace(/(<g id="graph0"[^>]*>\s*)<polygon[^>]*\/>/, "$1");
  out = out.replace(/<svg /, `<svg class="atlas-diagram" role="img" `);
  out = out.replace(/(<svg[^>]*>)/, `$1<title>${esc(title)}</title>`);
  return out.trim();
};

let graphvizPromise: Promise<Graphviz> | null = null;
const load = (): Promise<Graphviz> => (graphvizPromise ??= Graphviz.load());

export interface DiagramCache {
  get(key: string): string | undefined;
  set(key: string, svg: string): void;
}

/**
 * #7 point 5: diagrams get their own cache key, because loading the WASM module
 * is the only slow part of rendering and Graphviz output is deterministic. The
 * key is the dot source plus the Graphviz version, so a Graphviz upgrade that
 * changes layout invalidates every cached diagram rather than mixing engines
 * inside one artifact.
 */
export const diagramKey = (dot: string, graphvizVersion: string): string =>
  createHash("sha256").update(`${graphvizVersion}\n${dot}`).digest("hex").slice(0, 32);

export interface RenderedFlow {
  svg: string;
  dot: string;
  key: string;
  /** True when the flow is long enough that the layout will read as a strip (#7 point 9). */
  long: boolean;
}

export const renderFlow = async (flow: FlowNode, cache?: DiagramCache): Promise<RenderedFlow> => {
  const graphviz = await load();
  const dot = toDot(flow);
  const key = diagramKey(dot, graphviz.version());
  const cached = cache?.get(key);
  const svg = cached ?? clean(graphviz.layout(dot, "svg", "dot"), flow.title);
  if (!cached) cache?.set(key, svg);
  return { svg, dot, key, long: flow.steps.length > LONG_FLOW_STEPS };
};

export const graphvizVersion = async (): Promise<string> => (await load()).version();
