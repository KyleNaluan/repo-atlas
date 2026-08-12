/**
 * The write seam: where a decision record becomes a decision candidate.
 *
 * #2's stage list names `write` alongside rank as the two places judgement is
 * allowed, and this is the half that reads. Probes are pure deterministic
 * functions over the tree (#5, which explicitly forecloses model-assisted probes
 * in v1), so nothing mechanical can turn a resolution comment's prose into a
 * question, a decision, a why and the alternative that lost. That reading is
 * judgement, and it lives here, behind an interface, exactly as scoring does.
 *
 * Four properties are load-bearing, and each closes a way this stage could
 * quietly become a summariser:
 *
 * ONE RECORD PER CALL. Extraction is not comparative - a decision means what its
 * own record says it means - so the writer sees one resolution comment at a time
 * and cannot borrow a rationale from a neighbouring issue. This is the opposite
 * of the scorer's one-call-for-the-whole-graph, and for the opposite reason.
 *
 * THE CODE STAMPS THE EVIDENCE, NOT THE MODEL. A candidate's citation is the
 * issue and comment id it was read from, attached here from the input. The model
 * is never asked for a citation and so can never produce one that does not
 * resolve - a class of failure the audit would otherwise have to catch.
 *
 * IT EMITS CANDIDATES, NOT NODES. What comes out goes through the existence gate
 * like any probe's output (#5, #7 point 7): a stated decision is not evidence of
 * implementation, so the writer says where it would expect the decision to live
 * and the gate resolves that against the tree in both directions.
 *
 * INADMISSIBLE IS A REAL ANSWER. A comment that settles nothing produces a
 * candidate carrying `absent` confidence rather than no candidate at all. #3
 * cuts absent outright, and the record reports the count and the reason - so a
 * tracker full of "closing this" notes reads as what it is, rather than as a
 * subject with no decisions ever recorded.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DecisionStatus, RejectedAlternative, Shape, Synopsis } from "../schema/types.js";
import type { Candidate, ExistenceClaim } from "../probes/types.js";
import type { HarvestedComment, HarvestedIssue } from "../harvest/types.js";

export const WRITE_PROMPT_VERSION = "v1";

/** The prompt asset's text. Versioned, and changed only by commit (#9's rule for the rubric). */
export const writePromptText = (): string =>
  readFileSync(fileURLToPath(new URL(`../../prompts/write-${WRITE_PROMPT_VERSION}.md`, import.meta.url)), "utf8");

/** The prompt's identity, so a pinned output cannot outlive the wording it was made under. */
export const promptDigest = (prompt: string): string =>
  createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);

/** One decision record, handed to the writer alone. */
export interface RecordToRead {
  issue: HarvestedIssue;
  comment: HarvestedComment;
}

/**
 * What the writer returns for one record.
 *
 * There is no evidence field, deliberately: the citation is stamped from the
 * record this was read from, so it cannot be wrong.
 */
export interface WrittenDecision {
  /** False when the comment settles no decision. Everything else may then be absent. */
  admissible: boolean;
  /** Why it is inadmissible, when it is. Reported in the record as an absent cut. */
  because?: string;
  title?: string;
  question?: string;
  decision?: string;
  why?: string;
  rejected?: RejectedAlternative[];
  rejected_absent_from_record?: boolean;
  status?: DecisionStatus;
  soundbite?: string;
  /** Where a reader should expect to find this, for the gate to resolve. */
  implementation_claim?: {
    description: string;
    expect: "present" | "absent";
    paths?: string[];
    pattern?: { regex: string; include?: string };
  };
}

export interface WrittenProse {
  /** False when the README or the listing could not support either sentence. */
  admissible: boolean;
  because?: string;
  statement?: string;
  tree?: string;
}

export interface ProseRequest {
  readme: string;
  /** The tree at the pinned SHA, as paths. */
  paths: string[];
  /** The decisions that survived, as context for what the repository is for. */
  decisions: { title: string; decision: string }[];
}

export interface Writer {
  decision: (record: RecordToRead, prompt: string) => Promise<WrittenDecision>;
  prose: (request: ProseRequest, prompt: string) => Promise<WrittenProse>;
}

