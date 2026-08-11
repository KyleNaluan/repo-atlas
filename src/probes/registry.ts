/**
 * The probe manifest.
 *
 * #5: adding a probe is a new module plus an entry here plus a fixture test,
 * and zero core changes. This list is the whole of the second part.
 *
 * An inapplicable probe reports "not applicable to this toolchain" BY NAME
 * rather than silently contributing nothing. Silence would make a subject with
 * no Java look identical to one where every Java probe ran and found nothing,
 * and those are different findings - the same reason #6 refuses to communicate
 * absence by silence anywhere else.
 */
import { execFileSync } from "node:child_process";
import { ciPolicyGuards } from "./library/ci-policy-guards.js";
import { decidedButUnbuilt } from "./library/decided-but-unbuilt.js";
import { dependencyAsymmetry } from "./library/dependency-asymmetry.js";
import { dependencyDivergence } from "./library/dependency-divergence.js";
import { repeatedSqlPredicates } from "./library/repeated-sql-predicates.js";
import { sealedHierarchies } from "./library/sealed-hierarchies.js";
import { throwWhereSiblingsReturn } from "./library/throw-where-siblings-return.js";
import { tunedConfigProperties } from "./library/tuned-config-properties.js";
import { detectToolchains, type Probe, type ProbeContext, type ProbeOutcome } from "./types.js";
import type { Harvest } from "../harvest/types.js";

/** All eight discovery probes ship in v1 (#5, point 1). */
export const PROBES: readonly Probe[] = [
  decidedButUnbuilt,
  dependencyDivergence,
  ciPolicyGuards,
  sealedHierarchies,
  throwWhereSiblingsReturn,
  dependencyAsymmetry,
  repeatedSqlPredicates,
  tunedConfigProperties,
] as const;

const git = (repo: string, args: string[]): string =>
  execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", LANGUAGE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A read-only view of the subject at the pinned SHA, memoised per file. */
export const treeContext = (harvest: Harvest, clone: string): ProbeContext => {
  const sha = harvest.subject.sha;
  const paths = git(clone, ["ls-tree", "-r", "--name-only", sha])
    .split("\n")
    .filter((l) => l.length > 0);
  const cache = new Map<string, string | null>();
  return {
    harvest,
    clone,
    sha,
    paths,
    read: (path) => {
      if (cache.has(path)) return cache.get(path) ?? null;
      let text: string | null;
      try {
        text = git(clone, ["cat-file", "-p", `${sha}:${path}`]);
      } catch {
        text = null;
      }
      cache.set(path, text);
      return text;
    },
  };
};

export const runProbes = async (ctx: ProbeContext): Promise<ProbeOutcome[]> => {
  const toolchains = detectToolchains(ctx.paths);
  const out: ProbeOutcome[] = [];
  for (const probe of PROBES) {
    if (!toolchains.has(probe.toolchain)) {
      out.push({
        probe_id: probe.id,
        status: "not_applicable",
        reason: `not applicable to this toolchain: the subject carries no ${probe.toolchain} source`,
      });
      continue;
    }
    out.push({ probe_id: probe.id, status: "ran", candidates: await probe.run(ctx) });
  }
  return out;
};
