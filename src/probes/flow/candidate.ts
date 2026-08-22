/**
 * A finished trace, turned into what the gate is allowed to check.
 *
 * The producer emits CANDIDATES (#5), so everything here is a proposal: the
 * boxes it drew, the arrows it drew, and one atomic claim per arrow naming the
 * symbols the gate must independently re-resolve at the pinned SHA. It assigns
 * no interview value - the scorer owns that - and it never decides what renders.
 *
 * The other half of its job is the honest one: a trace that could not be
 * completed becomes an `absent` candidate carrying the reason, not a shorter
 * diagram. #6 forbids communicating absence by silence, so the reason travels
 * with the candidate into `record.absent_cuts` rather than being dropped at the
 * gate.
 */
import { shortHash, slug } from "../id.js";
import type { Candidate, FlowClaim, SymbolRef } from "../types.js";
import type { FileEvidence, FlowLink, FlowNode, FlowStep } from "../../schema/types.js";
import {
  retained,
  type GapKind,
  type TraceEdge,
  type TraceGap,
  type TraceLandmark,
  type TraceResult,
} from "./trace.js";
import type { MethodSymbol, TypeSymbol } from "./symbols.js";
import type { HttpVerb } from "./entries.js";

/**
 * One module that CALLS an HTTP entry, drawn as a transport arrow into it.
 *
 * PR 4 claimed the Spring route at caption level and said why: "a transport link
 * needs a real caller". This is that caller. The box is the calling module, at
 * the same one-box-per-component granularity every other box uses, and the arrow
 * is a `transport` link whose evidence names BOTH ends - the client call site and
 * the handler declaration - because a transport claim is a claim about an
 * agreement between two files, not about either one alone.
 */
export interface TransportCaller {
  /** The rendered box title: the module the call is written in. */
  node: string;
  /** Flow-local step id; minted from the path so two modules cannot collide. */
  id: string;
  path: string;
  /** The named actions in this module that call the route, in source order. */
  actions: string[];
  /** The box's evidence: the first action's declaration through its call site. */
  box: { line_start: number; line_end: number };
  /** Every call site, cited by the transport link. */
  calls: { line_start: number; line_end: number }[];
  /**
   * The declaration that closes the callee as an HTTP client, when it is not
   * `fetch` itself - cited for the same reason a dispatch arrow cites its guard:
   * without it the arrow's claim cannot be re-derived from the blob.
   */
  wrapper?: { path: string; line_start: number; line_end: number };
  protocol: { method: HttpVerb; path: string };
}

export interface CandidateInput {
  probeId: string;
  /** Id prefix, so two adapters cannot mint the same element id. */
  prefix: string;
  sha: string;
  title: string;
  /** The entry box's rendered title; its detail is the entry method signature. */
  entryTitle: string;
  /**
   * `request` on an HTTP entry, absent otherwise. Rank classifies Flow archetypes
   * from exactly this topology (#39), and a CLI entry may not claim the
   * request/response slot that decision reserved for a request signal.
   */
  entryKind?: "request";
  /** Claims about the entry itself, e.g. the route a Spring handler serves. */
  entryClaims?: FlowClaim[];
  /**
   * Verified client callers of the entry, prepended as transport arrows.
   *
   * They arrive already matched on verb AND normalized path (never on path text
   * alone, per report 5.2), and a caller the adapter could not pin exactly never
   * reaches here: it is a named `absent` cut in its own adapter instead.
   */
  callers?: TransportCaller[];
  trace: TraceResult;
}

const signature = (method: MethodSymbol): string =>
  `${method.name}(${method.params.map((p) => p.type).join(", ")})`;

const symbolRef = (landmark: TraceLandmark): SymbolRef => ({
  path: landmark.type.path,
  name: landmark.method.name,
  owner: landmark.type.qualified,
  arity: landmark.method.params.length,
});

const fileEvidence = (
  sha: string,
  path: string,
  line_start: number,
  line_end: number,
): FileEvidence => ({ kind: "file", path, line_start, line_end, sha });

