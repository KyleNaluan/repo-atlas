/**
 * `repo-atlas rank --gated <gated.json> --scores <scores.json> [-o ranked.json]`
 *
 * Applies the profile's overrides, floor and budgets to scored nodes and writes
 * what survives together with the record of what did not.
 *
 * `--scores` is required in this build. Scoring is judgement and #2 puts it
 * behind a model, run by the separate `repo-atlas score` command whose output is
 * pinned as a committed fixture; this stage stays deterministic and credential-
 * free, verifying the machinery against those scores. Supply `--scores` and the
 * whole of this side of the seam runs end to end.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { profile, rubricText } from "../rank/profile.js";
import { rank } from "../rank/rank.js";
import { scoresFromFile, type ScoreFile } from "../rank/scorer.js";
import { EMPTY_OVERRIDES, validateOverrides, type Overrides } from "../rank/overrides.js";
import type { GatedCandidate } from "../gate/gate.js";
import type { AtlasNode } from "../schema/types.js";

const USAGE = `usage: repo-atlas rank --gated <gated.json> --scores <scores.json> [-o <ranked.json>]

Applies the profile's overrides, hard value floor and per-section budgets, and
records every deletion with its id, score and reason.

options:
  --gated <path>      gated candidates from the gate stage (required)
  --scores <path>     interview_value per node, under the profile's rubric (required)
  --profile <name>    the profile to rank under (default: interview)
  --overrides <path>  per-project pin/boost/suppress data
  -o, --out <path>    where to write the result (default: out/ranked.json)

This stage is the only place deletion happens. The renderer renders everything it
is handed, or it becomes a second authority over what survives.

Scoring itself is judgement and lives in \`repo-atlas score\`, which calls a model
under the versioned rubric and writes the scores. This stage stays deterministic
and needs no credential: pass its pinned output as --scores. A score set whose
rubric has since been edited is refused rather than silently reused.`;

const flag = (argv: string[], ...names: string[]): string | undefined => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};

export const rankCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const gatedPath = flag(argv, "--gated");
  const scoresPath = flag(argv, "--scores");
  if (gatedPath === undefined || scoresPath === undefined) {
    console.error(USAGE);
    return 64;
  }

  const p = profile(flag(argv, "--profile") ?? "interview");
  const gatedFile = JSON.parse(readFileSync(gatedPath, "utf8")) as { gated: GatedCandidate[] };
  const scoreFile = JSON.parse(readFileSync(scoresPath, "utf8")) as ScoreFile;
  const overridesPath = flag(argv, "--overrides");
  const overrides: Overrides =
    overridesPath === undefined
      ? EMPTY_OVERRIDES
      : validateOverrides(JSON.parse(readFileSync(overridesPath, "utf8")) as Overrides);

  // The loader itself refuses a score set whose rubric has since been edited: a
  // pinned set is a measurement of the rubric it was made under, and reusing it
  // after an edit would rank under scores nobody ever made against this text.
  const nodes: AtlasNode[] = gatedFile.gated.map((g) => g.node);
  const scored = scoresFromFile(scoreFile, p, rubricText(p))(nodes);
  const result = rank(scored, p, overrides);

  const output = resolve(flag(argv, "-o", "--out") ?? "out/ranked.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const byKind = (kind: string) => result.deletions.filter((d) => d.kind === kind).length;
  console.log(`ranked ${nodes.length} nodes under ${p.name}/${p.rubric_version} -> ${output}`);
  console.log(`  kept       ${result.nodes.length}`);
  console.log(
    `  quarantined ${nodes.filter((n) => n.confidence === "absent").length} (absent confidence; recorded separately as evidence cuts by assemble)`,
  );
  console.log(`  cut: floor ${byKind("floor")} (below interview_value ${p.budgets.interview_value_floor}, or suppressed)`);
  console.log(`  cut: budget ${byKind("budget")} (scored above the floor and still cut to fit a section)`);
  for (const d of result.deletions) console.log(`    ${d.id} (${d.score}) - ${d.reason}`);
  return 0;
};
