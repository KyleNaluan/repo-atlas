/**
 * The harvest stage: everything later stages read, captured once and at full
 * fidelity.
 *
 * Two properties this stage owes the rest of the engine:
 *
 *  - completeness is VERIFIED, per issue, against the count GitHub itself
 *    reports, and a mismatch is a hard failure;
 *  - provenance is RECORDED - what existed, how it was fetched, and what it is
 *    admissible as - so #8's audit can decide the private-source check's
 *    applicability from data rather than from a guess about the subject.
 */
import { harvestIssues, hasResolutionComment } from "./issues.js";
import {
  currentBranch,
  densitySignals,
  detectPrivateSplit,
  headSha,
  indexMemoryFiles,
  measureScale,
} from "./tree.js";
import { HARVEST_VERSION, type Harvest, type HarvestSource } from "./types.js";
import type { HarvestedIssue } from "./types.js";

export interface HarvestOptions {
  /** A local clone of the subject, checked out at the SHA to pin. */
  clone: string;
  /** `owner/repo` on GitHub. */
  repo: string;
  /** Defaults to the clone's HEAD. */
  sha?: string;
  /** The date the run reads the subject, recorded in the artifact. */
  readOn: string;
  visibility?: string;
}

const ratio = (issue: HarvestedIssue): number | null => {
  const body = Buffer.byteLength(issue.body, "utf8");
  const comments = issue.comments.reduce((sum, c) => sum + c.bytes, 0);
  if (body === 0 || comments === 0) return null;
  return comments / body;
};

const sources = (
  issues: HarvestedIssue[],
  memory: { path: string; bytes: number }[],
): HarvestSource[] => {
  const withResolution = issues.filter(hasResolutionComment).length;
  const out: HarvestSource[] = [
    {
      source: "GitHub issue resolution comments",
      what_existed: `${withResolution} of ${issues.length} issues carry a resolution-shaped comment`,
      fetched: "in full via gh api .../issues/{n}/comments, count-verified against the issue's own comment count",
      admissible_as: "attested",
    },
    {
      source: "Issue bodies",
      what_existed: `${issues.length} non-PR issues`,
      fetched: "in full via gh api, never a convenience view",
      admissible_as: "attested (the question, not the answer)",
    },
    {
      source: "Code at the pinned SHA",
      what_existed: "the subject tree",
      fetched: "read locally with git cat-file at the pinned commit",
      admissible_as: "verified",
    },
  ];
  if (memory.length > 0) {
    const bytes = memory.reduce((sum, m) => sum + m.bytes, 0);
    out.push({
      source: memory.map((m) => m.path).join(", "),
      what_existed: `project memory, ${(bytes / 1024).toFixed(1)} KB`,
      fetched: "indexed for navigation only",
      admissible_as: "not admissible - navigation, never evidence",
    });
  }
  return out;
};

export const harvest = async (options: HarvestOptions): Promise<Harvest> => {
  const sha = options.sha ?? headSha(options.clone);
  const issues = await harvestIssues(options.repo);
  const closed = issues.filter((i) => i.state === "closed");
  const memory = indexMemoryFiles(options.clone, sha);

  const density = densitySignals(options.clone, sha, {
    closedIssues: closed.length,
    closedIssuesWithResolution: closed.filter(hasResolutionComment).length,
    ratios: closed.map(ratio).filter((r): r is number => r !== null),
  });

  const [owner, name] = options.repo.split("/");
  return {
    harvest_version: HARVEST_VERSION,
    subject: {
      owner: owner ?? "",
      repo: name ?? "",
      url: `https://github.com/${options.repo}`,
      branch: currentBranch(options.clone),
      sha,
      read_on: options.readOn,
      visibility: options.visibility ?? "public",
    },
    issues,
    scale: measureScale(options.clone, sha),
    density,
    sources: sources(issues, memory),
    private_split: detectPrivateSplit(options.clone, sha, options.repo),
    memory_files: memory,
  };
};