const nodeId = (input: CandidateInput, entry: TypeSymbol, method: MethodSymbol): string =>
  `${input.prefix}-${slug(entry.name)}-${slug(method.name)}-${shortHash(
    `${entry.path}#${entry.qualified}.${method.name}/${method.params.length}`,
  )}`;

/**
 * A Flow the producer could not establish.
 *
 * Every reason starts with a kind token, so the record can count what failed
 * without string-matching a sentence - the same reason #9 gives a deletion a
 * `kind` beside its prose.
 *
 * It carries the entry it started from as evidence - that much IS established -
 * and no steps at all. #7's absent-cut disclosure reports the type and the
 * reason and withholds the claim, and an unproven chain drawn into `steps` would
 * be exactly the claim that ruling withholds.
 */
export const absentCandidate = (input: CandidateInput, reason: string): Candidate => {
  const landmark = input.trace.landmarks.get(input.trace.entry)!;
  const node: FlowNode = {
    type: "flow",
    id: nodeId(input, landmark.type, landmark.method),
    title: input.title,
    evidence: [
      fileEvidence(
        input.sha,
        landmark.type.path,
        landmark.method.line_start,
        landmark.method.line_end,
      ),
    ],
    confidence: "absent",
    interview_value: 0,
    probe_id: input.probeId,
    steps: [],
  };
  return { probe_id: input.probeId, node, absent_reason: reason };
};

const stepIds = (keys: string[], landmarks: Map<string, TraceLandmark>): Map<string, string> => {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const key of keys) {
    const landmark = landmarks.get(key)!;
    const base = slug(`${landmark.type.name}-${landmark.method.name}`);
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    out.set(key, id);
  }
  return out;
};

/**
 * Entry first, then depth-first in call order: the order the story happens in.
 *
 * Breadth-first would list the response beside the service it has not been
 * produced by yet. The reader follows one path to its end before the next
 * branch, and the step order is what a reader reads.
 */
const orderedKeys = (trace: TraceResult, keep: Set<string>, edges: TraceEdge[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const walkFrom = (key: string): void => {
    if (seen.has(key) || !keep.has(key)) return;
    seen.add(key);
    out.push(key);
    for (const edge of edges) if (edge.from === key) walkFrom(edge.to);
  };
  walkFrom(trace.entry);
  return out;
};

/**
 * Which gap leads an absent Flow's reason.
 *
 * Not traversal order: a reader uses the headline to decide whether a later
 * phase closes this story, so it must name the seam that actually blocks it. An
 * `unresolved_dispatch` through an interface is closed in a planned later phase,
 * while an untypeable receiver is the walk giving up on the calling file, so the
 * dispatch is the load-bearing cut even when the walk hit the receiver first.
 * Kinds after the first two share one declared order; ties within a kind break
 * by traversal order, which keeps the choice deterministic.
 */
const SEAM_PRIORITY: readonly GapKind[] = [
  "unresolved_dispatch",
  "unresolved_receiver_type",
  "ambiguous_overload",
  "unprovable_data_access",
  "unresolved_target",
  "trace_bound_before_terminal",
];

/**
 * Which component of the subject each traced method belongs to.
 *
 * This is the compression #35's readability criterion asks for, and the rule is
 * the subject's own wiring rather than a heuristic: a **Spring-managed bean** is
 * a part the application declares itself to have, a **durable-storage boundary**
 * is a part of the story by definition, and a **terminal** is where a path ends.
 * Everything else - a parser, a process helper, a value builder - is an
 * implementation detail of whichever component called it, and belongs inside that
 * component's box rather than beside it.
 *
 * The reference artifact's own boxes are exactly this set on the reference
 * subject, which is what makes it a granularity rather than a guess: it draws
 * `FileExerciseCatalog` and not the three parsers underneath it, and it draws
 * `GraderRegistry` and `TestCaseGrader` separately although they share a package.
 *
 * A detail reached from two components belongs to the first that reached it, in
 * story order, so the mapping is deterministic.
 */
const componentOf = (
  trace: TraceResult,
  keep: { landmarks: Set<string>; edges: TraceEdge[] },
): Map<string, string> => {
  const typeKey = (key: string): string => {
    const landmark = trace.landmarks.get(key)!;
    return `${landmark.type.path}#${landmark.type.qualified}`;
  };
  // A method is a component of its own when the subject says so: it is the entry,
  // its type is a bean, it is a durable-storage boundary, it is where a path ends,
  // or the caller reached it through a dependency it HOLDS rather than through a
  // static helper or a `new`.
  const standsAlone = (key: string): boolean => {
    const landmark = trace.landmarks.get(key)!;
    return (
      key === trace.entry ||
      landmark.type.bean ||
      landmark.dataAccess !== undefined ||
      trace.terminals.has(key) ||
      keep.edges.some((edge) => edge.to === key && edge.heldReceiver)
    );
  };

  // Story order first, so every choice below is deterministic.
  const order: string[] = [trace.entry];
  const reachedFrom = new Map<string, string>();
  for (let i = 0; i < order.length; i += 1) {
    for (const edge of keep.edges) {
      if (edge.from !== order[i] || reachedFrom.has(edge.to) || edge.to === trace.entry) continue;
      reachedFrom.set(edge.to, order[i]!);
      order.push(edge.to);
    }
  }
  for (const key of keep.landmarks) if (!order.includes(key)) order.push(key);

  // One box per TYPE, never per method: if any method of a type stands alone then
  // every method of that type reached here belongs in its box. Splitting a type
  // across two boxes would draw an arrow whose target box never names it.
  const ownsBox = new Set<string>();
  for (const key of order) if (standsAlone(key)) ownsBox.add(typeKey(key));

  const component = new Map<string, string>();
  const headOfType = new Map<string, string>();
  for (const key of order) {
    if (ownsBox.has(typeKey(key))) {
      const head = headOfType.get(typeKey(key));
      if (head === undefined) headOfType.set(typeKey(key), key);
      component.set(key, head ?? key);
      continue;
    }
    // An implementation detail belongs to the component that reached it; with no
    // caller it is its own box, because a silently dropped landmark would be the
    // failure this whole producer exists to avoid.
    const caller = reachedFrom.get(key);
    component.set(key, caller === undefined ? key : component.get(caller) ?? key);
  }
  return component;
};

