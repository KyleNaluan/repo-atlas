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
import type {
  DecisionStatus,
  Evidence,
  RejectedAlternative,
  Shape,
  Synopsis,
} from "../schema/types.js";
import type { Candidate, ExistenceClaim } from "../probes/types.js";
import type {
  HarvestedComment,
  HarvestedDecisionRecord,
  HarvestedIssue,
} from "../harvest/types.js";

export const WRITE_PROMPT_VERSION = "v1";

/** The prompt asset's text. Versioned, and changed only by commit (#9's rule for the rubric). */
export const writePromptText = (): string =>
  readFileSync(fileURLToPath(new URL(`../../prompts/write-${WRITE_PROMPT_VERSION}.md`, import.meta.url)), "utf8");

/** The prompt's identity, so a pinned output cannot outlive the wording it was made under. */
export const promptDigest = (prompt: string): string =>
  createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);

/**
 * One decision record, handed to the writer alone.
 *
 * Two sources, one shape from here on (#55). A resolution comment on an issue
 * and a decision record committed to the tree are the same class of artifact -
 * a person's own account of a question that was argued and closed - and the
 * whole stage treats them identically: same prompt asset, same admissibility
 * verdict, same `attested` ceiling, same gate afterwards. What differs is only
 * the citation the code stamps, which is why the discriminant lives here and
 * nowhere downstream.
 *
 * The file variant carries the run's SHA because its citation names a span at a
 * commit. Stamping it from the record rather than accepting it as an argument
 * keeps `toCandidate` unable to mint an unstamped file citation at all.
 */
export interface IssueRecordToRead {
  /** Optional so a caller written before the second source still type-checks. */
  kind?: "issue";
  issue: HarvestedIssue;
  comment: HarvestedComment;
}

export interface FileRecordToRead {
  kind: "file";
  record: HarvestedDecisionRecord;
  /** The run's pinned SHA, so the span this cites names a commit. */
  sha: string;
}

export type RecordToRead = IssueRecordToRead | FileRecordToRead;

const isFileRecord = (r: RecordToRead): r is FileRecordToRead => r.kind === "file";

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
  /** How many paths the tree at the pinned SHA held, for the shape's citation. */
  paths_total?: number;
  /** How many the writer was actually shown, when the listing had to be capped. */
  paths_shown?: number;
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

/** A record read from an issue comment. `source` is optional so a set pinned before #55 still loads. */
export interface WrittenIssueEntry {
  source?: "issue";
  issue: number;
  comment_id: number;
  written: WrittenDecision;
}

/**
 * A record read from the tree, or suppressed because another entry already
 * carries the decision it names (#55's D4).
 *
 * `record_id` is the whole reference: ids are derived from the span rather than
 * the prose, so the harvest resolves one without this file restating a path and
 * a line range that could drift from it.
 *
 * A deduped entry carries no `written`, because no model call was spent on it.
 * It is recorded rather than dropped for the same reason an inadmissible record
 * is: a suppressed record is a fact about the subject, and #6 forbids
 * communicating absence by silence.
 */
export interface WrittenRecordEntry {
  source: "record";
  record_id: string;
  /** The node id this record's decision was merged into, when it was. */
  deduped_into?: string;
  written?: WrittenDecision;
}

export type WrittenEntry = WrittenIssueEntry | WrittenRecordEntry;

export const isRecordEntry = (e: WrittenEntry): e is WrittenRecordEntry => e.source === "record";

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
  /**
   * Which README the product sentence was written from, recorded here because it
   * is what the synopsis cites. A citation assembled from a default rather than
   * from the file actually read would name the wrong evidence for a subject whose
   * README lives elsewhere.
   */
  readme_path?: string;
  decisions: WrittenEntry[];
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
 * The node id for either source, from the record rather than its prose.
 *
 * A file-sourced record already carries its id (`records.ts` derives it from the
 * span), so this is a lookup and not a second derivation - two definitions of
 * "which node is this" would let a dedup merge target a node that never existed.
 */
export const candidateId = (record: RecordToRead): string =>
  isFileRecord(record) ? record.record.id : decisionId(record.issue.number, record.comment.id);

/** The title a record falls back to when the writer named none. */
const fallbackTitle = (record: RecordToRead): string =>
  isFileRecord(record) ? (record.record.heading ?? record.record.path) : record.issue.title;

/**
 * The citation, stamped from the record and never taken from the model.
 *
 * A file record cites its own span at the pinned SHA, which audit L1 and L2
 * resolve against the tree and which the model pass reads directly. An issue
 * record cites the issue and comment id, which pass C resolves against the
 * harvest cache. That is an evidential difference between the two sources and
 * not a confidence one (#55, D3): both are testimony, and neither establishes
 * anything about the code.
 */
