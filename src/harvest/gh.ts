/**
 * Raw GitHub API access, and nothing else.
 *
 * #4's resolution is unusually specific about the mechanic, because the finding
 * behind it was expensive: a convenience CLI's issue view truncates each comment
 * at ~800 chars while its `--full` flag expands only the issue BODY. Every one of
 * swe-prep's nine 3.0-5.7 KB resolution comments was cut to about 15% of its
 * content by the default view, hiding ~39 KB of the single richest input the
 * engine has. The wrapper's own "N chars total" accounting was off by 40 bytes
 * too, so a wrapper's self-report is never the fidelity check.
 *
 * So: `gh api` only, REST by default with `--paginate`, and `body` rather than
 * `bodyText` on the GraphQL side. `bodyText` is a markdown-stripped projection
 * that reads shorter BY DESIGN - a second trap, and it must never be used even
 * as a length cross-check.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export class GhError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    /**
     * The HTTP status, when gh reported one. Present so a caller can tell "this
     * does not exist" from "I could not ask" - the difference between a false
     * citation and a failed precondition, which is a distinction the audit is
     * not allowed to guess at.
     */
    readonly status?: number,
  ) {
    super(message);
    this.name = "GhError";
  }
}

/**
 * gh prints `gh: Not Found (HTTP 404)` on stderr; that is the only status it
 * gives. Exported because it is a parse of another tool's output, which is the
 * kind of thing that stops working quietly.
 */
export const statusOf = (stderr: string): number | undefined => {
  const m = /\(HTTP (\d{3})\)/.exec(stderr);
  return m ? Number(m[1]) : undefined;
};

/** 64 MB: a single issue thread cannot approach this, and a silent truncation could. */
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GhOptions {
  /** Follow Link headers. REST caps at per_page=100 and signals more silently. */
  paginate?: boolean;
}

/**
 * One `gh api` call, returning parsed JSON.
 *
 * With `paginate`, `gh` concatenates pages as separate JSON documents rather
 * than one array, so the caller gets the concatenation re-joined here. Getting
 * that wrong is how a harvest silently keeps only the last page.
 */
export const ghApi = async <T>(path: string, options: GhOptions = {}): Promise<T> => {
  const args = ["api", path, "--header", "Accept: application/vnd.github+json"];
  if (options.paginate) args.push("--paginate", "--slurp");
  try {
    const { stdout } = await run("gh", args, { maxBuffer: MAX_BUFFER, encoding: "utf8" });
    const parsed = JSON.parse(stdout) as unknown;
    // `--slurp` wraps each page in an outer array; flatten one level so callers
    // see the same shape they would without pagination.
    if (options.paginate && Array.isArray(parsed)) {
      return (parsed as unknown[]).flat() as T;
    }
    return parsed as T;
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr ?? "";
    throw new GhError(
      `gh api ${path} failed: ${stderr.trim() || (cause as Error).message}`,
      args,
      statusOf(stderr),
    );
  }
};

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  /** The count GitHub itself reports. Harvest completeness is verified against this. */
  comments: number;
  updated_at: string;
  created_at: string;
  user: { login: string } | null;
  pull_request?: unknown;
  labels: { name: string }[];
}

export interface GhComment {
  id: number;
  body: string;
  updated_at: string;
  created_at: string;
  user: { login: string } | null;
}

export const listIssues = (repo: string): Promise<GhIssue[]> =>
  ghApi<GhIssue[]>(`repos/${repo}/issues?state=all&per_page=100`, { paginate: true });

/** One issue by number. Used on a cache miss, so a citation is never left unchecked. */
export const getIssue = (repo: string, issue: number): Promise<GhIssue> =>
  ghApi<GhIssue>(`repos/${repo}/issues/${issue}`);

export const listComments = (repo: string, issue: number): Promise<GhComment[]> =>
  ghApi<GhComment[]>(`repos/${repo}/issues/${issue}/comments?per_page=100`, { paginate: true });

export const getRepo = (repo: string): Promise<{ default_branch: string; private: boolean }> =>
  ghApi(`repos/${repo}`);
