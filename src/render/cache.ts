/**
 * The diagram cache (#7 point 5).
 *
 * Loading the Graphviz WASM module is the only slow part of rendering and its
 * output is deterministic, so a content-addressed file cache keyed on
 * (dot source, engine version) is both safe and worth having. This is the first
 * user of the SHA-keyed content-addressed cache #2 puts under every stage; the
 * stages that need more of it bring their own directories under the same root.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiagramCache } from "./diagram.js";

export const DEFAULT_CACHE_ROOT = ".atlas-cache";

export const fileDiagramCache = (root = DEFAULT_CACHE_ROOT): DiagramCache => {
  const dir = join(root, "diagrams");
  let ready = false;
  const ensure = () => {
    if (ready) return;
    mkdirSync(dir, { recursive: true });
    ready = true;
  };
  return {
    get(key) {
      try {
        return readFileSync(join(dir, `${key}.svg`), "utf8");
      } catch {
        return undefined;
      }
    },
    set(key, svg) {
      ensure();
      writeFileSync(join(dir, `${key}.svg`), svg, "utf8");
    },
  };
};

/** For tests and single-shot runs: correct, and forgets everything on exit. */
export const memoryDiagramCache = (): DiagramCache => {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k), set: (k, v) => void map.set(k, v) };
};
