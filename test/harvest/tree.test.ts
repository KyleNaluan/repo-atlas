/**
 * `fileAt` reads a blob at a pinned commit, not from the working tree.
 *
 * The write command grounds the product sentence in the README and stamps its
 * citation as {path, sha}. Those two must share one source: if the command read
 * the working tree while the citation asserted the SHA, a drifted checkout would
 * make the artifact cite bytes it never summarized. These tests pin that the
 * read is by commit - a working-tree edit is invisible, and a README absent at
 * the SHA yields null (which the command turns into an empty string, so the
 * writer reports the prose inadmissible rather than guessing).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAt } from "../../src/harvest/tree.js";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const repoWithReadme = (body: string): { path: string; sha: string } => {
  const path = mkdtempSync(join(tmpdir(), "repo-atlas-tree-"));
  writeFileSync(join(path, "README.md"), body, "utf8");
  git(path, ["init", "--quiet", "--initial-branch=main"]);
  git(path, ["config", "user.email", "tree@test.invalid"]);
  git(path, ["config", "user.name", "tree test"]);
  git(path, ["config", "commit.gpgsign", "false"]);
  git(path, ["add", "-A"]);
  git(path, ["commit", "--quiet", "-m", "subject"]);
  return { path, sha: git(path, ["rev-parse", "HEAD"]).trim() };
};

describe("fileAt", () => {
  it("reads the committed bytes, not a modified working copy", () => {
    const { path, sha } = repoWithReadme("committed synopsis\n");
    writeFileSync(join(path, "README.md"), "drifted working-tree synopsis\n", "utf8");
    expect(fileAt(path, sha, "README.md")).toBe("committed synopsis\n");
  });

  it("returns null for a README present in the working tree but absent at the SHA", () => {
    const { path, sha } = repoWithReadme("committed synopsis\n");
    // A file added after the pinned commit exists on disk but not at the SHA.
    writeFileSync(join(path, "LATER.md"), "added after the commit\n", "utf8");
    expect(fileAt(path, sha, "LATER.md")).toBeNull();
  });
});
