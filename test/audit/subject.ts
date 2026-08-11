/**
 * A hermetic stand-in subject: a real git repository holding exactly the files
 * the reference graph cites, at a real commit.
 *
 * The audit's L1/L2 checks read the subject tree with `git cat-file`, so testing
 * them needs a tree. Cloning swe-prep in CI would make the suite need the
 * network and a 40 MB checkout to prove that a line-range comparison works.
 * Building the tree the graph asks for gives the same coverage with no network
 * and no flakiness - and it lets a mutant put a citation genuinely out of range,
 * which is the only way to watch L2 fail.
 *
 * The graph is rewritten to the synthetic commit's SHA. That is not a shortcut:
 * every check that cares about the SHA (L1, L2, L5, and the preconditions) reads
 * it from the same place, so pinning it to the synthetic commit exercises the
 * real comparison rather than bypassing it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Atlas, Evidence } from "../../src/schema/types.js";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const eachFileEvidence = (atlas: Atlas, visit: (e: Evidence) => void): void => {
  const walk = (list: Evidence[]) => list.forEach(visit);
  walk(atlas.synopsis.evidence);
  walk(atlas.shape.evidence);
  for (const n of atlas.nodes) {
    walk(n.evidence);
    if (n.type === "decision") walk(n.implemented_by);
    if (n.type === "mechanism" && n.code_excerpt) walk([n.code_excerpt.evidence]);
    if (n.type === "flow") for (const s of n.steps) if (s.evidence) walk([s.evidence]);
  }
};

export interface SyntheticSubject {
  /** Path to the git worktree, at the commit the returned atlas is pinned to. */
  clone: string;
  atlas: Atlas;
  sha: string;
}

export const buildSyntheticSubject = (source: Atlas): SyntheticSubject => {
  const atlas = structuredClone(source);
  const root = mkdtempSync(join(tmpdir(), "repo-atlas-subject-"));

  // Every cited path exists, and is long enough for every range cited into it.
  const longest = new Map<string, number>();
  eachFileEvidence(atlas, (e) => {
    if (e.kind !== "file") return;
    const end = e.line_end ?? e.line_start ?? 1;
    longest.set(e.path, Math.max(longest.get(e.path) ?? 0, end));
  });
  for (const [path, lines] of longest) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(
      full,
      Array.from({ length: lines + 5 }, (_, i) => `line ${i + 1} of ${path}`).join("\n") + "\n",
      "utf8",
    );
  }

  git(root, ["init", "--quiet", "--initial-branch=main"]);
  git(root, ["config", "user.email", "audit@test.invalid"]);
  git(root, ["config", "user.name", "audit test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  git(root, [
    "-c",
    "user.email=audit@test.invalid",
    "-c",
    "user.name=audit test",
    "commit",
    "--quiet",
    "-m",
    "synthetic subject for the audit tests",
  ]);
  const sha = git(root, ["rev-parse", "HEAD"]).trim();

  atlas.subject.sha = sha;
  eachFileEvidence(atlas, (e) => {
    if (e.kind === "file") e.sha = sha;
  });

  return { clone: root, atlas, sha };
};

/**
 * A stand-in private corpus. Small and distinctive on purpose: the point is to
 * watch P1 catch a real splice, not to re-measure the k=8 threshold that #8
 * already settled against a 688 KB corpus.
 */
export const PRIVATE_PASSAGE =
  "the studies are not two attempts at one question but two questions";

export const buildPrivateCorpus = (): string => {
  const root = mkdtempSync(join(tmpdir(), "repo-atlas-private-"));
  writeFileSync(
    join(root, "agents-evidence-shape.json"),
    `{"note": "${PRIVATE_PASSAGE} asked of the same corpus in different orders"}\n`,
    "utf8",
  );
  return root;
};
