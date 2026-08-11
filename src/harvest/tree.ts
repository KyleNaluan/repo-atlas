/**
 * The local half of the harvest: scale, the density signals that need the tree,
 * project memory, and the declared public/private split.
 *
 * All of it reads the clone at the pinned SHA rather than the API, and it comes
 * with a shallow-clone guard (#4). A shallow clone answers "how many commits"
 * with the number it happens to hold, which is a plausible-looking number that
 * is not the answer to the question - the worst kind of wrong for a document
 * whose whole claim is that its figures were measured.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DensitySignals, PrivateSplit, ScaleCounts } from "./types.js";

export class ShallowCloneError extends Error {
  constructor(path: string) {
    super(
      `${path} is a shallow clone. Commit counts and repository age measured here would report ` +
        `the slice that happens to be present, which looks like an answer and is not one. ` +
        `Fetch the full history (git fetch --unshallow) before harvesting.`,
    );
    this.name = "ShallowCloneError";
  }
}

const git = (repo: string, args: string[]): string =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", LANGUAGE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

export const assertNotShallow = (repo: string): void => {
  if (git(repo, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new ShallowCloneError(repo);
  }
};

/** Every path in the tree at a commit. */
export const treeFiles = (repo: string, sha: string): string[] =>
  git(repo, ["ls-tree", "-r", "--name-only", sha])
    .split("\n")
    .filter((l) => l.length > 0);

const SOURCE_EXTENSIONS = /\.(java|ts|tsx|js|jsx|py|go|rb|rs|kt|scala|c|cc|cpp|h|hpp|cs|php|sql)$/i;
const TEST_PATH = /(^|\/)(test|tests|spec|__tests__)(\/|$)|\.(test|spec)\./i;

export const isSourceFile = (path: string): boolean =>
  SOURCE_EXTENSIONS.test(path) && !TEST_PATH.test(path);

/** A blob's text at a commit, or null when the path is absent at that SHA. */
export const fileAt = (repo: string, sha: string, path: string): string | null => {
  try {
    return git(repo, ["cat-file", "-p", `${sha}:${path}`]);
  } catch {
    return null;
  }
};

const blob = fileAt;

const countLines = (text: string): number => {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
};

/**
 * Does a source file cite an issue number *in a comment*? (#6, signal 3)
 *
 * The signal renders as a measured density figure, so it must count only what it
 * claims: a `#N` that a human wrote in a comment to reference an issue, not any
 * `#`-then-digits token anywhere in the bytes. The match is deliberately a
 * legible heuristic rather than a parser:
 *
 * - The `#N` must sit in a comment, keyed off the marker for the file's language
 *   family (`//`, `/*` or a leading `*` for C-family; `#` for Python/Ruby; `--`
 *   or `/*` for SQL). A `#2` in a bare string in a C-family file is not counted.
 * - A token containing a hex letter is a colour (`#1e1e1e`), never a citation.
 *   There is deliberately NO exclusion by digit-run length: an all-digit token of
 *   length 3, 4, 6 or 8 could be a colour (`#333`) but is far more often an issue
 *   number, and excluding those lengths silently dropped `#190`, `#114`, `#222`
 *   and `#459` - the bare citations #10 names as the sharpest test of the
 *   honest-degradation subject. A rare `// palette #333` counted as a citation is
 *   a small over-count; dropping every three-digit issue number is a false
 *   negative in the signal that decides how much decision record a repo has.
 * - A `#` immediately preceded by a quote or `=` is an anchor or attribute value
 *   (`href="#404"`) and is never a citation.
 */
const C_FAMILY = /\.(java|ts|tsx|js|jsx|go|rs|kt|scala|c|cc|cpp|h|hpp|cs|php)$/i;
const HASH_FAMILY = /\.(py|rb)$/i;
const SQL_FAMILY = /\.sql$/i;
const CITATION_TOKEN = /#[0-9A-Za-z]+/g;

