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

const git = (cwd: string, args: string[]): string => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
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
 * A file's contents at a commit, or null if the path does not exist there.
 *
 * `git cat-file` distinguishes "no such path" from every other failure, and the
 * difference matters: a missing path is a finding about the artifact, and
 * anything else is a finding about the audit's own preconditions.
 */
export const blobAt = (repo: string, sha: string, path: string): string | null => {
  try {
    return git(repo, ["cat-file", "-p", `${sha}:${path}`]);
  } catch (e) {
    const message = (e as Error).message;
    if (/does not exist|not a valid object name|Not a valid object|exists on disk, but not in/i.test(message)) {
      return null;
    }
    throw e;
  }
};

/** Line count of a blob, counting a trailing newline as ending the last line. */
export const lineCount = (contents: string): number => {
  if (contents.length === 0) return 0;
  const lines = contents.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
};
