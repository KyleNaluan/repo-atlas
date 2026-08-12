/**
 * `repo-atlas run --clone <path> [--repo owner/name] [-o <out.html>]`
 *
 * Every stage, in order, over one SHA-keyed work directory (#2). It shells
 * nothing out and imports no stage logic: it calls the same command functions
 * the subcommands do, so `run` cannot drift from what running the stages by hand
 * would produce. A stage that fails stops the run at that stage, by name.
 *
 * The work directory IS the cache. A stage whose output exists for this SHA is
 * skipped and said to be skipped; `--from <stage>` re-runs that stage and
 * everything after it. Nothing after a re-run stage may be skipped, because a
 * downstream file produced against a previous version of an upstream one is the
 * cross-stage mismatch `assemble` already refuses.
 */
import { copyFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { harvestCommand } from "./harvest.js";
import { writeCommand } from "./write.js";
import { probeCommand, gateCommand } from "./probe.js";
import { scoreCommand } from "./score.js";
import { rankCommand } from "./rank.js";
import { assembleCommand } from "./assemble.js";
import { renderCommand } from "./render.js";
import { auditCommand } from "./audit.js";
import {
  CREDENTIALED,
  isStageName,
  MissingModelStage,
  OUTPUT,
  PIPELINE,
  plan,
  StageFailure,
  workDir,
  type StageName,
} from "../run/run.js";
import { headSha, isRepo, subjectRemote } from "../harvest/tree.js";

const USAGE = `usage: repo-atlas run --clone <path> [--repo <owner/name>] [-o <atlas.html>]

Runs the whole pipeline over a subject: harvest, write, probe, gate, score, rank,
assemble, render, audit.

options:
  --clone <path>      a local checkout of the subject (required)
  --repo <owner/name> the GitHub repository (default: the clone's origin remote)
  --sha <sha>         the commit to pin (default: the clone's HEAD)
  --work <dir>        where stage outputs live (default: .atlas-work)
  --from <stage>      re-run this stage and everything after it
  --written <path>    a pinned written set, instead of calling a model
  --scores <path>     a pinned score set, instead of calling a model
  --overrides <path>  per-project rank overrides
  -o, --out <path>    where the audited artifact is written (default: <work>/atlas.html)
  --no-browser        skip the browser audit pass (its gates report as not run)
  --allow-failed      emit a failed artifact, with a banner, for local development

The work directory is keyed on the pinned SHA and acts as the cache: a stage whose
output is already there is skipped. That makes the expensive halves - a harvest
over the network, a writer and a scorer that call a model - payable once while the
deterministic stages downstream are iterated on.

Two stages need a model: \`write\` reads decision records, \`score\` orders the
graph. Either can be handed a pinned file from an earlier credentialed run, which
is how CI exercises the whole pipeline without a credential. A run that can do
neither stops there and says which stage, rather than emitting an artifact whose
missing decision section would read as a finding about the subject.`;

const flag = (argv: string[], ...names: string[]): string | undefined => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};

/**
 * Whether this run has no way to reach a model for a credentialed stage.
 *
 * `ATLAS_NO_MODEL` is the explicit declaration CI and the tests set: no
 * credential exists and none should be sought. It is deliberately the only
 * signal read here, because it is the only false-positive-free one - the SDK
 * authenticates from a stored CLI session with NO environment variable set, so an
 * absent `ANTHROPIC_API_KEY` is not proof of a missing credential and reading it
 * as one would block the documented local run through the authenticated CLI and
 * tell it to supply a file it does not need.
 */
const noModelCredential = (): boolean => process.env["ATLAS_NO_MODEL"] !== undefined;

/** Each stage's argv, built from the work directory rather than passed through. */
const argvFor = (
  stage: StageName,
  dir: string,
  clone: string,
  repo: string,
  sha: string,
  argv: string[],
): string[] => {
  const at = (name: string) => join(dir, name);
  switch (stage) {
    case "harvest":
      return ["--clone", clone, "--repo", repo, "--sha", sha, "-o", at("harvest.json")];
    case "write":
      return ["--harvest", at("harvest.json"), "--clone", clone, "-o", at("written.json")];
    case "probe":
      return ["--harvest", at("harvest.json"), "--clone", clone, "-o", at("candidates.json")];
    case "gate":
      return [
        "--candidates", at("candidates.json"),
        "--harvest", at("harvest.json"),
        "--written", at("written.json"),
        "--clone", clone,
        "-o", at("gated.json"),
      ];
    case "score":
      return ["--gated", at("gated.json"), "-o", at("scores.json")];
    case "rank":
      return [
        "--gated", at("gated.json"),
        "--scores", at("scores.json"),
        "-o", at("ranked.json"),
        ...(flag(argv, "--overrides") === undefined ? [] : ["--overrides", flag(argv, "--overrides")!]),
      ];
    case "assemble":
      return [
        "--harvest", at("harvest.json"),
        "--gated", at("gated.json"),
        "--ranked", at("ranked.json"),
        "--prose", at("written.json"),
        "-o", at("atlas.json"),
      ];
    case "render":
      return [at("atlas.json"), "-o", at("atlas.html")];
    case "audit":
      return [
        at("atlas.html"),
        "--atlas", at("atlas.json"),
        "--clone", clone,
        "--repo", repo,
        ...(argv.includes("--no-browser") ? ["--no-browser"] : []),
        ...(argv.includes("--allow-failed") ? ["--allow-failed"] : []),
      ];
  }
};

