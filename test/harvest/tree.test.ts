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
import { harvestSources } from "../../src/harvest/harvest.js";
import type { HarvestedDecisionRecord, HarvestedIssue } from "../../src/harvest/types.js";

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

/* ------------------------------------------- what each source is admissible as */

describe("the provenance table", () => {
  const issues: HarvestedIssue[] = [];
  const memory = [{ path: "AGENTS.md", bytes: 4096 }];
  const record = (family: HarvestedDecisionRecord["family"]): HarvestedDecisionRecord => ({
    id: "d-file-docs-adr-0001-a-md-L1",
    family,
    path: "docs/adr/0001-a.md",
    line_start: 1,
    line_end: 20,
    heading: "0001. A decision",
    body: "# 0001. A decision\n",
    bytes: 19,
    cites_issues: [],
  });

  it("keeps project memory inadmissible as evidence about the code", () => {
    // #4's guarantee, and the half #55 did NOT amend. A memory file is testimony
    // about a decision and establishes nothing about the tree; the gate is what
    // settles a build claim, from paths it located itself. If this line ever
    // reads as plain "evidence", the amendment has been widened by accident.
    const line = harvestSources(issues, memory, [record("memory_section")]).find((s) =>
      s.source.includes("AGENTS.md"),
    )!;
    expect(line.admissible_as).toContain("not admissible as evidence about the code");
    // And it says, rather than hides, that a section of it was read as a record.
    expect(line.fetched).toContain("1 decision-headed section");
  });

  it("names the in-repo record source and what it is admissible as", () => {
    const line = harvestSources(issues, memory, [record("adr_directory")]).find(
      (s) => s.source === "In-repo decision records",
    )!;
    expect(line.admissible_as).toBe("attested (the decision, never the code)");
    expect(line.what_existed).toContain("under a decision-record directory");
  });

  it("reports no such source when the tree declared none", () => {
    // #6: an absent source is absent by name, never by a line that reads as zero.
    const table = harvestSources(issues, memory, []);
    expect(table.some((s) => s.source === "In-repo decision records")).toBe(false);
    expect(table.find((s) => s.source.includes("AGENTS.md"))!.fetched).toBe(
      "indexed for navigation only",
    );
  });
});
