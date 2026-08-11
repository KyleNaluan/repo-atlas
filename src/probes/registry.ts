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
import { parseJava, type SyntaxNode } from "./java.js";
import { detectToolchains, type Probe, type ProbeContext, type ProbeOutcome } from "./types.js";
import type { AtlasNode } from "../schema/types.js";
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
  const trees = new Map<string, Promise<SyntaxNode | null>>();
  const read = (path: string): string | null => {
    if (cache.has(path)) return cache.get(path) ?? null;
    let text: string | null;
    try {
      text = git(clone, ["cat-file", "-p", `${sha}:${path}`]);
    } catch {
      text = null;
    }
    cache.set(path, text);
    return text;
  };
  return {
    harvest,
    clone,
    sha,
    paths,
    read,
    // Memoise parse trees alongside the read cache: the read cache dedupes file
    // reads, but the parse tree is the expensive part, and three structural
    // probes each iterate every .java path. Keyed by path, caching the promise
    // so a second asker joins the first parse rather than starting another.
    parse: (path) => {
      const cached = trees.get(path);
      if (cached) return cached;
      const tree = (async (): Promise<SyntaxNode | null> => {
        const source = read(path);
        return source === null ? null : parseJava(source);
      })();
      trees.set(path, tree);
      return tree;
    },
  };
};

/** A candidate id minted by more than one candidate, with every probe that minted it. */
export interface CandidateIdCollision {
  id: string;
  probes: string[];
}

/** A (type, title) pair minted by more than one candidate: the same finding twice. */
export interface CandidateFindingCollision {
  type: string;
  title: string;
  probes: string[];
}

/**
 * Every candidate id is used verbatim as the rendered element id, so a duplicate
 * is not a cosmetic defect: it produces invalid HTML and breaks the audit checks
 * that resolve nodes by element id (G1 absent-node, G2 resurrection, the E1
 * provenance walk). Per-probe semantic discriminators keep ids readable; this
 * guard, enforced once where candidates are collected, is what makes uniqueness
 * a guarantee rather than something each future probe has to remember.
 *
 * On a collision it drops ONLY the colliding candidates and reports them, rather
 * than throwing: one defective probe must not make an entire subject unprobeable,
 * so the other probes' candidates survive to be inspected and rendered. The
 * guarantee that matters is preserved exactly - no duplicate id reaches the
 * artifact - and this is NOT silent dropping: `runProbes` reports every collision
 * by name and fails the run at the end. "Dropped and reported" is a different
 * thing from "dropped", and the difference is the whole point.
 */
export const dedupeCandidateIds = (
  outcomes: ProbeOutcome[],
): { outcomes: ProbeOutcome[]; collisions: CandidateIdCollision[] } => {
  const owners = new Map<string, string[]>();
  for (const o of outcomes) {
    if (o.status !== "ran") continue;
    for (const c of o.candidates) {
      owners.set(c.node.id, [...(owners.get(c.node.id) ?? []), c.probe_id]);
    }
  }
  const collisions = [...owners]
    .filter(([, probes]) => probes.length > 1)
    .map(([id, probes]) => ({ id, probes }));
  const dropped = new Set(collisions.map((c) => c.id));
  const cleaned = outcomes.map((o) =>
    o.status === "ran"
      ? { ...o, candidates: o.candidates.filter((c) => !dropped.has(c.node.id)) }
      : o,
  );
  return { outcomes: cleaned, collisions };
};

/**
 * The id guard proves no two candidates share an ID; it cannot prove no two
 * candidates describe the same FINDING. Those are different guarantees: two
 * candidates can carry distinct ids - one differing by an occurrence ordinal,
 * another by a vocabulary alias - and still assert one and the same thing, which
 * the id guard passes through unseen. Per-probe grouping is meant to prevent
 * that, but it has failed more than once, in more than one probe, so the
 * invariant needs a structural backstop of its own rather than per-probe
 * vigilance.
 *
 * The key is (type, title, evidence): two candidates are the same finding only
 * when they assert the same thing ABOUT THE SAME PLACE. Title alone is too
 * coarse - two method overloads that both refuse (`add(String)` and
 * `add(int,String)`), or two same-simple-named types in different packages
 * (`a.Grader` and `b.Grader`), legitimately share a title yet are distinct
 * findings that earlier review rounds required to survive. What separates them
 * is the evidence they point at: different lines, different files. The genuine
 * duplicates this guards against - the same setting emitted twice, one
 * technology matched under two aliases - are byte-identical in title AND
 * evidence and differ only in the id, which is exactly what this catches.
 *
 * It behaves exactly like the id guard - drop ONLY the duplicated candidates,
 * report every collision by name with the probes that produced it, and fail the
 * run at the end - so one over-eager probe cannot make a whole subject
 * unprobeable, and this is "dropped and reported", never silent dropping.
 */
export const dedupeCandidateFindings = (
  outcomes: ProbeOutcome[],
): { outcomes: ProbeOutcome[]; collisions: CandidateFindingCollision[] } => {
  const key = (node: AtlasNode): string => JSON.stringify([node.type, node.title, node.evidence]);
  const owners = new Map<string, { type: string; title: string; probes: string[] }>();
  for (const o of outcomes) {
    if (o.status !== "ran") continue;
    for (const c of o.candidates) {
      const k = key(c.node);
      const prev = owners.get(k);
      owners.set(k, {
        type: c.node.type,
        title: c.node.title,
        probes: [...(prev?.probes ?? []), c.probe_id],
      });
    }
  }
  const dropped = new Set([...owners].filter(([, v]) => v.probes.length > 1).map(([k]) => k));
  const collisions = [...owners.values()]
    .filter((v) => v.probes.length > 1)
    .map(({ type, title, probes }) => ({ type, title, probes }));
  const cleaned = outcomes.map((o) =>
    o.status === "ran"
      ? { ...o, candidates: o.candidates.filter((c) => !dropped.has(key(c.node))) }
      : o,
  );
  return { outcomes: cleaned, collisions };
};

export const runProbes = async (
  ctx: ProbeContext,
): Promise<{
  outcomes: ProbeOutcome[];
  idCollisions: CandidateIdCollision[];
  findingCollisions: CandidateFindingCollision[];
}> => {
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
  const byId = dedupeCandidateIds(out);
  const byFinding = dedupeCandidateFindings(byId.outcomes);
  return {
    outcomes: byFinding.outcomes,
    idCollisions: byId.collisions,
    findingCollisions: byFinding.collisions,
  };
};