/**
 * The figure's one sentence: where the story starts, where it ends, and its size.
 *
 * The endings are counted rather than listed in full. A fan-out reaches a dozen
 * terminals, and a caption that names every one is a paragraph the reader skips -
 * while the count is the fact that matters and each ending is a box in the figure
 * beside it. Nothing is hidden by counting something the figure already draws.
 */
const caption = (
  from: string,
  terminals: string[],
  landmarks: number,
  links: number,
): string => {
  const shown = terminals.slice(0, 3).join(", ");
  const rest = terminals.length - 3;
  const ends =
    terminals.length === 0
      ? "its terminals"
      : rest > 0
        ? `${shown} and ${rest} further ${rest === 1 ? "terminal" : "terminals"}`
        : shown;
  return `Traced from ${from} to ${ends}: ${landmarks} landmarks and ${links} independently resolved links.`;
};

const headlineGap = (gaps: TraceGap[]): TraceGap | undefined => {
  let best: TraceGap | undefined;
  for (const gap of gaps) {
    if (best === undefined || SEAM_PRIORITY.indexOf(gap.kind) < SEAM_PRIORITY.indexOf(best.kind)) {
      best = gap;
    }
  }
  return best;
};

/**
 * The trace as a candidate: a complete verified proposal, or an absent cut.
 *
 * Every refusal below is the same rule stated for a different failure - the
 * artifact may only assert what was independently established - and each names
 * itself, so a subject with an untraceable dispatch and a subject with no route
 * at all never read the same.
 */
