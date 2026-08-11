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

/**
 * The on-disk record. The repo is stored in the file, not only in the path,
 * because the filename is an index and the content is the record: `all()`
 * verifies the two agree before trusting an entry, so a mislaid or hand-edited
 * file cannot smuggle another repo's issue into a cache-first lookup.
 */
interface CacheRecord {
  repo: string;
  issue: HarvestedIssue;
}

export const fileIssueCache = (root = DEFAULT_CACHE_ROOT): IssueCache => {
  // One directory per repo. A path separator cannot appear inside a GitHub
  // owner/name, so this is an unambiguous boundary where a dash is not: owner
  // names carry no underscore, so `owner__name` recovers the repo exactly and
  // `owner__swe-prep` can never be confused with `owner__swe-prep-v2`.
  const repoDir = (repo: string): string => join(root, "issues", repo.replace("/", "__"));
  // Files for one issue number share this prefix; the trailing dash keeps
  // number 2 from matching number 20.
  const numberPrefix = (number: number): string => `${number}-`;
  const path = (repo: string, issue: HarvestedIssue): string =>
    join(repoDir(repo), `${numberPrefix(issue.number)}${digest(cacheKeyString(cacheKey(repo, issue)))}.json`);
  const parse = (file: string): CacheRecord | undefined => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as CacheRecord;
    } catch {
      return undefined;
    }
  };

  return {
    get(repo, issue) {
      const record = parse(path(repo, issue));
      if (record?.repo !== repo || record.issue.number !== issue.number) return undefined;
      return record.issue;
    },
    put(repo, issue) {
      const dir = repoDir(repo);
      mkdirSync(dir, { recursive: true });
      // Drop any superseded entry for this issue number before writing, so the
      // cache never accumulates stale versions of the same issue.
      const prefix = numberPrefix(issue.number);
      for (const f of readdirSync(dir)) {
        if (f.startsWith(prefix) && f.endsWith(".json")) rmSync(join(dir, f));
      }
      const record: CacheRecord = { repo, issue };
      writeFileSync(path(repo, issue), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    },
    all(repo) {
      const dir = repoDir(repo);
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        return [];
      }
      const issues: HarvestedIssue[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const record = parse(join(dir, f));
        // The filename is an index; the content is the record. Trust an entry
        // only when the two agree - on the repo it was harvested for and on the
        // issue number the filename claims.
        if (record?.repo !== repo) continue;
        if (`${record.issue.number}-` !== f.slice(0, `${record.issue.number}-`.length)) continue;
        issues.push(record.issue);
      }
      return freshestByNumber(issues);
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
    all: (repo) => {
      // Keys begin `${repo}|`, and the `|` terminator keeps `o/r` from matching
      // a sibling `o/r2` - the same repo-boundary guarantee the file cache gets
      // from a directory, so `all()` never merges two repos by issue number.
      const prefix = `${repo}|`;
      const scoped = [...map.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
      return freshestByNumber(scoped);
    },
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
