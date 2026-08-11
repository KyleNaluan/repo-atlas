/**
 * What a probe is, and what it may do.
 *
 * #5's resolution is strict about this and the strictness is the point: a probe
 * is a PURE DETERMINISTIC FUNCTION over harvest artifacts. No network, no model
 * calls, ever. Each one encodes a single piece of human judgement about what is
 * worth finding, while staying cheap, cacheable and unit-testable against
 * fixtures - and that is what keeps the "mechanics propose, judgement deletes"
 * boundary from #2 intact.
 *
 * A probe emits CANDIDATES, never final nodes. The existence gate verifies them
 * and the rank stage owns acceptance and deletion. A probe that writes into the
 * final node set would bypass both.
 *
 * A probe that finds nothing emits nothing: absence of candidates is not an
 * error. A probe that does not APPLY says so by name, which is a different
 * thing and part of the degradation story.
 */
import type { AtlasNode } from "../schema/types.js";
import type { Harvest } from "../harvest/types.js";

/** What a probe needs. Nothing here reaches the network or a model. */
export interface ProbeContext {
  harvest: Harvest;
  /** A local checkout of the subject at the pinned SHA. */
  clone: string;
  sha: string;
  /** Every path in the tree at the pinned SHA. */
  paths: string[];
  /** Read one file at the pinned SHA, or null if it is not there. */
  read: (path: string) => string | null;
}

/**
 * A proposed node, before the gate has confirmed anything about it.
 *
 * `probe_id` is provenance and is carried onto the node, so the artifact can
 * say which piece of judgement proposed a finding and the gate can report on
 * one probe's output at a time.
 */
export interface Candidate {
  probe_id: string;
  node: AtlasNode;
  /**
   * What the gate must confirm against the tree before this can render.
   * Empty means the candidate is already grounded in what the probe read.
   */
  claims?: ExistenceClaim[];
}

/**
 * A claim about the tree that the existence gate resolves.
 *
 * #7's point 7 makes the gate bidirectional, which is the whole reason this
 * type has a `expect` field rather than being a list of things to find: the
 * gate must be able to overturn the record in BOTH directions. A stated
 * decision is not evidence of implementation, and an open ticket is not
 * evidence of absence.
 */
export interface ExistenceClaim {
  /** Human-readable, used in the divergence edge when the tree disagrees. */
  description: string;
  /** What the record implies: that the thing exists, or that it does not. */
  expect: "present" | "absent";
  /** Paths whose existence at the pinned SHA settles the claim. */
  paths?: string[];
  /** A pattern that must be found in the tree's source to settle it. */
  pattern?: { regex: string; include?: string };
  /**
   * The spellings of one technology the gate must resolve against declared build
   * manifests, parsed the SAME way the probe decided it (`declaredManifests`)
   * rather than by a looser substring proxy. The claim is settled by whether any
   * manifest declares a dependency whose name contains ANY of these aliases.
   * Sharing one definition of "declared" is the point: a mention in a comment, a
   * plugin name or a transitive coordinate must not read as a declaration on
   * either side and flip a correct finding into a spurious divergence. The list
   * (rather than a single string) is what lets one technology be one concept on
   * both sides - a dependency declared as `postgresql` satisfies a README that
   * says `postgres`.
   */
  declares?: string[];
}

export type Toolchain = "any" | "java" | "typescript" | "python";

export interface Probe {
  id: string;
  /** One line: the human judgement this probe encodes. */
  finds: string;
  /**
   * The toolchains this probe understands. v1 implements the five code-level
   * probes for Java only, because both v1 subjects are Java; declaring it keeps
   * the seam explicit rather than shipping unexercised TS/Python probe code.
   */
  toolchain: Toolchain;
  /**
   * Async only because three probes need a WASM parse tree; nothing here waits
   * on the network or on a model, and every probe is deterministic.
   */
  run: (ctx: ProbeContext) => Candidate[] | Promise<Candidate[]>;
}

export type ProbeOutcome =
  | { probe_id: string; status: "ran"; candidates: Candidate[] }
  | { probe_id: string; status: "not_applicable"; reason: string };

/**
 * Whether a subject's tree gives a probe anything to work on.
 *
 * An inapplicable probe reports "not applicable to this toolchain" rather than
 * silently passing (#5). Silence would make a subject with no Java look
 * identical to one where every Java probe found nothing, and those are
 * different findings.
 */
export const detectToolchains = (paths: string[]): Set<Toolchain> => {
  const found = new Set<Toolchain>(["any"]);
  if (paths.some((p) => p.endsWith(".java"))) found.add("java");
  if (paths.some((p) => /\.(ts|tsx)$/.test(p))) found.add("typescript");
  if (paths.some((p) => p.endsWith(".py"))) found.add("python");
  return found;
};
