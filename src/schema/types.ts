/**
 * The `atlas.json` contract, as TypeScript types.
 *
 * Per #3 this file is the single source of truth: the published JSON Schema in
 * `schema/atlas.schema.json` is GENERATED from these types (`npm run schema:gen`)
 * so code and contract cannot drift, and CI fails if the committed schema is
 * stale. Consumers - the separate interview-prep tool included - pin the major.
 *
 * Versioning: `schema_version` is semver and additive-only within a major.
 * The v1 shape is #3's six node types, with #7's three additive amendments
 * (`interviewer_questions` object form, `FlowNode.orientation`, `Fact.label`)
 * and the run metadata #6, #8 and #9 require.
 */

/** The contract version this build reads and writes. */
export const SCHEMA_VERSION = "1.0.0";

/* ------------------------------------------------------------- evidence */

/**
 * The three-level confidence gate (#3).
 *
 * - `verified`: traces to a file at the pinned SHA, or to captured command output.
 * - `attested`: traces to a primary issue/comment record.
 * - `absent`:   no admissible evidence. Cut outright at render, never hedged.
 */
export type Confidence = "verified" | "attested" | "absent";

/** A file in the subject tree, pinned to a SHA, optionally to a line range. */
export interface FileEvidence {
  kind: "file";
  path: string;
  /** 1-based, inclusive. */
  line_start?: number;
  /** 1-based, inclusive. Omitted for a single-line citation. */
  line_end?: number;
  /** Must equal the run's pinned SHA - asserted in `links.ts` and again by audit L5. */
  sha: string;
  note?: string;
}

/**
 * An issue or one comment on it. `comment_id` is load-bearing: an issue body and
 * its resolution comment are different artifacts (#3), and the audit has to be
 * able to tell two comments on one issue apart (#8, L3).
 */
export interface IssueEvidence {
  kind: "issue";
  number: number;
  comment_id?: number;
  note?: string;
}

/** A command run against the pinned tree, with the output that was captured. */
export interface CommandEvidence {
  kind: "command";
  cmd: string;
  output_excerpt: string;
  note?: string;
}

export type Evidence = FileEvidence | IssueEvidence | CommandEvidence;

/**
 * A question this node answers, phrased as an interviewer would ask it.
 *
 * A bare string means "answered by this node's own short answer" (a Decision's
 * soundbite, an Edge's how_to_say_it, ...). The object form binds an explicit
 * answer, and is REQUIRED whenever a node answers a question other than its own
 * (#7 amendment (a)): a Decision's soundbite answers that decision's question,
 * not every question the decision touches. Without it the Q&A fold produces
 * fluent, confidently wrong rows.
 */
export type InterviewerQuestion = string | { question: string; answer: string };

export interface NodeBase {
  /** Stable within a run; used verbatim as the rendered element id. */
  id: string;
  title: string;
  evidence: Evidence[];
  confidence: Confidence;
  /** 0-5. The only pure-judgement field; scored by the rank stage under a versioned rubric (#9). */
  interview_value: number;
  /** Provenance of the probe that proposed this node, where one did (#5). */
  probe_id?: string;
  interviewer_questions?: InterviewerQuestion[];
}

/* ---------------------------------------------------------- node types */

export type DecisionStatus = "decided" | "decided_and_built" | "decided_not_built" | "superseded";

export interface RejectedAlternative {
  alternative: string;
  why_it_lost: string;
}

/**
 * A question that was argued and closed.
 *
 * `rejected[]` uses explicit-absence semantics (#3): either it is populated, or
 * `rejected_absent_from_record` is true. The renderer never invents an
 * alternative, and "decided without recording an alternative" must stay
 * distinguishable from "no decision record at all".
 */
export interface DecisionNode extends NodeBase {
  type: "decision";
  question: string;
  decision: string;
  why: string;
  rejected: RejectedAlternative[];
  rejected_absent_from_record?: boolean;
  status: DecisionStatus;
  /** Where the decision is actually built. Empty for `decided_not_built` (#8, E2). */
  implemented_by: Evidence[];
  divergence?: string;
  soundbite: string;
}

/** How a mechanism is held in place. The enum is the interesting part. */
export type Enforcement = "type-level" | "query-level" | "test-level" | "convention";

export interface CodeExcerpt {
  language: string;
  text: string;
  evidence: Evidence;
}

export interface MechanismNode extends NodeBase {
  type: "mechanism";
  what: string;
  why_interesting: string;
  enforcement: Enforcement;
  gotchas: string[];
  code_excerpt?: CodeExcerpt;
}

export interface BoundaryNode extends NodeBase {
  type: "boundary";
  a: string;
  b: string;
  enforced_by: string;
  what_breaks_without_it: string;
}

/**
 * `coverage_gap` carries #6's "trace without resolution" case: a source citing a
 * bare issue number with nothing in the record explaining it. It is reported as
 * referenced-but-unresolved, never synthesised into a rationale.
 */
export type EdgeKind = "unbuilt" | "tradeoff" | "risk" | "divergence" | "coverage_gap";

export interface EdgeNode extends NodeBase {
  type: "edge";
  kind: EdgeKind;
  statement: string;
  why_it_matters: string;
  how_to_say_it: string;
}

export interface FactNode extends NodeBase {
  type: "fact";
  /** Stat-tile caption, distinct from `title` (#7 amendment (c)). */
  label: string;
  value: string;
  source: "command" | "file" | "issue";
}

