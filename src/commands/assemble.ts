/**
 * `repo-atlas assemble --harvest <h> --gated <g> --ranked <r> --prose <p> [-o atlas.json]`
 *
 * The join between the pipeline's stages and the output contract. It validates
 * what it wrote before returning: an atlas.json that does not satisfy its own
 * generated schema is not a document to fix downstream, it is this stage's
 * failure, and #3 makes the contract fail closed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assemble, AssembleError } from "../assemble/assemble.js";
import { AtlasValidationError, validateAtlas } from "../schema/validate.js";
import type { Harvest } from "../harvest/types.js";
import type { GatedCandidate } from "../gate/gate.js";
import type { RankResult } from "../rank/rank.js";
import type { Shape, Synopsis } from "../schema/types.js";

const USAGE = `usage: repo-atlas assemble --harvest <harvest.json> --gated <gated.json> --ranked <ranked.json> --prose <prose.json> [-o <atlas.json>]

Joins the harvest, the gate's verdicts and the rank stage's survivors into one
atlas.json, and validates it against the generated schema before writing.

options:
  --harvest <path>   the harvest this run was built from (required)
  --gated <path>     every candidate the gate saw, with its verdict (required)
  --ranked <path>    the rank stage's survivors and deletion record (required)
  --prose <path>     the write stage's synopsis and annotated tree (required)
  --generated-at <t> the timestamp recorded in the document (default: now, UTC)
  -o, --out <path>   where to write it (default: out/atlas.json)

This stage adds no claim. Every field it writes restates what an earlier stage
established: harvest's sources and measurements, the gate's verdicts, rank's
survivors and deletions. The provenance record is written for every subject and
not only thin ones - reporting it conditionally would leak the output tier #6
rejected.

The synopsis and the annotated tree are required input, not defaults. A blank
product sentence asserts nothing and admits nothing, and #6 forbids
communicating absence by silence.`;

const flag = (argv: string[], ...names: string[]): string | undefined => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};

const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export interface ProseFile {
  synopsis: Synopsis;
  shape: Shape;
}

export const assembleCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const harvestPath = flag(argv, "--harvest");
  const gatedPath = flag(argv, "--gated");
  const rankedPath = flag(argv, "--ranked");
  const prosePath = flag(argv, "--prose");
  if (!harvestPath || !gatedPath || !rankedPath || !prosePath) {
    console.error(USAGE);
    return 64;
  }

  const harvest = read<Harvest>(harvestPath);
  const gatedFile = read<{ subject_sha: string; gated: GatedCandidate[] }>(gatedPath);
  const ranked = read<RankResult>(rankedPath);
  const prose = read<ProseFile>(prosePath);

  if (gatedFile.subject_sha !== harvest.subject.sha) {
    // The same check the gate makes of the probe stage, for the same reason: a
    // document whose citations were verified against one tree and whose subject
    // names another resolves nothing an auditor could follow.
    console.error(
      `assemble: the gated candidates were produced at ${gatedFile.subject_sha} but the harvest ` +
        `is at ${harvest.subject.sha}`,
    );
    return 65;
  }

  let atlas;
  try {
    atlas = assemble({
      harvest,
      gated: gatedFile.gated,
      ranked,
      synopsis: prose.synopsis,
      shape: prose.shape,
      generatedAt: flag(argv, "--generated-at") ?? new Date().toISOString(),
    });
  } catch (e) {
    if (e instanceof AssembleError) {
      console.error(`assemble failed: ${e.message}`);
      return 65;
    }
    throw e;
  }

  try {
    validateAtlas(atlas, "the assembled atlas");
  } catch (e) {
    // Fail closed (#3). Writing an invalid document and reporting the problems
    // would put a file at the output path that the next stage is entitled to
    // trust, which is how a contract stops being one.
    if (e instanceof AtlasValidationError) {
      console.error(`assemble failed: ${e.message}`);
      for (const p of e.problems.slice(0, 20)) console.error(`  - ${p}`);
      return 65;
    }
    throw e;
  }

  const output = resolve(flag(argv, "-o", "--out") ?? "out/atlas.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(atlas, null, 2)}\n`, "utf8");

  const r = atlas.record;
  console.log(`assembled ${atlas.subject.owner}/${atlas.subject.repo} at ${atlas.subject.sha} -> ${output}`);
  console.log(`  ${atlas.nodes.length} nodes: ${r.confidence_ledger.verified} verified, ${r.confidence_ledger.attested} attested`);
  console.log(`  ${r.absent_cuts.length} cut for want of evidence, ${r.deletions.length} deleted by rank`);
  for (const [section, presence] of Object.entries(r.section_presence)) {
    console.log(`  ${presence.padEnd(8)} ${section}`);
  }
  return 0;
};
