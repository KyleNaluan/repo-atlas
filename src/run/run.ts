/**
 * The orchestrator: every stage, in order, over one SHA-keyed work directory.
 *
 * #2 puts a top-level `run` over the stage-per-subcommand design and a
 * content-addressed cache keyed on the pinned SHA. This is that, and its whole
 * job is sequencing plus deciding what can be skipped. It computes nothing
 * itself, which is why it can be read as the pipeline's table of contents.
 *
 * The cache is the work directory: a stage whose output file already exists for
 * this SHA is not re-run. That is what makes the expensive halves - a harvest
 * over the network, a writer and a scorer that call a model - payable once and
 * re-runnable for free while the deterministic stages downstream are iterated
 * on. `--from` a stage onwards re-does that stage and everything after it,
 * because a stale downstream file is worse than a slow run.
 *
 * TWO STAGES NEED A CREDENTIAL, and both can be supplied instead. `write` reads
 * decision records and `score` orders the graph; either can be handed a pinned
 * file produced by an earlier credentialed run (#9's option-C arrangement, which
 * is also how CI exercises the whole pipeline without holding a credential). A
 * run given neither a credential nor a pinned file for a stage stops AT that
 * stage and says which one, rather than emitting an artifact missing a section
 * and letting the reader infer the subject was thin.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type StageName =
  | "harvest"
  | "write"
  | "probe"
  | "gate"
  | "score"
  | "rank"
  | "assemble"
  | "render"
  | "audit";

/** In order. The orchestrator runs exactly this list, and `--from` cuts into it. */
export const PIPELINE: StageName[] = [
  "harvest",
  "write",
  "probe",
  "gate",
  "score",
  "rank",
  "assemble",
  "render",
  "audit",
];

/** What each stage leaves behind, which is also what lets it be skipped. */
export const OUTPUT: Record<StageName, string> = {
  harvest: "harvest.json",
  write: "written.json",
  probe: "candidates.json",
  gate: "gated.json",
  score: "scores.json",
  rank: "ranked.json",
  assemble: "atlas.json",
  render: "atlas.html",
  audit: "atlas.html",
};

/** Stages that call a model, and can be satisfied by a pinned file instead. */
export const CREDENTIALED: StageName[] = ["write", "score"];

/**
 * Whether a string names a real stage.
 *
 * `--from` is a user string; an unrecognised value must be rejected by name, not
 * fed to `plan()`. There `PIPELINE.indexOf(from)` would return -1, forcing every
 * stage - silently re-harvesting over the network and re-paying for the model
 * over a typo.
 */
export const isStageName = (value: string): value is StageName =>
  (PIPELINE as string[]).includes(value);

export interface RunPlan {
  /** Stages that will actually execute, in order. */
  run: StageName[];
  /** Stages skipped because this SHA's output is already there. */
  skipped: StageName[];
}

/**
 * Whether a stage's work is already done for this SHA.
 *
 * Every stage is keyed on its output file EXCEPT `audit`, which shares
 * `atlas.html` with `render` (it rewrites render's reserved slot in place rather
 * than emitting a second document). So the file's mere existence is `render`'s
 * completion signal, not the audit's: a run that reaches audit and then fails or
 * is interrupted leaves atlas.html present but un-audited, and keying audit on
 * that file would skip it on the next run and copy an unaudited artifact out. The
 * audit's real completion signal is the result it mirrors into the document
 * itself (#8, 7.1) - `record.audit.status`, which starts `not_run`. Reading the
 * document rather than a stamp file means the signal cannot disagree with the
 * artifact it describes.
 */
export const stageDone = (dir: string, stage: StageName): boolean => {
  if (stage === "audit") return auditMirrored(dir);
  return existsSync(join(dir, OUTPUT[stage]));
};

/** True once the audit has mirrored a real result into `atlas.json` (#8, 7.1). */
const auditMirrored = (dir: string): boolean => {
  const atlasPath = join(dir, OUTPUT["assemble"]);
  if (!existsSync(atlasPath)) return false;
  try {
    const status = JSON.parse(readFileSync(atlasPath, "utf8"))?.record?.audit?.status;
    return typeof status === "string" && status !== "not_run";
  } catch {
    return false;
  }
};

/**
 * What to run and what is already done.
 *
 * `from` forces a stage and everything after it. Note that skipping stops being
 * possible once a stage has been forced: re-running `gate` and then skipping
 * `rank` because ranked.json exists would rank against a gate result that no
 * longer matches, which is exactly the cross-stage mismatch `assemble` refuses.
 */
export const plan = (dir: string, from?: StageName, only?: StageName[]): RunPlan => {
  const wanted = only ?? PIPELINE;
  const forcedAt = from === undefined ? PIPELINE.length : PIPELINE.indexOf(from);
  const run: StageName[] = [];
  const skipped: StageName[] = [];
  for (const [i, stage] of PIPELINE.entries()) {
    if (!wanted.includes(stage)) continue;
    const done = stageDone(dir, stage);
    // Once anything is being re-run, nothing after it may be skipped.
    if (i >= forcedAt || run.length > 0 || !done) run.push(stage);
    else skipped.push(stage);
  }
  return { run, skipped };
};

export const workDir = (root: string, sha: string): string => {
  const dir = join(root, sha);
  mkdirSync(dir, { recursive: true });
  return dir;
};

export class StageFailure extends Error {
  constructor(
    readonly stage: StageName,
    readonly code: number,
  ) {
    super(`stage ${stage} failed (exit ${code})`);
    this.name = "StageFailure";
  }
}

/**
 * A credentialed stage with neither a credential nor a pinned file.
 *
 * Reported as its own failure rather than skipped. An artifact assembled without
 * the write stage carries no decision trail, and #6 is explicit that an absent
 * decision section is a claim ABOUT A RECORD - "absent from the record" - which
 * would be a lie here: the record may be full, and this run simply never read it.
 */
export class MissingModelStage extends Error {
  constructor(readonly stage: StageName) {
    super(
      `stage ${stage} needs a model and none was available. Supply --${stage === "write" ? "written" : "scores"} ` +
        `<file> from an earlier credentialed run, or run \`repo-atlas ${stage}\` first. This run stops here rather ` +
        `than emitting an artifact whose missing section would read as a finding about the subject.`,
    );
    this.name = "MissingModelStage";
  }
}