const evidenceFor = (record: RecordToRead): Evidence[] =>
  isFileRecord(record)
    ? [
        {
          kind: "file",
          path: record.record.path,
          line_start: record.record.line_start,
          line_end: record.record.line_end,
          sha: record.sha,
        },
      ]
    : [{ kind: "issue", number: record.issue.number, comment_id: record.comment.id }];

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
  const evidence = evidenceFor(record);
  const id = candidateId(record);

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
        title: w.title ?? fallbackTitle(record),
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
      title: w.title ?? fallbackTitle(record),
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
  const total = written.paths_total;
  const shown = written.paths_shown;
  return {
    synopsis: {
      statement: written.statement,
      evidence: [{ kind: "file", path: readmePath, sha: subjectSha }],
    },
    shape: {
      tree: written.tree,
      // The listing, cited as the command that produces it. The annotated tree is
      // derived from every path at this commit, not from a file - an earlier
      // version cited the path "." and audit check L1 rightly refused it, because
      // no such entry exists in the tree and a citation nobody can resolve is
      // worse than none. This one a reader can run.
      evidence: [
        {
          kind: "command",
          cmd: `git ls-tree -r --name-only ${subjectSha}`,
          output_excerpt:
            total === undefined
              ? "(the listing this tree was annotated from)"
              : `(${total} path${total === 1 ? "" : "s"} at this commit${
                  shown !== undefined && shown < total ? `; the tree was written from the first ${shown}` : ""
                })`,
        },
      ],
    },
  };
};

/**
 * Which source a pinned written set is reassembled against.
 *
 * Both halves come from the harvest, so a set can only ever be rebuilt against
 * the artifact it was written from. `records` is optional because a harvest
 * pinned before #55 carries none, and absent there means "this harvest predates
 * the source" rather than "the tree declared none".
 */
export interface WriteSources {
  issues: HarvestedIssue[];
  records?: HarvestedDecisionRecord[];
}

/**
 * The candidates a pinned written set yields, in a stable order so a run is
 * reproducible: issue-sourced records by issue and comment, then file-sourced
 * records by path and line.
 *
 * DEDUP IS A MERGE, NEVER A SECOND NODE (#55's D4). An in-repo record that names
 * the issue whose resolution comment already produced a decision does not mint a
 * decision of its own - it becomes an additional file citation on that node. One
 * decision, two citations, and the file citation is the machine-checkable one.
 * Emitting both and letting rank cut one was rejected: rank deletes on score, so
 * which of two identical nodes survived would be arbitrary, and the artifact
 * would meanwhile assert one decision twice.
 *
 * A merge target that is not in this set is dropped rather than guessed at. The
 * write command only ever deduplicates against an admissible issue-sourced
 * entry, so a missing target means the file and the harvest disagree, and
 * appending a citation to nothing is not an option.
 */
export const candidatesFrom = (
  file: WrittenFile,
  source: WriteSources,
  prompt: string,
  subjectSha: string,
): Candidate[] => {
  assertWriteFresh(file, prompt, subjectSha);
  const byNumber = new Map(source.issues.map((i) => [i.number, i]));
  const byRecordId = new Map((source.records ?? []).map((r) => [r.id, r]));

  const issueEntries = file.decisions.filter((d): d is WrittenIssueEntry => !isRecordEntry(d));
  const recordEntries = file.decisions.filter(isRecordEntry);

  const out: Candidate[] = [];
  for (const d of [...issueEntries].sort((a, b) => a.issue - b.issue || a.comment_id - b.comment_id)) {
    const issue = byNumber.get(d.issue);
    if (issue === undefined) continue;
    const comment = issue.comments.find((c) => c.id === d.comment_id);
    if (comment === undefined) continue;
    out.push(toCandidate({ kind: "issue", issue, comment }, d.written));
  }

  const resolved = recordEntries
    .flatMap((d) => {
      const record = byRecordId.get(d.record_id);
      return record === undefined ? [] : [{ entry: d, record }];
    })
    .sort((a, b) => a.record.path.localeCompare(b.record.path) || a.record.line_start - b.record.line_start);

  for (const { entry, record } of resolved) {
    if (entry.deduped_into !== undefined) {
      const target = out.find((c) => c.node.id === entry.deduped_into);
      if (target === undefined) continue;
      target.node = {
        ...target.node,
        evidence: [
          ...target.node.evidence,
          {
            kind: "file",
            path: record.path,
            line_start: record.line_start,
            line_end: record.line_end,
            sha: subjectSha,
            note: "the same decision, recorded in the tree",
          },
        ],
      };
      continue;
    }
    if (entry.written === undefined) continue;
    out.push(toCandidate({ kind: "file", record, sha: subjectSha }, entry.written));
  }

  return out;
};
