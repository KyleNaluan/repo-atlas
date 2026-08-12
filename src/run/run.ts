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
 * on. `--force` from a stage onwards re-does that stage and everything after it,
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
import { existsSync, mkdirSync } from "node:fs";
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

/** In order. The orchestrator runs exactly this list, and `--force` cuts into it. */
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

export interface RunPlan {
  /** Stages that will actually execute, in order. */
  run: StageName[];
  /** Stages skipped because this SHA's output is already there. */
  skipped: StageName[];
}

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
    const done = existsSync(join(dir, OUTPUT[stage]));
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