export interface FlowStep {
  id: string;
  node: string;
  detail?: string;
  calls_next?: string[];
  edge_label?: string;
  /** Drives edge colour, never position. */
  kind?: "request" | "response" | "aside";
  evidence?: Evidence;
}

export interface FlowNode extends NodeBase {
  type: "flow";
  caption?: string;
  /**
   * Reading direction handed to the layout engine (#7 amendment (b)). Not a
   * coordinate: the engine still does every placement.
   */
  orientation?: "LR" | "TB";
  steps: FlowStep[];
}

export type AtlasNode =
  | DecisionNode
  | MechanismNode
  | BoundaryNode
  | EdgeNode
  | FactNode
  | FlowNode;

export type NodeType = AtlasNode["type"];

/* ------------------------------------------------------- run metadata */

export interface Subject {
  owner: string;
  repo: string;
  url: string;
  branch: string;
  /** The full 40-char pinned SHA every claim in the artifact resolves against. */
  sha: string;
  read_on: string;
  visibility: string;
}

/**
 * The product sentence and the annotated tree are metadata carrying their own
 * evidence, not a seventh node type (#7): they need evidence and ranking
 * immunity, and widening the node contract buys nothing else.
 */
export interface Synopsis {
  statement: string;
  evidence: Evidence[];
}

export interface Shape {
  tree: string;
  evidence: Evidence[];
}

export interface SourceRecord {
  source: string;
  what_existed: string;
  fetched: string;
  admissible_as: string;
}

/**
 * The four density signals (#6), recorded separately and never collapsed into a
 * scalar: a scalar could contradict extraction in either direction.
 */
export interface DensitySignal {
  value: number | boolean;
  of?: number;
  note?: string;
}

export type SectionPresence = "present" | "partial" | "absent";

export interface ConfidenceLedger {
  verified: number;
  attested: number;
  absent_cut: number;
}

/**
 * A candidate cut for want of evidence. The claim text is deliberately NOT
 * carried here for rendering: The record reports count + type + why the evidence
 * failed, and withholds the claim (#7 ruling `absent-cut-disclosure`).
 */
export interface AbsentCut {
  id: string;
  candidate_type: string;
  reason: string;
  note?: string;
}

/** A node deleted by the rank stage: floor or section budget, always recorded (#9). */
export interface Deletion {
  id: string;
  score: number;
  reason: string;
}

/**
 * Whether the subject declares a public/private split, and whether harvest could
 * read the private side. This drives the three-state applicability of audit
 * check P1 (#8): a check that could not run must say so by name, never silently.
 */
export interface PrivateSourceRecord {
  declared: boolean;
  repo?: string;
  readable_at_harvest: boolean;
  note?: string;
}

export type AuditStatus = "not_run" | "passed" | "passed_with_warnings" | "failed";

export type AuditCheckClass = "gate" | "warning";

export type AuditCheckOutcome = "passed" | "failed" | "not_applicable" | "not_run";

/** One entry of the twenty-check register (#8, section 4). */
export interface AuditCheckResult {
  /** Register id: S1-S4, L1-L5, G1-G3, E1-E2, P1, V1-V3, M1-M2. */
  id: string;
  name: string;
  class: AuditCheckClass;
  outcome: AuditCheckOutcome;
  /** What the check measured, for the counts-not-adjectives wording. */
  count?: number;
  /** One line per finding. Warnings are enumerated in full, never summarised (#8). */
  findings?: string[];
  /** Why the check did not run, when outcome is `not_applicable` or `not_run`. */
  reason?: string;
}

export interface AuditRecord {
  status: AuditStatus;
  /** `precondition` when the clone/SHA/worktree preconditions failed (#8, section 3). */
  failure_kind?: "gate" | "precondition";
  /** sha256 of the artifact with the audit slot's content replaced by the fixed placeholder. */
  content_hash?: string;
  audited_at?: string;
  checks?: AuditCheckResult[];
  /** The declared viewport matrix the layout checks ran at (#8, point 11). */
  viewports?: number[];
  note?: string;
}

/**
 * A profile is a named bundle of (rubric + section budgets) (#9). v1 ships
 * `interview`; the seam is this reference plus the recorded budgets.
 */
export interface AtlasRecord {
  sources: SourceRecord[];
  density_signals: Record<string, DensitySignal>;
  section_presence: Record<string, SectionPresence>;
  confidence_ledger: ConfidenceLedger;
  absent_cuts: AbsentCut[];
  deletions: Deletion[];
  /** Applied by the rank stage, reported by the renderer. Includes `interview_value_floor`. */
  budgets: Record<string, number>;
  private_source?: PrivateSourceRecord;
  audit: AuditRecord;
}

export interface Atlas {
  schema_version: string;
  generated_at: string;
  profile: string;
  rubric_version: string;
  subject: Subject;
  synopsis: Synopsis;
  shape: Shape;
  nodes: AtlasNode[];
  record: AtlasRecord;
}

/* ------------------------------------------------------------ helpers */

export const isType =
  <T extends NodeType>(t: T) =>
  (n: AtlasNode): n is Extract<AtlasNode, { type: T }> =>
    n.type === t;

/**
 * The hard render gate (#3): `absent` is cut outright, never hedged.
 * Applied exactly once, at the top of rendering, so no section can hedge one
 * back in - no section ever sees an `absent` node.
 */
export const admissible = (n: AtlasNode): boolean => n.confidence !== "absent";
