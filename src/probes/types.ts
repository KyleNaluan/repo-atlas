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
  /**
   * A CONTAINER TRIGGER: the subject declares that Spring itself starts this
   * method, on a clock (#35, PR 8).
   *
   * It attaches to no arrow, because there is no caller in the tree to draw one
   * from - which is exactly why it needs a claim of its own. What it asserts is
   * everything the entry box says: the method carries `@Scheduled`, the trigger
   * expression is the one printed, the declaring type is container-managed, and
   * the subject writes `@EnableScheduling` somewhere. Drop the last of those and
   * the figure would show an execution nothing starts.
   */
  | "scheduled_trigger"
  /**
   * A MESSAGE SUBSCRIPTION: the subject declares that a listener container hands
   * this method a message or an event (#35, PR 8).
   *
   * It claims the subscription, never the publisher: a topic's producer may not
   * be in this subject at all, and the in-process publisher stitch is its own
   * piece of work. The same split PR 4 made for a Spring route before PR 6 had a
   * caller to draw an arrow from.
   */
  | "message_listener"
  /**
   * A PROCESS LAUNCH: a systemd unit in the tree starts a program the subject
   * declares (#35, PR 8).
   *
   * The one Flow arrow whose source is not source code. It leaves the process in
   * the other direction from a transport arrow - it is what creates the process
   * the rest of the story runs in - and the gate re-derives both halves from the
   * blob: the unit's own `ExecStart`, and the `main` declaration it names.
   */
  | "process_launch"
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
  /**
   * What a `scheduled_trigger` or `message_listener` claim asserts BEYOND the
   * method existing (#35, PR 8).
   *
   * The entry box for a container-triggered Flow prints the trigger, so the
   * trigger is part of what the gate re-resolves: an annotation whose expression
   * moved is a figure whose first box now says something the tree does not.
   */
  trigger?: {
    /** The annotation's simple name, e.g. `Scheduled`, `KafkaListener`. */
    annotation: string;
    /** The attribute the subject wrote the expression under. */
    attribute: string;
    /** The expression exactly as declared, placeholders included. */
    expression: string;
  };
  /**
   * What a `process_launch` claim asserts BEYOND both ends existing (#35, PR 8).
   *
   * The fully-qualified class the unit's `ExecStart` names. The gate re-derives
   * the unit's ExecStart from the blob with its own scanner and refuses a claim
   * whose target that command does not name - proving the `main` exists says
   * nothing about whether this unit is what starts it.
   */
  launch?: {
    /** The fully-qualified class named on the command line. */
    target: string;
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

/**
 * What a probe's OWN reading establishes, and therefore the highest confidence a
 * candidate of its may carry when it hands the gate nothing to re-resolve (#28).
 *
 * #3 makes `verified` a claim the artifact makes about its own evidence, and #28
 * found that claim being assigned by which parsing technique a probe happened to
 * use rather than by what was established - a distinction the design does not
 * intend. Six of the eight v1 probes emitted `verified` while carrying no claims,
 * so nothing downstream ever re-read them. Three of those were text heuristics,
 * and that is not a hypothetical hole: during the #19 build `ci-policy-guards`
 * matched its policy vocabulary against any raw line, so a YAML COMMENT minted a
 * `verified` mechanism asserting a CI step that was not there. The gate could not
 * catch it, because the candidate carried no claim to catch.
 *
 * The line is not "parse tree versus regex". It is whether the probe asserts
 * exactly what the bytes it cites say:
 *
 * - `direct`   - the reading IS the finding. A parse tree, an enumeration of the
 *                tree at the pinned SHA, a captured command's own output, or a
 *                literal token cited at the line it was read from. A reader who
 *                follows the citation sees the asserted fact itself, and there is
 *                nothing further a second read could establish.
 * - `heuristic` - a pattern matched against source text STANDS IN for the finding,
 *                so the assertion goes beyond what the cited bytes literally say.
 *                "This line is a CI step that guards policy" is a judgement read
 *                out of the text, not the text.
 *
 * `heuristic` is the DEFAULT, and deliberately so: a probe earns `direct` by
 * declaring it, rather than every future grep-class probe having to remember to
 * opt out. #28 rejected the alternative of relying on each new text probe being
 * right first time, which is precisely what failed.
 *
 * The ceiling is not lowered, only unearned confidence removed: a `heuristic`
 * probe that can state a checkable claim still reaches `verified`, because the
 * existence gate then confirms it (or demotes it, or overturns it into a
 * divergence). What it may no longer do is mint `verified` with nothing to check.
 */
export type Reading = "direct" | "heuristic";

/**
 * Hold a probe's candidates to what its own reading can support (#28).
 *
 * Applied once, where candidates are collected (`runProbes`), so the rule is a
 * property of the probe contract rather than three local edits that a fourth
 * grep-class probe would not inherit. A candidate that hands the gate something
 * to re-resolve is left alone - `claims` for the generic gate, `flow_claims` for
 * the atomic Flow gate (#35) - because the gate is then the authority on whether
 * it stands, and it demotes an unresolved one to `attested` itself.
 *
 * Only `verified` moves, and only ever downwards. Nothing here promotes: raising
 * a candidate's confidence would make this a second authority over what survives,
 * which #2 and #5 reserve for the gate and the rank stage.
 */
export const clampConfidenceToReading = (probe: Probe, candidates: Candidate[]): Candidate[] => {
  if ((probe.reading ?? "heuristic") === "direct") return candidates;
  return candidates.map((c) => {
    const gated = (c.claims?.length ?? 0) > 0 || (c.flow_claims?.length ?? 0) > 0;
    if (gated || c.node.confidence !== "verified") return c;
    return { ...c, node: { ...c.node, confidence: "attested" as const } };
  });
};

export interface Probe {
  id: string;
  /** One line: the human judgement this probe encodes. */
  finds: string;
  /**
   * What this probe's own reading establishes (#28). Omitted means `heuristic`,
   * which is the conservative answer and the one a new grep-class probe inherits
   * without having to know this field exists. Declaring `direct` is a statement
   * that a reader following the citation sees the asserted fact itself.
   */
  reading?: Reading;
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
   * Async only because seven probes need a WASM parse tree - the three
   * structural discovery probes and the Flow adapters; nothing here
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