const commentStart = (line: string, path: string): number => {
  const marks: number[] = [];
  const at = (needle: string): void => {
    const i = line.indexOf(needle);
    if (i !== -1) marks.push(i);
  };
  const leadingStar = (): void => {
    const m = /^\s*\*/.exec(line);
    if (m) marks.push(m[0].length - 1);
  };
  if (C_FAMILY.test(path)) {
    at("//");
    at("/*");
    leadingStar();
  } else if (HASH_FAMILY.test(path)) {
    at("#");
  } else if (SQL_FAMILY.test(path)) {
    at("--");
    at("/*");
    leadingStar();
  }
  return marks.length === 0 ? -1 : Math.min(...marks);
};

const citesIssue = (text: string, path: string): boolean => {
  for (const line of text.split("\n")) {
    const start = commentStart(line, path);
    if (start === -1) continue;
    CITATION_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITATION_TOKEN.exec(line)) !== null) {
      if (m.index < start) continue;
      const rest = m[0].slice(1);
      // Decimal only: a token carrying a hex letter is a colour, not an issue
      // number, and this test already excludes it.
      if (!/^\d+$/.test(rest)) continue;
      const before = m.index > 0 ? line[m.index - 1] : "";
      if (before === '"' || before === "'" || before === "=") continue;
      return true;
    }
  }
  return false;
};

/**
 * One pass over the source tree.
 *
 * The line count (#7 scale) and the issue-citation count (#6 signal 3) both need
 * every source blob, and reading the tree twice spawns a `git cat-file` per file
 * per reader. This reads each blob once and derives both, so a caller that needs
 * both figures - the harvest does - pays for a single pass. It is threaded into
 * `measureScale` and `countSourceFilesCitingIssues` so both stay independently
 * callable without either re-reading the tree.
 */
export interface SourceScan {
  files: number;
  lines: number;
  citing: number;
}

export const scanSource = (repo: string, sha: string): SourceScan => {
  const files = treeFiles(repo, sha).filter(isSourceFile);
  let lines = 0;
  let citing = 0;
  for (const path of files) {
    const text = blob(repo, sha, path);
    lines += countLines(text ?? "");
    if (text !== null && citesIssue(text, path)) citing += 1;
  }
  return { files: files.length, lines, citing };
};

