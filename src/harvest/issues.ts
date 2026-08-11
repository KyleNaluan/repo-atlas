/**
 * Issue and comment harvest, with completeness verified rather than assumed.
 *
 * The verification is the point. #4 makes a count mismatch a HARD FAILURE, not a
 * warning, because the failure it guards against is silent by nature: a
 * truncating fetch path returns well-formed JSON that simply contains less than
 * it should, and every downstream stage would treat the result as the whole
 * record. The engine's product is a decision trail; a decision trail missing 39
 * KB of resolutions is not a smaller version of the same thing.
 */
import { listComments, listIssues, type GhComment, type GhIssue } from "./gh.js";
import type { HarvestedComment, HarvestedIssue, IssueCacheKey } from "./types.js";

export class IncompleteHarvestError extends Error {
  constructor(
    readonly repo: string,
    readonly issue: number,
    readonly expected: number,
    readonly got: number,
  ) {
    super(
      `${repo}#${issue}: GitHub reports ${expected} comment${expected === 1 ? "" : "s"} but the ` +
        `fetch returned ${got}. Harvest completeness is verified, not assumed: a truncating fetch ` +
        `path returns well-formed JSON containing less than it should, and every later stage would ` +
        `treat it as the whole record.`,
    );
    this.name = "IncompleteHarvestError";
  }
}

const toComment = (c: GhComment): HarvestedComment => ({
  id: c.id,
  body: c.body,
  created_at: c.created_at,
  updated_at: c.updated_at,
  author: c.user?.login ?? null,
  bytes: Buffer.byteLength(c.body, "utf8"),
});

/**
 * A pull request is not an issue.
 *
 * The REST issues endpoint returns both, and a PR body is a description of a
 * change rather than a record of a decision. Including them would inflate every
 * density signal with exactly the material #6's signals exist to distinguish
 * from a real decision record.
 */
export const isIssue = (i: GhIssue): boolean => i.pull_request === undefined;

/**
 * How comments are fetched. Injectable so the completeness gate can be watched
 * failing without the network - a gate nobody has seen reject anything is a gate
 * nobody knows works.
 */
export type CommentFetcher = (repo: string, issue: number) => Promise<GhComment[]>;

export const harvestIssue = async (
  repo: string,
  issue: GhIssue,
  fetchComments: CommentFetcher = listComments,
): Promise<HarvestedIssue> => {
  const comments = await fetchComments(repo, issue.number);
  if (comments.length !== issue.comments) {
    throw new IncompleteHarvestError(repo, issue.number, issue.comments, comments.length);
  }
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    author: issue.user?.login ?? null,
    labels: issue.labels.map((l) => l.name),
    comment_count: issue.comments,
    comments: comments.map(toComment),
  };
};

export const harvestIssues = async (
  repo: string,
  fetchComments: CommentFetcher = listComments,
): Promise<HarvestedIssue[]> => {
  const all = (await listIssues(repo)).filter(isIssue);
  const out: HarvestedIssue[] = [];
  for (const issue of all) out.push(await harvestIssue(repo, issue, fetchComments));
  return out.sort((a, b) => a.number - b.number);
};

/** #4's cache key, including what makes a comment edit invalidate the entry. */
export const cacheKey = (repo: string, issue: HarvestedIssue): IssueCacheKey => ({
  repo,
  number: issue.number,
  issue_updated_at: issue.updated_at,
  comment_count: issue.comment_count,
  latest_comment_updated_at:
    issue.comments.length === 0
      ? null
      : issue.comments.map((c) => c.updated_at).sort().at(-1)!,
});

export const cacheKeyString = (key: IssueCacheKey): string =>
  [
    key.repo,
    key.number,
    key.issue_updated_at,
    key.comment_count,
    key.latest_comment_updated_at ?? "-",
  ].join("|");

/** Look a specific comment back up, which is what #8's L3 needs of the cache. */
export const findComment = (
  issues: HarvestedIssue[],
  number: number,
  commentId: number,
): HarvestedComment | undefined =>
  issues.find((i) => i.number === number)?.comments.find((c) => c.id === commentId);

/**
 * A resolution-shaped comment: #6's primary density signal.
 *
 * The shape is a heading that states a resolution. This is deliberately a
 * pattern match on the record's own convention rather than a judgement about
 * content - the signal measures whether the repository KEEPS decision records,
 * and extraction decides separately whether any given one is usable.
 */
export const RESOLUTION_HEADING = /^\s*#{1,6}\s*Resolution\b/im;

export const hasResolutionComment = (issue: HarvestedIssue): boolean =>
  issue.comments.some((c) => RESOLUTION_HEADING.test(c.body));
