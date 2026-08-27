/**
 * What a harvest produces, and how it is keyed.
 *
 * The cache key is the load-bearing part. #8's L3 has to be able to tell comment
 * 5181222288 from comment 5243059657 on the same issue, because an issue body
 * and its resolution comment are different artifacts (#3) and a decision trail
 * citing a later note instead of the resolution is a different claim. So the
 * cache stores comments individually by id, and the issue's own key includes
 * enough to notice any of them changing.
 */

export interface HarvestedComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  author: string | null;
  /** Byte length of the body as fetched. The tripwire compares against this. */
  bytes: number;
}

export interface HarvestedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  created_at: string;
  updated_at: string;
  author: string | null;
  labels: string[];
  /** The count GitHub reported. Verified equal to comments.length at harvest time. */
  comment_count: number;
  comments: HarvestedComment[];
}

/**
 * #4's cache key: `(repo, issue_number, issue.updated_at, comments_count,
 * max(comment.updated_at))`.
 *
 * The last two components are what make an edit to a comment invalidate the
 * entry. `issue.updated_at` alone does not move when a comment is edited, so a
 * cache keyed on it would serve a stale resolution indefinitely - which for this
 * engine means serving a decision record that no longer says what it says.
 */
export interface IssueCacheKey {
  repo: string;
  number: number;
  issue_updated_at: string;
  comment_count: number;
  latest_comment_updated_at: string | null;
}

/**
 * A decision record committed to the tree (#55), captured at the pinned SHA.
 *
 * The same class of artifact as a resolution comment - a person's own account of
 * a question that was argued and closed - and admissible on the same terms:
 * testimony about the decision, never evidence about the code.
 *
 * Unlike an issue citation, this one is machine-checkable against the tree: the
 * span is what audit L1 and L2 resolve, and what the model pass reads. That is
 * an evidential difference, not a confidence one (#55, D3).
 */
export interface HarvestedDecisionRecord {
  /** Stable across runs, derived from the span rather than the prose. */
  id: string;
  /** Which of the subject's declarations admitted it. Never collapsed. */
  family: "adr_directory" | "named_file" | "memory_section" | "document_section";
  path: string;
  /** 1-based, inclusive - the span the citation names. */
  line_start: number;
  line_end: number;
  /** The heading that declares it, where a heading did. */
  heading: string | null;
  body: string;
  bytes: number;
  /** Issue numbers the record names as its own, for #55's D4 dedup. */
  cites_issues: number[];
}

export interface ScaleCounts {
  files: number;
  lines: number;
  commits: number;
  first_commit: string | null;
  last_commit: string | null;
  /** Calendar days between the first and last commit. */
  days: number | null;
}

/**
 * #6's four density signals, measured separately and never collapsed.
 *
 * A scalar score is deliberately absent: extraction decides what the artifact
 * promises, and a density number able to contradict it in either direction would
 * be a second authority.
 */
export interface DensitySignals {
  closed_issues_with_resolution_comment: { value: number; of: number };
  comment_to_body_ratio: { value: number; note: string };
  source_files_citing_issues: { value: number; of: number };
  adr_directory: { value: boolean; note: string };
}

export interface HarvestSource {
  source: string;
  what_existed: string;
  fetched: string;
  admissible_as: string;
}

/**
 * Whether the subject declares a public/private split, and whether the private
 * side was readable HERE. Both halves matter: #8's P1 has three applicability
 * states and the middle one - declared but not readable - must never be silent,
 * or a later run that does have the clone inherits a reputation it did not earn.
 *
 * The private side is never read regardless. This records only that it exists.
 */
export interface PrivateSplit {
  declared: boolean;
  repo?: string;
  readable_at_harvest: boolean;
  note?: string;
}

export interface Harvest {
  harvest_version: string;
  subject: {
    owner: string;
    repo: string;
    url: string;
    branch: string;
    sha: string;
    read_on: string;
    visibility: string;
  };
  issues: HarvestedIssue[];
  scale: ScaleCounts;
  density: DensitySignals;
  sources: HarvestSource[];
  private_split: PrivateSplit;
  /** Project-memory files: indexed, never quoted as evidence about the code (#4, #55). */
  memory_files: { path: string; bytes: number }[];
  /**
   * In-repo decision records at the pinned SHA (#55).
   *
   * Optional so a harvest artifact pinned before this source existed still
   * loads: absent means "this harvest predates the source", which is a
   * different statement from an empty array's "the tree declared none", and
   * collapsing the two would let a stale fixture read as a measurement.
   */
  decision_records?: HarvestedDecisionRecord[];
}

export const HARVEST_VERSION = "1.0.0";