const measureHistory = (
  repo: string,
  sha: string,
): Pick<ScaleCounts, "commits" | "first_commit" | "last_commit" | "days"> => {
  const commits = Number(git(repo, ["rev-list", "--count", sha]).trim());
  const dates = git(repo, ["log", "--format=%ad", "--date=short", sha])
    .split("\n")
    .filter((l) => l.length > 0);
  const last = dates[0] ?? null;
  const first = dates[dates.length - 1] ?? null;
  const days =
    first !== null && last !== null
      ? Math.round(
          (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000,
        ) + 1
      : null;

  return { commits, first_commit: first, last_commit: last, days };
};

export const measureScale = (repo: string, sha: string, scan?: SourceScan): ScaleCounts => {
  assertNotShallow(repo);
  const source = scan ?? scanSource(repo, sha);
  return { files: source.files, lines: source.lines, ...measureHistory(repo, sha) };
};

/** #4: project memory is indexed for navigation, never quoted as evidence. */
const MEMORY_FILES = /^(AGENTS|CLAUDE|CONTRIBUTING|\.cursorrules)(\.md)?$/i;

export const indexMemoryFiles = (
  repo: string,
  sha: string,
): { path: string; bytes: number }[] =>
  treeFiles(repo, sha)
    .filter((p) => MEMORY_FILES.test(p.split("/").pop() ?? ""))
    .map((path) => ({ path, bytes: Buffer.byteLength(blob(repo, sha, path) ?? "", "utf8") }))
    .sort((a, b) => a.path.localeCompare(b.path));

const ADR_DIRECTORIES = ["docs/adr", "adr", "doc/adr", "docs/decisions", "docs/architecture"];

/** Does the tree carry an architecture-decision-record directory? (#6, signal 4) */
export const findAdrDirectory = (repo: string, sha: string): string | null => {
  const paths = treeFiles(repo, sha);
  for (const dir of ADR_DIRECTORIES) {
    if (paths.some((p) => p.startsWith(`${dir}/`))) return dir;
  }
  return null;
};

/** Source files citing an issue number in a comment. (#6, signal 3) */
export const countSourceFilesCitingIssues = (
  repo: string,
  sha: string,
  scan?: SourceScan,
): { citing: number; of: number } => {
  const source = scan ?? scanSource(repo, sha);
  return { citing: source.citing, of: source.files };
};

export interface DensityInputs {
  closedIssues: number;
  closedIssuesWithResolution: number;
  /** Per-issue ratio of total comment bytes to body bytes, for issues that have both. */
  ratios: number[];
}

export const densitySignals = (
  repo: string,
  sha: string,
  inputs: DensityInputs,
  scan?: SourceScan,
): DensitySignals => {
  const adr = findAdrDirectory(repo, sha);
  const citing = countSourceFilesCitingIssues(repo, sha, scan);
  const mean =
    inputs.ratios.length === 0
      ? 0
      : inputs.ratios.reduce((a, b) => a + b, 0) / inputs.ratios.length;
  return {
    closed_issues_with_resolution_comment: {
      value: inputs.closedIssuesWithResolution,
      of: inputs.closedIssues,
    },
    comment_to_body_ratio: {
      value: Number(mean.toFixed(2)),
      note:
        inputs.ratios.length === 0
          ? "no closed issue carried both a body and a comment to compare"
          : `mean over ${inputs.ratios.length} closed issues with both a body and comments`,
    },
    source_files_citing_issues: { value: citing.citing, of: citing.of },
    adr_directory: {
      value: adr !== null,
      note: adr === null ? "no ADR or decision-record directory in the tree" : `found at ${adr}/`,
    },
  };
};

/**
 * Whether the subject declares a public/private split.
 *
 * Detected from the tree's own declarations rather than guessed: a companion
 * repository named in the README and described there as private. A .gitignore
 * entry is deliberately NOT treated as a declaration - it says "do not commit
 * this", not "a private source exists" - so declared:false is the honest default
 * when the README names nothing. The private side is NEVER read - this records
 * only that it exists, which is what #8's P1 needs to choose between its three
 * states.
 */
export const detectPrivateSplit = (
  repo: string,
  sha: string,
  subjectRepo: string,
): PrivateSplit => {
  const readme = blob(repo, sha, "README.md") ?? "";
  const owner = subjectRepo.split("/")[0] ?? "";

  // A companion repository named in the README and described as private.
  const companion = new RegExp(`${owner}/([\\w.-]*(?:content|private|data)[\\w.-]*)`, "i").exec(
    readme,
  );
  // A README often names the clone URL rather than the repository, and the
  // trailing .git is part of the URL, not of the name the audit will compare
  // against.
  const companionName = companion?.[1]?.replace(/\.git$/i, "");
  const declaresPrivate = /\bPRIVATE\b/.test(readme) || /private repo/i.test(readme);

  if (companion && declaresPrivate) {
    return {
      declared: true,
      repo: `${owner}/${companionName}`,
      // Harvest never reads it, so it is never readable here by construction.
      readable_at_harvest: false,
      note:
        "declared in the subject's README as a separate private repository; harvest does not read " +
        "the private side, so no content from it can reach the artifact",
    };
  }

  return { declared: false, readable_at_harvest: false };
};

export const subjectRemote = (repo: string): string | null => {
  try {
    const url = git(repo, ["remote", "get-url", "origin"]).trim();
    const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
};

export const headSha = (repo: string): string => git(repo, ["rev-parse", "HEAD"]).trim();

export const currentBranch = (repo: string): string => {
  try {
    return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return "HEAD";
  }
};

export const isRepo = (path: string): boolean => {
  if (!existsSync(path)) return false;
  try {
    return statSync(join(path, ".git")).isDirectory() || statSync(join(path, ".git")).isFile();
  } catch {
    try {
      return git(path, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
    } catch {
      return false;
    }
  }
};