/**
 * A written set supplied from a file rather than produced here.
 *
 * The same arrangement the scorer uses (#9, and the captain's option C): the
 * model runs locally through an authenticated CLI, its output is committed, and
 * CI verifies the deterministic machinery against it without holding a
 * credential. The file records the prompt it was produced under by version AND
 * by digest, because a prompt can be reworded without its version moving and
 * reusing an output made against the old wording would be the "verified, not
 * asserted" failure one level up.
 */
export interface WrittenFile {
  prompt_version: string;
  prompt_sha256?: string;
  generated_at?: string;
  /** The model the SDK reported, so a refresh shows whether prompt or model moved. */
  model?: string;
  subject_sha: string;
  decisions: { issue: number; comment_id: number; written: WrittenDecision }[];
  prose: WrittenProse;
}

export class StaleWriteError extends Error {
  constructor(fileDigest: string, currentDigest: string) {
    super(
      `this written set was produced under prompt text ${fileDigest} but the write prompt now ` +
        `digests to ${currentDigest}. The prompt changed since it was pinned, so the output is a ` +
        `reading of instructions that no longer exist. Refresh it with \`repo-atlas write\` rather ` +
        `than assembling from prose nobody produced under this prompt.`,
    );
    this.name = "StaleWriteError";
  }
}

export class WritePromptMismatchError extends Error {
  constructor(fileVersion: string, current: string) {
    super(
      `this written set was produced under write prompt ${fileVersion} but this run writes under ` +
        `${current}. The prompt is versioned precisely so one run cannot silently mix two of them.`,
    );
    this.name = "WritePromptMismatchError";
  }
}

export class WrongSubjectError extends Error {
  constructor(fileSha: string, runSha: string) {
    super(
      `this written set was produced at ${fileSha} but the run is pinned at ${runSha}. Prose ` +
        `describing one tree must not be assembled into a document naming another.`,
    );
    this.name = "WrongSubjectError";
  }
}

/**
 * Refuse a pinned set whose prompt has since been edited, or whose subject moved.
 *
 * In the loader rather than in a caller that must remember, for the reason
 * `scoresFromFile` gives: a check a caller can forget is advisory.
 */
export const assertWriteFresh = (file: WrittenFile, prompt: string, subjectSha: string) => {
  if (file.prompt_version !== WRITE_PROMPT_VERSION) {
    throw new WritePromptMismatchError(file.prompt_version, WRITE_PROMPT_VERSION);
  }
  if (file.subject_sha !== subjectSha) throw new WrongSubjectError(file.subject_sha, subjectSha);
  if (file.prompt_sha256 === undefined) return;
  const current = promptDigest(prompt);
  if (file.prompt_sha256 !== current) throw new StaleWriteError(file.prompt_sha256, current);
};

/**
 * A stable id for a decision, from the record it was read from rather than its prose.
 *
 * The comment id is always part of it, never only when a second resolution
 * comment appears: `recordsIn` emits one record per resolution comment (#7 found
 * issue #2 carrying two, cited as distinct artifacts), so keying on the issue
 * alone would mint colliding node ids - and colliding `{id}-divergence` edge ids
 * in the gate - for two decisions the subject genuinely records apart. The id is
 * derived from the record, so it does not shift when a second comment arrives.
 */
export const decisionId = (issue: number, commentId: number): string => `d-issue-${issue}-c${commentId}`;

/**
 * The only status the writer may mint: `decided`, or `superseded` when the record
 * says a later decision replaced this one.
 *
 * The prompt no longer asks for a build status - it solicits only `decided` or
 * `superseded`, and moves whether a thing was built onto `implementation_claim`
 * for the gate to settle. This clamp is the backstop for a model that answers
 * outside that vocabulary anyway: a prompt instruction is not an enforcement (#7
 * point 7), and where a decision is built is a claim about the tree only the gate
 * may settle. So a model-returned `decided_and_built` or `decided_not_built` is
 * clamped back to `decided` here, leaving promotion in the one place that reads
 * the tree.
 *
 * The consequence, deliberately: where a record states something was not built but
 * names nothing searchable to express it (no absent-claim, or one the gate cannot
 * read), the claim is unresolvable and the status stays `decided`. Unverified means
 * unasserted - the same treatment an unresolvable present-claim already gets.
 */
