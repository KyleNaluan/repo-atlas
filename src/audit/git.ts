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
 * Verify the pinned commit is present and readable, once per (repo, sha).
 *
 * The pinned commit is the same for every citation in a run, so verifying it is
 * loop-invariant: a graph with 66 citations should spawn one rev-parse, not 66.
 * The check is remembered the first time it holds rather than re-run per blob.
 * It stays load-bearing - it is what lets a non-zero `cat-file` exit in `blobAt`
 * be read as "path absent" rather than "commit absent" - so it still runs before
 * any blob is read (#8: a bad object is a precondition finding, never a false
 * citation). A bad object throws GitError before the set is updated.
 */
const verifiedCommits = new Set<string>();

const verifyCommit = (repo: string, sha: string): void => {
  const key = `${repo}\0${sha}`;
  if (verifiedCommits.has(key)) return;
  git(repo, ["rev-parse", "--verify", `${sha}^{commit}`]);
  verifiedCommits.add(key);
};

/**
 * A file's contents at a commit, or null if the path does not exist there.
 *
 * The distinction is load-bearing and must not turn on locale: a missing path
 * is a finding about the artifact (L1 records a false citation), while anything
 * else is a finding about the audit's own preconditions. So the commit is
 * verified first (a bad object throws GitError, a precondition finding), and the
 * read itself then answers whether the path exists - `git cat-file -p` exits
 * non-zero with a numeric status when the path is absent from the tree, which is
 * read as "missing" (null); a non-numeric status means git could not run at all
 * (binary missing, repository unreadable) and throws. No separate existence
 * probe, and never a decision made by parsing a (translated) message.
 */
export const blobAt = (repo: string, sha: string, path: string): string | null => {
  verifyCommit(repo, sha);
  try {
    return execFileSync("git", ["cat-file", "-p", `${sha}:${path}`], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: GIT_ENV,
    });
  } catch (cause) {
    const status = (cause as { status?: number | null }).status;
    if (typeof status === "number") return null;
    throw new GitError(`git cat-file -p ${sha}:${path} could not run in ${repo}: ${String(cause)}`);
  }
};

/** Line count of a blob, counting a trailing newline as ending the last line. */
export const lineCount = (contents: string): number => {
  if (contents.length === 0) return 0;
  const lines = contents.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
};

/**
 * The 1-based, inclusive line span `start..end` of a blob (end defaults to start
 * for a single-line citation). The line range is the part of a file citation
 * that pins the claim, so a model judging that citation must be shown that span
 * and not the file's head - a claim about `Foo.java:250-260` weighed against the
 * first 4000 characters of a 500-line file grades the wrong region.
 */
export const sliceLines = (contents: string, start: number, end?: number): string =>
  contents.split("\n").slice(start - 1, end ?? start).join("\n");
