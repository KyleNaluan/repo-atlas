/**
 * M1 and M2 - the model pass. Advisory, always.
 *
 * #8 confines the model to the two questions where computation genuinely runs
 * out: does a node's prose say more than its own evidence establishes, and does
 * an absence claim's citation actually witness the absence. Everything else the
 * audit asks is computed, because a model asked "does this page look verified"
 * says yes.
 *
 * THE VERDICTS CANNOT FAIL AN ARTIFACT, and this is load-bearing rather than
 * cautious. #8's reasons: a model gate makes emission non-reproducible, and a
 * model-class judge certifying its own upstream's output is a rubber stamp. So
 * these are warnings, enumerated in full and never summarised to a count.
 *
 * It follows that a model which cannot be reached must not fail the run either.
 * The deterministic checks treat an aborted check as a failure, because a
 * deterministic check that could not run means the audit could not see the
 * artifact. Here the opposite holds: making emission depend on model
 * availability is exactly the non-reproducibility #8 rejected. An unreachable
 * model is reported by name as not run, and the artifact ships on what the
 * assertions established.
 *
 * Each node is judged ALONE, with its own prose and its own resolved evidence
 * and nothing else. A model shown the whole graph would grade a claim against
 * the document's general plausibility rather than against the citation that is
 * supposed to support it.
 */
import { spec } from "../register.js";
import { notRun, passed, type CheckResult } from "../types.js";
import type { AtlasNode, Evidence } from "../../schema/types.js";

export interface JudgeRequest {
  /** The one node under judgement. */
  node: AtlasNode;
  /** Its own evidence, resolved to text the model can read. */
  evidence: { citation: string; text: string }[];
}

export interface Verdict {
  supported: boolean;
  /** One line. Enumerated verbatim in the audit statement. */
  note: string;
}

export type Judge = (request: JudgeRequest, question: string) => Promise<Verdict>;

/** Prose fields a node asserts, which are what M1 weighs against the evidence. */
export const proseOf = (node: AtlasNode): string[] => {
  switch (node.type) {
    case "decision":
      return [node.question, node.decision, node.why, node.soundbite];
    case "mechanism":
      return [node.what, node.why_interesting, ...node.gotchas];
    case "boundary":
      return [node.enforced_by, node.what_breaks_without_it];
    case "edge":
      return [node.statement, node.why_it_matters, node.how_to_say_it];
    case "fact":
      return [`${node.label}: ${node.value}`];
    case "flow":
      return node.caption === undefined ? [] : [node.caption];
  }
};

/**
 * An absence-shaped node: one whose claim is that something is NOT there.
 *
 * #8's M2 exists because "an absence claim requires an empty command output"
 * false-alarmed on real content: a closed enumeration, such as a sealed type's
 * permits clause, witnesses an absence perfectly well without any command
 * returning nothing. Which of those two a citation is, is exactly the judgement
 * a rule could not make.
 */
const ABSENCE = /\b(no|none|never|not|without|absent|nothing|only|cannot)\b/i;

export const isAbsenceShaped = (node: AtlasNode): boolean =>
  (node.type === "edge" && (node.kind === "unbuilt" || node.kind === "coverage_gap")) ||
  proseOf(node).some((p) => ABSENCE.test(p)) ||
  (node.type === "decision" && (node.rejected_absent_from_record ?? false));

export const citationOf = (e: Evidence): string => {
  switch (e.kind) {
    case "file":
      return `${e.path}${e.line_start === undefined ? "" : `:${e.line_start}${e.line_end === undefined ? "" : `-${e.line_end}`}`}`;
    case "issue":
      return `issue #${e.number}${e.comment_id === undefined ? "" : ` comment ${e.comment_id}`}`;
    case "command":
      return `$ ${e.cmd}`;
  }
};

export const PROSE_QUESTION =
  "Does every sentence of this node's prose say only what its own cited evidence establishes? " +
  "Answer supported:false only if a specific sentence claims more than the evidence shows. " +
  "Prose that is merely brief, or that summarises the evidence accurately, is supported.";

export const ABSENCE_QUESTION =
  "This node claims something is absent. Does its cited evidence actually witness that absence? " +
  "A negative search result witnesses absence. So does a closed enumeration - a sealed type's " +
  "permits clause, an exhaustive switch - because it proves the set is complete. " +
  "Answer supported:false only if nothing cited could establish the absence either way.";

export interface ModelPassOptions {
  judge?: Judge;
  /** Resolve a node's evidence to readable text. Absent entries are simply omitted. */
  resolve: (e: Evidence) => string | undefined;
}

const runJudgements = async (
  id: string,
  nodes: AtlasNode[],
  question: string,
  options: ModelPassOptions,
): Promise<CheckResult> => {
  if (options.judge === undefined) {
    // Not a failure. An unreachable model must never decide whether an artifact
    // ships, or emission stops being reproducible - which is the reason #8 made
    // this pass advisory in the first place.
    return notRun(spec(id), "no model was available, and the model pass never decides whether an artifact ships");
  }
  if (nodes.length === 0) {
    return passed(spec(id), 0);
  }

  // Evidence is resolved BEFORE the judge try, deliberately. Resolution reads
  // git (blobAt), which can throw a GitError - a claim about the audit's own
  // filesystem, never about the model. Caught by the try below it would be
  // mislabelled as the model becoming unreachable; left outside, a git failure
  // propagates as itself, exactly the misattribution discipline this pass keeps.
  const judgements = nodes.map((node) => ({
    node,
    evidence: node.evidence
      .map((e) => ({ citation: citationOf(e), text: options.resolve(e) }))
      .filter((e): e is { citation: string; text: string } => e.text !== undefined),
  }));

  const judge = options.judge;
  const findings: string[] = [];
  let judged = 0;
  try {
    for (const { node, evidence } of judgements) {
      const verdict = await judge({ node, evidence }, question);
      if (!verdict.supported) findings.push(`${node.id}: ${verdict.note}`);
      judged += 1;
    }
  } catch (cause) {
    // The boundary that makes this pass's advisory status structural rather than
    // stated. A model that dies mid-sweep is the same situation as a model that
    // was never available, and it must read the same way: not run, by name, with
    // the cause. Letting it throw would hand it to the run's own boundary, which
    // - correctly, for a deterministic pass - calls a throw a precondition
    // failure and quarantines the artifact. Model availability would then decide
    // emission through the back door.
    //
    // The verdicts collected before the throw are dropped rather than reported.
    // A partial sweep enumerated as though it were the whole set is the failure
    // #6 and #8 both legislate against: silence is never how absence is
    // communicated, and neither is a truncated list presented as complete.
    const message = cause instanceof Error ? cause.message : String(cause);
    return notRun(
      spec(id),
      `the model became unreachable after judging ${judged} of ${nodes.length} node${nodes.length === 1 ? "" : "s"} (${message}), ` +
        `and the model pass never decides whether an artifact ships`,
    );
  }

  return findings.length === 0
    ? passed(spec(id), nodes.length)
    : // A warning-class check reports its findings in full; the run still ships.
      { ...passed(spec(id), nodes.length), outcome: "failed" as const, findings };
};

export const proseSupport = (nodes: AtlasNode[], options: ModelPassOptions): Promise<CheckResult> =>
  runJudgements("M1", nodes, PROSE_QUESTION, options);

export const absenceWitness = (
  nodes: AtlasNode[],
  options: ModelPassOptions,
): Promise<CheckResult> =>
  runJudgements("M2", nodes.filter(isAbsenceShaped), ABSENCE_QUESTION, options);
