/**
 * `repo-atlas render <atlas.json> -o <out.html>`
 *
 * Validate (fail closed) -> render -> self-containment tripwire. The tripwire
 * runs before the file is written: an artifact that reaches for the network is
 * not a lesser artifact, it is a different product, and writing one and then
 * complaining about it puts the burden on whoever reads the log.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadAtlas } from "../schema/validate.js";
import { render } from "../render/render.js";
import { findExternalRefs, countOutboundAnchors } from "../artifact/self-contained.js";
import { contentHash } from "../artifact/audit-slot.js";
import { fileDiagramCache, memoryDiagramCache, DEFAULT_CACHE_ROOT } from "../render/cache.js";
import { disposeHighlighter } from "../render/highlight.js";

const USAGE = `usage: repo-atlas render <atlas.json> [-o <out.html>] [--no-cache]

Renders one self-contained HTML artifact from an atlas.json. The audit stage
has not run over the result, and the artifact says so.

options:
  -o, --out <path>   where to write the artifact (default: out/atlas.html)
      --no-cache     do not read or write ${DEFAULT_CACHE_ROOT}/diagrams`;

const flagValue = (argv: string[], ...names: string[]): string | undefined => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};

export const renderCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const input = argv.find((a) => !a.startsWith("-") && a !== flagValue(argv, "-o", "--out"));
  if (input === undefined) {
    console.error(USAGE);
    return 64;
  }
  const output = resolve(flagValue(argv, "-o", "--out") ?? "out/atlas.html");

  const atlas = loadAtlas(input);
  const cache = argv.includes("--no-cache") ? memoryDiagramCache() : fileDiagramCache();
  let artifact: string;
  try {
    artifact = await render(atlas, { cache });
  } finally {
    await disposeHighlighter();
  }

  const problems = findExternalRefs(artifact);
  if (problems.length > 0) {
    console.error(
      `render: ${problems.length} external resource reference${problems.length === 1 ? "" : "s"} - refusing to write a self-contained artifact that is not one`,
    );
    for (const p of problems) console.error(`  - ${p.what}: ${p.snippet}`);
    return 65;
  }

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, artifact, "utf8");

  const rendered = atlas.nodes.filter((n) => n.confidence !== "absent").length;
  console.log(`rendered ${rendered} of ${atlas.nodes.length} nodes -> ${output} (${(artifact.length / 1024).toFixed(1)} KB)`);
  console.log(`  self-containment  0 external refs, ${countOutboundAnchors(artifact)} outbound anchors (navigation, not requests)`);
  console.log(`  audit             ${atlas.record.audit.status}`);
  console.log(`  content hash      ${contentHash(artifact)}`);
  return 0;
};