const RUNNER: Record<StageName, (argv: string[]) => Promise<number>> = {
  harvest: harvestCommand,
  write: writeCommand,
  probe: probeCommand,
  gate: gateCommand,
  score: scoreCommand,
  rank: rankCommand,
  assemble: assembleCommand,
  render: renderCommand,
  audit: auditCommand,
};

export const runCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const fromRaw = flag(argv, "--from");
  if (fromRaw !== undefined && !isStageName(fromRaw)) {
    console.error(
      `run: unknown --from stage '${fromRaw}'. valid stages: ${PIPELINE.join(", ")}`,
    );
    return 64;
  }
  const clonePath = flag(argv, "--clone");
  if (clonePath === undefined) {
    console.error(USAGE);
    return 64;
  }
  const clone = resolve(clonePath);
  if (!isRepo(clone)) {
    console.error(`run: ${clone} is not a git repository`);
    return 66; // EX_NOINPUT
  }
  const repo = flag(argv, "--repo") ?? subjectRemote(clone);
  if (repo === null || repo === undefined) {
    console.error("run: no --repo given and the clone has no origin remote to read one from");
    return 64;
  }
  const sha = flag(argv, "--sha") ?? headSha(clone);
  const dir = workDir(resolve(flag(argv, "--work") ?? ".atlas-work"), sha);

  // A pinned file is copied in under the name the stage would have written, and
  // the stage is recorded as SUPPLIED so it is skipped whatever ran upstream. A
  // supplied set is not a cache entry that can go stale against a rebuilt
  // upstream - it is authoritative input carrying its own guards (subject_sha for
  // written, rubric digest for scores) - so it must never be overwritten by
  // re-running the model, which is what keying purely on file existence did.
  const supplied: StageName[] = [];
  for (const [option, stage] of [["--written", "write"], ["--scores", "score"]] as const) {
    const pinned = flag(argv, option);
    if (pinned !== undefined) {
      copyFileSync(resolve(pinned), join(dir, OUTPUT[stage]));
      supplied.push(stage);
    }
  }

  const from = fromRaw as StageName | undefined;
  const { run, skipped } = plan(dir, { from, supplied });

  console.log(`run ${repo} at ${sha}`);
  console.log(`  work ${dir}`);
  if (skipped.length > 0) console.log(`  skip ${skipped.join(", ")} (already built for this SHA)`);

  for (const stage of run) {
    // A credentialed stage ABOUT TO RUN with no usable model is its own failure,
    // reported before the stage overwrites anything. A supplied file never reaches
    // here - `plan` skips a supplied stage - so a credentialed stage in `run` has
    // no pinned file by construction; the old `!existsSync` guard was the very
    // bypass this finding names, and it also let a `--from`-forced re-run of a
    // cached credentialed stage overwrite it and crash. Proceeding without a model
    // would emit an artifact missing its decision trail, and #6 makes an absent
    // decision section a claim about the RECORD - untrue when the record is full
    // and this run simply never read it.
    if (CREDENTIALED.includes(stage) && noModelCredential()) {
      const problem = new MissingModelStage(stage);
      console.error(`run failed: ${problem.message}`);
      return 78; // EX_CONFIG
    }
    console.log(`  ---- ${stage}`);
    const code = await RUNNER[stage](argvFor(stage, dir, clone, repo, sha, argv));
    if (code !== 0) {
      const failure = new StageFailure(stage, code);
      console.error(`run failed: ${failure.message}`);
      return code;
    }
  }

  const out = flag(argv, "-o", "--out");
  if (out !== undefined && existsSync(join(dir, "atlas.html"))) {
    copyFileSync(join(dir, "atlas.html"), resolve(out));
    console.log(`  emit ${resolve(out)}`);
  }
  return 0;
};