const clampStatus = (status: DecisionStatus | undefined): DecisionStatus =>
  status === "superseded" ? "superseded" : "decided";

const claimOf = (w: WrittenDecision): ExistenceClaim[] => {
  const c = w.implementation_claim;
  if (c === undefined) return [];
  const checkable = (c.paths?.length ?? 0) > 0 || c.pattern !== undefined;
  // A claim with nothing to read cannot be resolved either way, and the gate
  // demotes such a candidate rather than passing it. Sending one anyway would be
  // asking the gate to confirm something nobody can check.
  if (!checkable) return [];
  return [
    {
      description: c.description,
      expect: c.expect,
      ...(c.paths === undefined ? {} : { paths: c.paths }),
      ...(c.pattern === undefined ? {} : { pattern: c.pattern }),
    },
  ];
};

/**
 * One written reading becomes one candidate.
 *
 * The evidence is stamped from the record, never taken from the model. Note the
 * `implemented_by` handling: it stays EMPTY here, because where a decision is
 * built is a claim about the tree and the gate is what resolves it. Filling it
 * from the writer's guess would be the artifact asserting an implementation on
 * the strength of a decision record - the single failure #7 point 7 exists to
 * prevent.
 */
export const toCandidate = (record: RecordToRead, w: WrittenDecision): Candidate => {
  const evidence = [
    { kind: "issue" as const, number: record.issue.number, comment_id: record.comment.id },
  ];
  const id = decisionId(record.issue.number, record.comment.id);

  if (!w.admissible) {
    // Cut, not hedged (#3). It is emitted rather than dropped so the record can
    // report that a decision-shaped record existed and did not survive - the
    // difference between a subject with no decision trail and one whose trail
    // could not be read.
    return {
      probe_id: "write",
      node: {
        type: "decision",
        id,
        title: w.title ?? record.issue.title,
        question: "",
        decision: "",
        why: "",
        rejected: [],
        status: "decided",
        implemented_by: [],
        soundbite: "",
        evidence,
        confidence: "absent",
        interview_value: 0,
      },
    };
  }

  const claims = claimOf(w);
  return {
    probe_id: "write",
    node: {
      type: "decision",
      id,
      title: w.title ?? record.issue.title,
      question: w.question ?? "",
      decision: w.decision ?? "",
      why: w.why ?? "",
      rejected: w.rejected ?? [],
      ...((w.rejected ?? []).length === 0
        ? { rejected_absent_from_record: w.rejected_absent_from_record ?? true }
        : {}),
      status: clampStatus(w.status),
      implemented_by: [],
      soundbite: w.soundbite ?? "",
      evidence,
      // A decision record is testimony: it establishes what was decided, never
      // that it was built. `attested` is what harvest declares issue evidence
      // admissible as, and the gate can only lower it from here.
      confidence: "attested",
      interview_value: 0,
    },
    ...(claims.length === 0 ? {} : { claims }),
  };
};

export const proseFrom = (
  written: WrittenProse,
  subjectSha: string,
  readmePath: string,
): { synopsis: Synopsis; shape: Shape } | undefined => {
  if (!written.admissible || !written.statement?.trim() || !written.tree?.trim()) return undefined;
  return {
    synopsis: {
      statement: written.statement,
      evidence: [{ kind: "file", path: readmePath, sha: subjectSha }],
    },
    shape: {
      tree: written.tree,
      evidence: [{ kind: "file", path: ".", sha: subjectSha }],
    },
  };
};

/** The candidates a pinned written set yields, in issue order so a run is reproducible. */
export const candidatesFrom = (
  file: WrittenFile,
  issues: HarvestedIssue[],
  prompt: string,
  subjectSha: string,
): Candidate[] => {
  assertWriteFresh(file, prompt, subjectSha);
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  return [...file.decisions]
    .sort((a, b) => a.issue - b.issue)
    .flatMap((d) => {
      const issue = byNumber.get(d.issue);
      if (issue === undefined) return [];
      const comment = issue.comments.find((c) => c.id === d.comment_id);
      if (comment === undefined) return [];
      return [toCandidate({ issue, comment }, d.written)];
    });
};
