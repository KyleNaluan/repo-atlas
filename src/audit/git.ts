/**
 * Reading the subject tree at the pinned SHA, locally.
 *
 * #8 supersedes #7's "walk every href" for file evidence, and the reason is
 * measured rather than aesthetic: GitHub returns 200 for
 * `blob/<sha>/pom.xml#L9000-L9999` on a 60-line file, because the fragment never
 * reaches the server. An HTTP walk validates the path and is structurally blind
 * to the line range - and the line range is the part that pins the claim.
 * `AnswerKeyGrader.java:23-27` is a citation; `AnswerKeyGrader.java` is a
 * gesture. `git cat-file` validates both, needs no network, and measured 0.3s
 * for all 47 links in the reference artifact.
 */
import { execFileSync } from "node:child_process";

export class GitError extends Error {}

// git's plumbing error text is gettext-translated, so any decision made by
// reading it is a decision that changes with the machine's locale. Pin the
// locale on every invocation (LC_ALL=C, and clear LANGUAGE so it cannot win
// over LC_ALL) so the only signal we ever act on is git's exit code, which is
// locale-independent. Set it in the shared helper, not per call site.
const GIT_ENV = { ...process.env, LC_ALL: "C", LANGUAGE: "" };

const git = (cwd: string, args: string[]): string => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: GIT_ENV,
    });
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr ?? "";
    throw new GitError(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || String(cause)}`);
  }
};

export const isRepo = (path: string): boolean => {
  try {
    return git(path, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
};

export const headSha = (path: string): string => git(path, ["rev-parse", "HEAD"]).trim();

export const isClean = (path: string): boolean =>
  git(path, ["status", "--porcelain"]).trim().length === 0;

export const isShallow = (path: string): boolean =>
  git(path, ["rev-parse", "--is-shallow-repository"]).trim() === "true";

/**
 * Whether `path` exists in the tree at `sha`, decided by git's exit code alone.
 *
 * `git cat-file -e` exits zero when the object exists and non-zero when it does
 * not, printing nothing either way - so the answer never depends on parsing a
 * (translated) error message. A non-numeric status means git could not run at
 * all (binary missing, repository unreadable); that is a precondition failure,
 * not an absent path, so it throws rather than silently reading as "missing".
 */
const pathExistsAt = (repo: string, sha: string, path: string): boolean => {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}:${path}`], {
      cwd: repo,
      stdio: "ignore",
      env: GIT_ENV,
    });
    return true;
  } catch (cause) {
    const status = (cause as { status?: number | null }).status;
    if (typeof status === "number") return false;
    throw new GitError(`git cat-file -e ${sha}:${path} could not run in ${repo}: ${String(cause)}`);
  }
};

/**
 * A file's contents at a commit, or null if the path does not exist there.
 *
 * The distinction is load-bearing and must not turn on locale: a missing path
 * is a finding about the artifact (L1 records a false citation), while anything
 * else is a finding about the audit's own preconditions. So the commit is
 * verified first (a bad object throws GitError, a precondition finding), and
 * whether the path exists is then read from `git cat-file -e`'s exit code, never
 * from its message text. Only once existence is established is the blob read.
 */
export const blobAt = (repo: string, sha: string, path: string): string | null => {
  git(repo, ["rev-parse", "--verify", `${sha}^{commit}`]);
  if (!pathExistsAt(repo, sha, path)) return null;
  return git(repo, ["cat-file", "-p", `${sha}:${path}`]);
};

/** Line count of a blob, counting a trailing newline as ending the last line. */
export const lineCount = (contents: string): number => {
  if (contents.length === 0) return 0;
  const lines = contents.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
};
