/**
 * A real, tiny git repository to run the Flow producer against.
 *
 * Every Flow fixture in this suite is a genuine tree at a genuine SHA rather
 * than a hand-written candidate, because both halves of the guarantee under test
 * read the tree: the producer walks a parse index, and the gate rereads the pinned
 * blob. A fixture that skipped the repository would exercise neither.
 *
 * Extracted from `flow-producer.test.ts` when PR 8's entry adapters needed the
 * same harness; the two files test different adapters over the same machinery.
 */
import { expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROBES, treeContext } from "../../src/probes/registry.js";
import type { Candidate, ProbeContext } from "../../src/probes/types.js";
import type { Harvest } from "../../src/harvest/types.js";

export const buildTree = (files: Record<string, string>): { path: string; sha: string } => {
  const path = mkdtempSync(join(tmpdir(), "repo-atlas-flow-"));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), contents, "utf8");
  }
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "flow@test.invalid"]);
  git(["config", "user.name", "flow test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "subject"]);
  return { path, sha: git(["rev-parse", "HEAD"]).trim() };
};

export const contextFor = (files: Record<string, string>): ProbeContext => {
  const tree = buildTree(files);
  const harvest = {
    harvest_version: "1.0.0",
    subject: {
      owner: "o",
      repo: "r",
      url: "https://example.invalid/o/r",
      branch: "main",
      sha: tree.sha,
      read_on: "2026-08-21",
      visibility: "public",
    },
    issues: [],
    scale: { files: 0, lines: 0, commits: 1, first_commit: null, last_commit: null, days: null },
    density: {
      closed_issues_with_resolution_comment: { value: 0, of: 0 },
      comment_to_body_ratio: { value: 0 },
      source_files_citing_issues: { value: 0, of: 0 },
      adr_directory: { value: false },
    },
    sources: [],
    private_split: { declared: false, readable_at_harvest: false },
    memory_files: [],
  } as unknown as Harvest;
  return treeContext(harvest, tree.path);
};

/** Run one registered adapter, honouring its own applicability answer. */
export const runAdapter = async (id: string, ctx: ProbeContext): Promise<Candidate[]> => {
  const probe = PROBES.find((p) => p.id === id)!;
  const applies = probe.applies ? await probe.applies(ctx) : { ok: true as const };
  return applies.ok ? probe.run(ctx) : [];
};

export const only = <T>(list: T[]): T => {
  expect(list).toHaveLength(1);
  return list[0]!;
};
