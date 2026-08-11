/**
 * `repo-atlas score --gated <gated.json> [-o scores.json]`
 *
 * The credentialed half of ranking. It calls a model under the versioned rubric
 * and writes the scores; the rank stage then applies the floor and the budgets
 * deterministically.
 *
 * This command is run deliberately, by a human with credentials, and its output
 * is committed as a pinned fixture. CI never runs it: it verifies the machinery
 * against the pinned scores instead, so a credential is not needed to check that
 * the engine behaves. What CI cannot check is whether the model still agrees
 * with the rubric - that is what refreshing this file measures, and the loader
 * refuses a set whose rubric has changed since, so the measurement cannot go
 * quietly stale.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { profile, rubricText } from "../rank/profile.js";
import { modelScorer, rubricDigest } from "../rank/model-scorer.js";
import type { ScoreFile } from "../rank/scorer.js";
import type { GatedCandidate } from "../gate/gate.js";

const USAGE = `usage: repo-atlas score --gated <gated.json> [-o <scores.json>]

Scores every node's interview_value with a model, under the profile's versioned
rubric. One call for the whole graph, because ranking is comparative, and no
tools, because the scorer orders what was established and may not add to it.

options:
  --gated <path>     gated candidates from the gate stage (required)
  --profile <name>   the profile whose rubric to score under (default: interview)
  -o, --out <path>   where to write the scores (default: out/scores.json)

Needs model credentials. CI does not run this: it checks the deterministic
machinery against a pinned score set instead. The written file records the
rubric's digest, so scores made under an edited rubric are refused rather than
silently reused.`;

const flag = (argv: string[], ...names: string[]): string | undefined => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};

export const scoreCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const gatedPath = flag(argv, "--gated");
  if (gatedPath === undefined) {
    console.error(USAGE);
    return 64;
  }

  const p = profile(flag(argv, "--profile") ?? "interview");
  const rubric = rubricText(p);
  const gated = (JSON.parse(readFileSync(gatedPath, "utf8")) as { gated: GatedCandidate[] }).gated;
  const nodes = gated.map((g) => g.node);

  console.log(`scoring ${nodes.length} nodes under ${p.name}/${p.rubric_version} (one call, no tools)`);
  const scored = await modelScorer()({ nodes, profile: p, rubric });

  const file: ScoreFile = {
    profile: p.name,
    rubric_version: p.rubric_version,
    rubric_sha256: rubricDigest(rubric),
    generated_at: new Date().toISOString(),
    scores: scored.map((s) => ({
      id: s.node.id,
      score: s.score,
      ...(s.because === undefined ? {} : { because: s.because }),
    })),
  };

  const output = resolve(flag(argv, "-o", "--out") ?? "out/scores.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(file, null, 2)}\n`, "utf8");

  const spread = new Map<number, number>();
  for (const s of file.scores) spread.set(s.score, (spread.get(s.score) ?? 0) + 1);
  console.log(`wrote ${file.scores.length} scores -> ${output}`);
  console.log(`  rubric ${p.rubric_version} (${file.rubric_sha256})`);
  console.log(
    `  spread ${[...spread.entries()].sort((a, b) => b[0] - a[0]).map(([v, n]) => `${v}:${n}`).join(" ")}`,
  );
  return 0;
};
