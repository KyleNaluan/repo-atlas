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
import { getRepo } from "./gh.js";
import { harvestIssues, hasResolutionComment } from "./issues.js";
import { discoverDecisionRecords, recordsSummary } from "./records.js";
import {
  assertNotShallow,
  currentBranch,
  densitySignals,
  detectPrivateSplit,
  headSha,
  indexMemoryFiles,
  measureScale,
  scanSource,
} from "./tree.js";
import { HARVEST_VERSION, type Harvest, type HarvestSource } from "./types.js";
import type { HarvestedDecisionRecord, HarvestedIssue } from "./types.js";

export interface HarvestOptions {
  /** A local clone of the subject, checked out at the SHA to pin. */
  clone: string;
  /** `owner/repo` on GitHub. */
  repo: string;
  /** Defaults to the clone's HEAD. */
  sha?: string;
  /** The date the run reads the subject, recorded in the artifact. */
  readOn: string;
  /** An explicit override; otherwise visibility is read from the repository. */
  visibility?: string;
}

/**
 * The subject's visibility, established rather than assumed.
 *
 * The artifact renders this next to the repository link, so a hardcoded default
 * would present an unverified claim about the subject - exactly what the engine's
 * one rule forbids. It is read from the repository's own `private` flag; if that
 * cannot be determined, the fact is recorded as unestablished rather than
 * silently reported as public.
 */
const UNDETERMINED_VISIBILITY = "visibility not established";

const determineVisibility = async (repo: string): Promise<string> => {
  try {
    return (await getRepo(repo)).private ? "private" : "public";
  } catch {
    return UNDETERMINED_VISIBILITY;
  }
};

const ratio = (issue: HarvestedIssue): number | null => {
  const body = Buffer.byteLength(issue.body, "utf8");
  const comments = issue.comments.reduce((sum, c) => sum + c.bytes, 0);
  if (body === 0 || comments === 0) return null;
  return comments / body;
};

/**
 * The provenance table the artifact renders: what existed, how it was fetched,
 * and what it is admissible as.
 *
 * Exported so the admissibility line each source carries is a watched claim
 * rather than a comment. #55's D2 turns on one of them staying true - project
 * memory is still not admissible as evidence about the code - and a guarantee
 * nobody tests is a guarantee nobody knows holds.
 */
export const harvestSources = (
  issues: HarvestedIssue[],
  memory: { path: string; bytes: number }[],
  records: HarvestedDecisionRecord[],
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
  if (records.length > 0) {
    const bytes = records.reduce((sum, r) => sum + r.bytes, 0);
    out.push({
      source: "In-repo decision records",
      what_existed: `${records.length} record${records.length === 1 ? "" : "s"}, ${(bytes / 1024).toFixed(1)} KB - ${recordsSummary(records)}`,
      fetched: "read locally with git cat-file at the pinned commit, whole file or declared section",
      // The line #55's D2 amends. A record is testimony about a decision on the
      // same terms as a resolution comment, and establishes nothing about the
      // code: `implemented_by` is filled by the gate from the tree, never here.
      admissible_as: "attested (the decision, never the code)",
    });
  }
  if (memory.length > 0) {
    const bytes = memory.reduce((sum, m) => sum + m.bytes, 0);
    const sections = records.filter((r) => r.family === "memory_section").length;
    out.push({
      source: memory.map((m) => m.path).join(", "),
      what_existed: `project memory, ${(bytes / 1024).toFixed(1)} KB`,
      fetched:
        sections === 0
          ? "indexed for navigation only"
          : `indexed for navigation; ${sections} decision-headed section${sections === 1 ? "" : "s"} read as a record above`,
      admissible_as: "not admissible as evidence about the code - navigation only (#4)",
    });
  }
  return out;
};

export const harvest = async (options: HarvestOptions): Promise<Harvest> => {
  // Assert the clone is complete before spending any network round on it: a
  // shallow clone would yield plausible-but-wrong scale figures, and there is no
  // reason to harvest issues only to discover the tree cannot be measured.
  assertNotShallow(options.clone);

  const sha = options.sha ?? headSha(options.clone);
  const scan = scanSource(options.clone, sha);
  const issues = await harvestIssues(options.repo);
  const visibility = options.visibility ?? (await determineVisibility(options.repo));
  const closed = issues.filter((i) => i.state === "closed");
  const memory = indexMemoryFiles(options.clone, sha);
  // The tree's own decision records (#55). Read here rather than in `write`
  // because `candidatesFrom` rebuilds a candidate's citation from the pinned
  // written set with no clone in hand, so the span has to be in this artifact.
  const decisionRecords = discoverDecisionRecords(options.clone, sha);

  const density = densitySignals(
    options.clone,
    sha,
    {
      closedIssues: closed.length,
      closedIssuesWithResolution: closed.filter(hasResolutionComment).length,
      ratios: closed.map(ratio).filter((r): r is number => r !== null),
    },
    scan,
  );

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
      visibility,
    },
    issues,
    scale: measureScale(options.clone, sha, scan),
    density,
    sources: harvestSources(issues, memory, decisionRecords),
    private_split: detectPrivateSplit(options.clone, sha, options.repo),
    memory_files: memory,
    decision_records: decisionRecords,
  };
};
