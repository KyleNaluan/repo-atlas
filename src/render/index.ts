/**
 * Public render surface (`repo-atlas/render`).
 *
 * `src/index.ts` gives a downstream consumer the loader and validator for
 * `atlas.json` and stops there (#3: the contract is the JSON, not the HTML).
 * A consumer that wants to render a `FlowNode` itself - the interview-prep
 * tool's own pages, not this repo's own artifact - has needed a relative
 * import into `src/render/diagram.ts` to do it. This subpath is that surface
 * made public: a `FlowNode` in, an inline SVG out, and nothing else this
 * directory owns (the atlas-wide HTML pipeline, its cache wiring, its theme
 * and chrome templates) leaks through it.
 *
 * No behavior lives here. This file only re-exports what `diagram.ts`
 * already renders for the pipeline's own use.
 */
export { renderFlow, toDot } from "./diagram.js";
export type { RenderedFlow, DiagramCache } from "./diagram.js";