export const flowCandidate = (input: CandidateInput): Candidate => {
  const { trace } = input;
  const keep = retained(trace);

  // A gap anywhere the entry reaches is the whole story failing, not one branch.
  // It is checked FIRST because a bound reached before a terminal is why there
  // is no terminal, and reporting the symptom would hide the cause.
  //
  // The headline gap is chosen by a fixed seam priority, not by traversal order:
  // the record's headline reason is what a reader uses to decide whether a later
  // phase closes this story, so it must name the seam that actually blocks it -
  // the interface dispatch a future phase resolves - rather than whichever call
  // the walk happened to reach first. Ties break by traversal order, so the
  // choice stays deterministic. The rest are reported by kind and count;
  // dropping them would make the record say one call could not be resolved where
  // four could not.
  const blocking = headlineGap(trace.gaps);
  if (blocking) {
    const others = trace.gaps.filter((g) => g !== blocking);
    const byKind = [...new Set(others.map((g) => g.kind))]
      .map((kind) => `${kind} x${others.filter((g) => g.kind === kind).length}`)
      .join(", ");
    return absentCandidate(
      input,
      `${blocking.kind}: ${blocking.detail}` +
        (others.length === 0
          ? ""
          : ` (plus ${others.length} further unresolved call${others.length === 1 ? "" : "s"}: ${byKind})`),
    );
  }

  if (keep.landmarks.size === 0) {
    const why =
      trace.cyclesCut > 0
        ? `cycle_before_terminal: the traced calls return into themselves (${trace.cyclesCut} cycle${trace.cyclesCut === 1 ? "" : "s"} cut) and reach no terminal`
        : "no_terminal_reached: no traced path reaches a response, durable read or durable write";
    return absentCandidate(input, why);
  }

  const component = componentOf(trace, keep);
  const crossing = keep.edges.filter((edge) => component.get(edge.from) !== component.get(edge.to));
  const keys = orderedKeys(trace, keep.landmarks, keep.edges).filter((key) => component.get(key) === key);

  const storyOrder = orderedKeys(trace, keep.landmarks, keep.edges);
  const ids = stepIds(keys, trace.landmarks);
  const terminalsInGraph = keys.filter((key) =>
    [...keep.landmarks].some((inner) => component.get(inner) === key && trace.terminals.has(inner)),
  );

  const steps: FlowStep[] = keys.map((key, i) => {
    const landmark = trace.landmarks.get(key)!;
    // The methods of this component the story passes through, in story order. The
    // box names the component; the detail names what it does here, which is the
    // difference between a package tour and a walkthrough.
    const inside = storyOrder.filter((inner) => component.get(inner) === key);
    const external = inside.some((inner) => trace.landmarks.get(inner)!.externalEffect !== undefined);
    const kind =
      i === 0
        ? input.entryKind
        : external
          ? // A component that starts a process or writes the filesystem is beside
            // the story, not inside it: the reference artifact draws exactly this
            // distinction for the best-effort commit next to the graded path.
            ("aside" as const)
          : terminalsInGraph.includes(key) && landmark.dataAccess === undefined && !crossing.some((e) => component.get(e.from) === key)
            ? ("response" as const)
            : undefined;
    const transactional = inside.some((inner) => trace.landmarks.get(inner)!.transactional);
    // Every method an arrow points AT has to be named in the box it points at.
    // Compression folds a helper into the component that uses it, and an arrow
    // that crossed into the helper would otherwise land on a box whose text never
    // mentions it - a figure whose arrow and label disagree, and a claim the gate
    // rightly refuses to match against the rendered endpoint.
    const endpoints = inside.filter(
      (inner) =>
        inner === key ||
        crossing.some((edge) => edge.to === inner || edge.from === inner),
    );
    // Every endpoint is named, however many there are; the cap applies only to the
    // extra internal methods listed for context.
    const shown = [...new Set([...endpoints, ...inside.slice(0, 3)])];
    const detail = [
      // The entry box leads with the entry signature; every other box leads with
      // the method the story enters it by. Either way the rest of the list is the
      // endpoints, so an arrow leaving a helper this component absorbed is still
      // findable in the box it leaves from.
      i === 0
        ? `${landmark.type.name}.${signature(landmark.method)}`
        : signature(trace.landmarks.get(shown[0] ?? key)!.method),
      ...shown.slice(1).map((inner) => {
        const reached = trace.landmarks.get(inner)!;
        return reached.type.qualified === landmark.type.qualified
          ? signature(reached.method)
          : `${reached.type.name}.${signature(reached.method)}`;
      }),
      ...(shown.length < inside.length ? [`+${inside.length - shown.length} more`] : []),
      ...(transactional ? ["@Transactional"] : []),
      ...(external ? [`leaves the process: ${inside.map((inner) => trace.landmarks.get(inner)!.externalEffect).find(Boolean)}`] : []),
    ].join("\\l");
    return {
      id: ids.get(key)!,
      node: i === 0 ? input.entryTitle : landmark.type.name,
      detail,
      ...(kind === undefined ? {} : { kind }),
      evidence: fileEvidence(
        input.sha,
        landmark.type.path,
        landmark.method.line_start,
        landmark.method.line_end,
      ),
    };
  });

  const entryLandmark = trace.landmarks.get(trace.entry)!;
  const links: FlowLink[] = [];
  const claims: FlowClaim[] = [...(input.entryClaims ?? [])];
  const relationOf = (edge: TraceEdge): FlowLink["relation"] =>
    edge.relation === "call" && edge.inReturn && trace.terminals.has(edge.to)
      ? "return"
      : edge.relation;

  // ONE ARROW PER RELATIONSHIP, not one per call (#35, PR 6, report 5.4).
  //
  // PR 5 drew a separate arrow for every differently-labelled crossing, and on
  // the reference subject that put ten arrows between one pair of boxes, each
  // labelled with a different static helper. That is not ten relationships: it is
  // one component calling into another ten times, and drawing it ten times is the
  // readability failure the criterion names - while hiding any of those call
  // sites would be the worse failure it names first.
  //
  // So the grouping key is the RELATIONSHIP - the two components and the typed
  // relation - and the arrow carries every call site as its own evidence and its
  // own atomic claim. A `dispatch` arrow is the deliberate exception: its label is
  // a BRANCH PREDICATE the tree names, so two dispatch branches are two different
  // executions and stay two arrows (PR 5 decision 1). Every method any of these
  // calls touches is still named in the box it touches, so nothing is lost from
  // the figure - only repeated from it.
  const groups = new Map<string, TraceEdge[]>();
  for (const edge of crossing) {
    const from = ids.get(component.get(edge.from)!)!;
    const to = ids.get(component.get(edge.to)!)!;
    const relation = relationOf(edge);
    const key =
      relation === "dispatch"
        ? `${from}|${to}|${relation}|${edge.label}`
        : `${from}|${to}|${relation}`;
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }

  const usedLinkIds = new Set<string>();
  for (const [key, edges] of groups) {
    const [from, to] = key.split("|") as [string, string];
    const relation = relationOf(edges[0]!);
    const base = `${from}-to-${to}`;
    let id = base;
    for (let n = 2; usedLinkIds.has(id); n += 1) id = `${base}-${n}`;
    usedLinkIds.add(id);

    const evidence: FileEvidence[] = [];
    const cited = new Set<string>();
    const add = (e: FileEvidence): void => {
      const key_ = `${e.path}:${e.line_start}-${e.line_end}`;
      if (cited.has(key_)) return;
      cited.add(key_);
      evidence.push(e);
    };
    for (const edge of edges) {
      // A dispatch arrow cites the guard as well as the call site: the claim it
      // makes is not "this call reaches that method" but "this call reaches one of
      // a set the tree closes, and this branch is the one the guard names". The
      // guard body is where that second half is written.
      add(fileEvidence(input.sha, edge.path, edge.line_start, edge.line_end));
      for (const guard of edge.dispatch?.guards ?? []) {
        add(fileEvidence(input.sha, guard.path, guard.line_start, guard.line_end));
      }
    }

    // The label names what the arrow carries, ONE NAME PER LINE. In `rankdir=LR`
    // a comma-joined list of calls is laid out as horizontal width, and on the
    // reference subject that alone made the figure three times wider than the
    // boxes needed - so the same names stacked cost nothing but the height the
    // fan-out already spends. Three names is the most an edge label reads at;
    // the rest are countable rather than hidden, and every one of them is named
    // in the box the arrow lands on.
    const names = [...new Set(edges.map((edge) => edge.label))];
    const label = [
      ...names.slice(0, 3),
      ...(names.length > 3 ? [`+${names.length - 3} more`] : []),
    ].join("\\l");

    links.push({
      id,
      from,
      to,
      relation,
      ...(relation === "return"
        ? { kind: "response" as const }
        : relation === "side_effect"
          ? { kind: "aside" as const }
          : relation === "transport"
            ? { kind: "request" as const }
            : {}),
      label,
      evidence,
    });

    // One claim per CALL SITE, all of them on this one arrow. The gate resolves
    // every one and requires their evidence to be exactly the arrow's, so merging
    // arrows never merges away a claim: an arrow drawn over ten call sites is an
    // arrow ten independent re-resolutions have to agree with.
    for (const edge of edges) {
      const target = symbolRef(trace.landmarks.get(edge.to)!);
      claims.push({
        link_id: id,
        expect: "present",
        matcher:
          relation === "read" || relation === "write"
            ? "data_access"
            : relation === "dispatch"
              ? "closed_dispatch"
              : "direct_call",
        from: symbolRef(trace.landmarks.get(edge.from)!),
        to: edge.receiver === undefined ? target : { ...target, receiver: edge.receiver.qualified },
        evidence: [
          fileEvidence(input.sha, edge.path, edge.line_start, edge.line_end),
          ...(edge.dispatch?.guards ?? []).map((guard) =>
            fileEvidence(input.sha, guard.path, guard.line_start, guard.line_end),
          ),
        ],
        ...(edge.dispatch === undefined
          ? {}
          : {
              dispatch: {
                base: { path: edge.dispatch.base.path, name: edge.dispatch.base.qualified },
                via: edge.dispatch.via,
                member_count: edge.dispatch.memberCount,
                labels: edge.dispatch.labels,
              },
            }),
      });
    }
  }

  // The transport seam. PR 4 could only claim the route in a caption, and said
  // why: a transport link needs a real caller. With one, the story starts where a
  // person starts it, and the arrow across the process boundary is drawn rather
  // than described. Its evidence names BOTH ends plus the declaration that closes
  // the callee as an HTTP client - the same reason a dispatch arrow cites its
  // guard - because that is the whole of what the gate must re-derive from the
  // blob to agree the two files share one contract.
  const clientSteps: FlowStep[] = [];
  const entryStepId = ids.get(trace.entry)!;
  for (const caller of input.callers ?? []) {
    const evidence = [
      ...caller.calls.map((call) =>
        fileEvidence(input.sha, caller.path, call.line_start, call.line_end),
      ),
      ...(caller.wrapper === undefined
        ? []
        : [
            fileEvidence(
              input.sha,
              caller.wrapper.path,
              caller.wrapper.line_start,
              caller.wrapper.line_end,
            ),
          ]),
      fileEvidence(
        input.sha,
        entryLandmark.type.path,
        entryLandmark.method.line_start,
        entryLandmark.method.line_end,
      ),
    ];
    const route = `${caller.protocol.method} ${caller.protocol.path}`;
    clientSteps.push({
      id: caller.id,
      node: caller.node,
      // The box names the actions; the ARROW names the route. Printing the route
      // in both widens every client box by the length of a URL to say a second
      // time what the edge label already says.
      detail: caller.actions.map((action) => `${action}()`).join("\\l"),
      kind: "request",
      evidence: fileEvidence(input.sha, caller.path, caller.box.line_start, caller.box.line_end),
    });
    const id = `${caller.id}-to-${entryStepId}`;
    links.push({ id, from: caller.id, to: entryStepId, relation: "transport", kind: "request", label: route, evidence });
    claims.push({
      link_id: id,
      expect: "present",
      matcher: "spring_route",
      from: { path: caller.path, name: caller.actions[0]!, protocol: caller.protocol },
      to: { ...symbolRef(entryLandmark), protocol: caller.protocol },
      evidence,
    });
  }

  const node: FlowNode = {
    type: "flow",
    id: nodeId(input, entryLandmark.type, entryLandmark.method),
    title: input.title,
    caption: caption(
      clientSteps.length === 0
        ? `${entryLandmark.type.name}.${entryLandmark.method.name}`
        : `${clientSteps.map((step) => step.node).join(" and ")} across ${input.entryTitle}`,
      terminalsInGraph.map((key) => {
        const landmark = trace.landmarks.get(key)!;
        return `${landmark.type.name}.${landmark.method.name}`;
      }),
      steps.length + clientSteps.length,
      links.length,
    ),
    orientation: "LR",
    evidence: [
      fileEvidence(
        input.sha,
        entryLandmark.type.path,
        entryLandmark.method.line_start,
        entryLandmark.method.line_end,
      ),
    ],
    confidence: "verified",
    interview_value: 0,
    probe_id: input.probeId,
    steps: [...clientSteps, ...steps],
    links,
  };
  return { probe_id: input.probeId, node, flow_claims: claims };
};
