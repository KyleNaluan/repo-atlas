/**
 * The harvest cache: one file per issue, keyed so a comment edit invalidates it.
 *
 * #2 puts a SHA-keyed content-addressed cache under every stage; this is the
 * issue half of it, and its key is #4's: `(repo, issue_number,
 * issue.updated_at, comments_count, max(comment.updated_at))`. The last two
 * matter because `issue.updated_at` does not move when a comment is edited, so a
 * cache keyed on it alone would serve a resolution that no longer says what it
 * says - and this engine's product is that resolution.
 *
 * The audit reads from here too (#8's L3), which is why entries keep individual
 * comment ids rather than a concatenated blob.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheKey, cacheKeyString } from "./issues.js";
import type { HarvestedComment, HarvestedIssue } from "./types.js";

export const DEFAULT_CACHE_ROOT = ".atlas-cache";

const digest = (key: string): string =>
  createHash("sha256").update(key).digest("hex").slice(0, 32);

/**
 * How fresh a cached issue is, for collapsing duplicates.
 *
 * The cache key is comment-sensitive by design (#4), so a comment edit writes a
 * new entry; the freshest is the one whose issue or newest comment moved last.
 */
const freshness = (issue: HarvestedIssue): string =>
  [issue.updated_at, ...issue.comments.map((c) => c.updated_at)].sort().at(-1) ?? "";

/**
 * The audit's cache-first lookup (#8's L3) must never see two versions of one
 * issue number, or it could resolve against a superseded resolution comment -
 * defeating the exact reason the key was made comment-sensitive. Collapse to the
 * freshest entry per number.
 */
const freshestByNumber = (issues: HarvestedIssue[]): HarvestedIssue[] => {
  const best = new Map<number, HarvestedIssue>();
  for (const issue of issues) {
    const prior = best.get(issue.number);
    if (prior === undefined || freshness(issue) >= freshness(prior)) best.set(issue.number, issue);
  }
  return [...best.values()].sort((a, b) => a.number - b.number);
};

export interface IssueCache {
  get(repo: string, issue: HarvestedIssue): HarvestedIssue | undefined;
  put(repo: string, issue: HarvestedIssue): void;
  /** Every cached issue for a repo, for the audit's cache-first lookups. */
  all(repo: string): HarvestedIssue[];
}

export const fileIssueCache = (root = DEFAULT_CACHE_ROOT): IssueCache => {
  const dir = join(root, "issues");
  // Files for one issue number share this prefix; the trailing dash keeps
  // number 2 from matching number 20.
  const numberPrefix = (repo: string, number: number): string =>
    `${repo.replace("/", "__")}-${number}-`;
  const path = (repo: string, issue: HarvestedIssue): string =>
    join(dir, `${numberPrefix(repo, issue.number)}${digest(cacheKeyString(cacheKey(repo, issue)))}.json`);

  return {
    get(repo, issue) {
      try {
        return JSON.parse(readFileSync(path(repo, issue), "utf8")) as HarvestedIssue;
      } catch {
        return undefined;
      }
    },
    put(repo, issue) {
      mkdirSync(dir, { recursive: true });
      // Drop any superseded entry for this issue number before writing, so the
      // cache never accumulates stale versions of the same issue.
      const prefix = numberPrefix(repo, issue.number);
      for (const f of readdirSync(dir)) {
        if (f.startsWith(prefix) && f.endsWith(".json")) rmSync(join(dir, f));
      }
      writeFileSync(path(repo, issue), `${JSON.stringify(issue, null, 2)}\n`, "utf8");
    },
    all(repo) {
      const prefix = `${repo.replace("/", "__")}-`;
      try {
        return freshestByNumber(
          readdirSync(dir)
            .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
            .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as HarvestedIssue),
        );
      } catch {
        return [];
      }
    },
  };
};

export const memoryIssueCache = (): IssueCache => {
  const map = new Map<string, HarvestedIssue>();
  return {
    get: (repo, issue) => map.get(cacheKeyString(cacheKey(repo, issue))),
    put: (repo, issue) => {
      // The key is comment-sensitive, so drop any prior version of this issue
      // number before writing rather than leaving a stale sibling behind.
      const prefix = `${repo}|${issue.number}|`;
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
      map.set(cacheKeyString(cacheKey(repo, issue)), issue);
    },
    all: () => freshestByNumber([...map.values()]),
  };
};

/**
 * Resolve one specific comment from the cache.
 *
 * This is the shape #8's L3 needs: an audit that cannot tell comment
 * 5181222288 from comment 5243059657 on the same issue cannot verify that the
 * decision trail cites the resolution rather than a later note.
 */
export const resolveComment = (
  issues: HarvestedIssue[],
  number: number,
  commentId: number,
): HarvestedComment | undefined =>
  issues.find((i) => i.number === number)?.comments.find((c) => c.id === commentId);

export const resolveIssue = (
  issues: HarvestedIssue[],
  number: number,
): HarvestedIssue | undefined => issues.find((i) => i.number === number);
