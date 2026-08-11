/**
 * The audit asserts its preconditions before any check runs, and a missing one
 * is its own outcome (#8, section 3).
 *
 * This exists because of a real failure: the prototype's first resolver run
 * happened to execute outside the clone and reported all 47 file links as
 * MISSING PATH, with no indication that the REPOSITORY, not the paths, was
 * missing. The silently-inverted version of that bug reports a clean pass, which
 * is worse - an audit that cannot see the tree must never be able to say the
 * artifact checked out against it.
 *
 * So: clone present, HEAD equals the run SHA, worktree clean. A failure here is
 * `failed: precondition`, never a pass and never a silent skip.
 */
import { headSha, isClean, isRepo, isShallow } from "./git.js";

export interface PreconditionResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

export const checkPreconditions = (clone: string, sha: string): PreconditionResult => {
  const problems: string[] = [];
  const notes: string[] = [];

  if (!isRepo(clone)) {
    return {
      ok: false,
      problems: [
        `${clone} is not a git worktree. Every file citation resolves against a local clone of the subject at the pinned SHA; without one the audit cannot check any of them, and reporting them all as missing would be a lie about the artifact rather than about the audit.`,
      ],
      notes,
    };
  }

  let head: string;
  try {
    head = headSha(clone);
  } catch (e) {
    return { ok: false, problems: [(e as Error).message], notes };
  }

  if (head !== sha) {
    problems.push(
      `${clone} is at ${head} but this run is pinned to ${sha}. Check out the pinned commit before auditing.`,
    );
  }
  if (!isClean(clone)) {
    problems.push(
      `${clone} has uncommitted changes. A dirty worktree means a file citation could resolve against content that is not at the pinned commit.`,
    );
  }
  // A shallow clone can still hold the pinned commit; it is a hazard worth
  // naming rather than a failure, and #4 already imposes the same guard on
  // harvest.
  try {
    if (isShallow(clone)) {
      notes.push(`${clone} is a shallow clone; only the fetched history is resolvable.`);
    }
  } catch {
    // rev-parse --is-shallow-repository is old-git-dependent; its absence is not
    // a precondition failure.
  }

  return { ok: problems.length === 0, problems, notes };
};
