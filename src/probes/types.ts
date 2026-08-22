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
import type { AtlasNode, FileEvidence } from "../schema/types.js";
import type { Harvest } from "../harvest/types.js";
import type { SyntaxNode } from "./java.js";

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
  /**
   * The parse tree of one file at the pinned SHA, or null if it is not there.
   * Memoised by path, so three structural probes asking for the same file share
   * one parse rather than reparsing the whole Java tree once each. Probes stay
   * independent - they ask for a parse and get a cached one, never coordinating.
   */
  parse: (path: string) => Promise<SyntaxNode | null>;
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
  /**
   * Atomic relationship claims for a Flow. These stay candidate-only: the
   * final graph carries the independently checked links and their evidence,
   * never the producer's proposed proof recipe.
   */
  flow_claims?: FlowClaim[];
  /**
   * Why a producer proposed this candidate as `absent` rather than as a chain
   * to check.
   *
   * A Flow producer can fail in several different ways - a receiver it cannot
   * type, a dispatch this phase closes no set for, a bound reached before a
   * terminal - and #6 forbids communicating absence by silence. The gate refuses
   * to promote an absent proposal either way; this is what lets the reason reach
   * `record.absent_cuts` instead of being replaced by a generic refusal.
   */
  absent_reason?: string;
}

/** A source symbol named precisely enough for the gate to locate it again. */
export interface SymbolRef {
  /** Subject-relative path at the candidate's pinned SHA. */
  path: string;
  /** Method, function, type, table, model, or other source-owned identifier. */
  name: string;
  /** Containing or receiver type, when a same-name symbol would be ambiguous. */
  owner?: string;
  /**
   * The type the call is written ON, when that is not where the target is
   * declared - an inherited call, or a nested type calling its enclosing one.
   *
   * `owner` says where the gate will find the declaration; this says what the
   * caller's source actually names. They differ exactly when inheritance is
   * load-bearing, and the gate re-derives the relation between them from the
   * blob rather than taking the producer's word for it.
   */
  receiver?: string;
  /** Call/declaration arity, when overloads exist. */
  arity?: number;
  /** Exact endpoint contract for a transport claim. */
  protocol?: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
    path: string;
  };
}

export type FlowMatcher =
  | "direct_call"
  | "spring_route"
  | "closed_dispatch"
  | "data_access"
  /**
   * A DATA-LINEAGE arrow: the record on the left, the derivation that reads it on
   * the right (#35, PR 7, report 5.5).
   *
   * It shares the `read` relation with `data_access` and points the OTHER WAY,
   * because a request story draws the caller reaching storage while a lineage
   * story draws storage reaching its readers. The two are separate matchers
   * rather than one matcher with a guessed orientation: the gate checks that a
   * claim's endpoints agree with the arrow it is attached to, and a check that
   * accepted either order would accept a swapped arrow.
   */
  | "data_lineage"
  | "reachability";

/**
 * What the gate must establish for one rendered Flow arrow (#35, report 6.1).
 *
 * `link_id` is omitted only for a caption-level closed negative claim. A
 * rendered link always expects `present`; an absent link would contradict the
 * arrow rather than support it. Evidence is file-only because this gate rereads
 * the pinned tree independently. Command evidence may corroborate a final link,
 * but cannot replace the source relationship the gate must resolve.
 */
export interface FlowClaim {
  link_id?: string;
  expect: "present" | "absent";
  matcher: FlowMatcher;
  from: SymbolRef;
  to?: SymbolRef;
  evidence: FileEvidence[];
  /**
   * What a `closed_dispatch` claim asserts BEYOND the target existing (#35, PR 5).
   *
   * A dispatch arrow's claim is not "this call reaches that method". It is "the
   * declared type's implementation set is closed at this size, and this branch is
   * the one the tree names" - so the gate has to re-derive the whole set from the
   * blob, not just find the target. Proving `TestCaseGrader.grade` exists says
   * nothing about whether it is the only thing the call can reach.
   */
  dispatch?: {
    /** The declared type the call is written through. */
    base: { path: string; name: string };
    via: "sole_implementation" | "sealed_guard" | "keyed_registry" | "closed_set";
    /** How many subject implementations the producer closed the set at. */
    member_count: number;
    /** How the tree names the branches this one arrow carries. */
    labels: string[];
  };
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
   * Whether this probe's subject-side prerequisite is present at all, beyond the
   * toolchain.
   *
   * The toolchain test answers "does this subject have Java"; a framework
   * adapter also has to answer "does this subject run Spring". Without the
   * second question a Spring route detector on a plain-Java subject would report
   * "ran, found nothing", which reads as an absence of routes rather than an
   * absence of the framework - the exact conflation #5 rejects for toolchains,
   * one level down. Returning a reason keeps the report saying so BY NAME.
   */
  applies?: (ctx: ProbeContext) => { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * Async only because five probes need a WASM parse tree - the three
   * structural discovery probes and the two Flow entry adapters; nothing here
   * waits on the network or on a model, and every probe is deterministic.
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
