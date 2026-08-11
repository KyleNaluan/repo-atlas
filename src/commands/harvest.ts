/**
 * `repo-atlas harvest --clone <path> [--repo owner/name] -o harvest.json`
 *
 * Reads the subject once, at full fidelity, and writes what every later stage
 * consumes. Nothing here judges anything: the harvest records what existed and
 * how it was fetched, and the probe, gate and rank stages decide what any of it
 * means.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { harvest } from "../harvest/harvest.js";
import { fileIssueCache } from "../harvest/cache.js";
import { hasResolutionComment } from "../harvest/issues.js";
import { headSha, isRepo, subjectRemote } from "../harvest/tree.js";

const USAGE = `usage: repo-atlas harvest --clone <path> [--repo <owner/name>] [-o <harvest.json>]

Captures the subject at a pinned SHA: issues and comments through raw gh api
paths with per-issue count verification, plus scale, density signals, project
memory and the declared public/private split read from a local clone.

options:
  --clone <path>       a local checkout of the subject (required)
  --repo <owner/name>  the GitHub repository (default: the clone's origin remote)
  --sha <sha>          the commit to pin (default: the clone's HEAD)
  --read-on <date>     the date recorded in the artifact (default: today, UTC)
  -o, --out <path>     where to write the harvest (default: out/harvest.json)
      --no-cache       do not write the per-issue cache

Issue and comment harvesting goes through gh api only. A convenience CLI's issue
view truncates comment bodies, and its self-reported character count is not a
fidelity check. Completeness is verified per issue against the count GitHub
itself reports, and a mismatch is a hard failure rather than a warning.

The declared-private side of a subject is never read. That it exists is
recorded, because the audit's private-source check has three applicability
states and the middle one must never be silent.`;

const flag = (argv: string[], ...names: string[]): string | undefined => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};

export const harvestCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const clone = flag(argv, "--clone");
  if (clone === undefined) {
    console.error(USAGE);
    return 64;
  }
  const clonePath = resolve(clone);
  if (!isRepo(clonePath)) {
    console.error(`harvest: ${clonePath} is not a git worktree`);
    return 78; // EX_CONFIG
  }

  const repo = flag(argv, "--repo") ?? subjectRemote(clonePath);
  if (repo === null || repo === undefined) {
    console.error(
      "harvest: could not determine the GitHub repository from the clone's origin remote; pass --repo owner/name",
    );
    return 64;
  }

  const output = resolve(flag(argv, "-o", "--out") ?? "out/harvest.json");
  const sha = flag(argv, "--sha") ?? headSha(clonePath);
  const readOn = flag(argv, "--read-on") ?? new Date().toISOString().slice(0, 10);

  const result = await harvest({ clone: clonePath, repo, sha, readOn });

  if (!argv.includes("--no-cache")) {
    const cache = fileIssueCache();
    for (const issue of result.issues) cache.put(repo, issue);
  }

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const comments = result.issues.reduce((sum, i) => sum + i.comments.length, 0);
  const bytes = result.issues.reduce(
    (sum, i) => sum + i.comments.reduce((s, c) => s + c.bytes, 0),
    0,
  );
  const withResolution = result.issues.filter(hasResolutionComment).length;

  console.log(`harvested ${repo} at ${sha} -> ${output}`);
  console.log(`  issues        ${result.issues.length} (${comments} comments, ${(bytes / 1024).toFixed(1)} KB, count-verified)`);
  console.log(`  resolutions   ${withResolution} issues carry a resolution-shaped comment`);
  console.log(`  scale         ${result.scale.files} source files, ${result.scale.lines} lines, ${result.scale.commits} commits`);
  console.log(`  density       ${result.density.source_files_citing_issues.value}/${result.density.source_files_citing_issues.of} source files cite an issue; ADR directory: ${result.density.adr_directory.value ? "yes" : "no"}`);
  console.log(`  memory        ${result.memory_files.length} project-memory ${result.memory_files.length === 1 ? "file" : "files"}, indexed never quoted`);
  console.log(`  private split ${result.private_split.declared ? `declared${result.private_split.repo ? ` (${result.private_split.repo})` : ""}, not read` : "none declared"}`);
  return 0;
};
