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

  const links: FlowLink[] = [];
  const claims: FlowClaim[] = [...(input.entryClaims ?? [])];
  const usedLinkIds = new Set<string>();
  const drawn = new Set<string>();
  for (const edge of crossing) {
    const from = ids.get(component.get(edge.from)!)!;
    const to = ids.get(component.get(edge.to)!)!;
    // Two methods of one component calling the same target the same way is one
    // arrow, not two drawn on top of each other. Differently labelled crossings
    // stay separate arrows with their own evidence, which is what PR 1's
    // edge-level contract exists for.
    const shape = `${from}|${to}|${edge.relation}|${edge.label}`;
    if (drawn.has(shape)) continue;
    drawn.add(shape);
    const base = `${from}-to-${to}`;
    let id = base;
    for (let n = 2; usedLinkIds.has(id); n += 1) id = `${base}-${n}`;
    usedLinkIds.add(id);
    // A dispatch arrow cites the guard as well as the call site: the claim it
    // makes is not "this call reaches that method" but "this call reaches one of
    // a set the tree closes, and this branch is the one the guard names". The
    // guard body is where that second half is written.
    const evidence = [
      fileEvidence(input.sha, edge.path, edge.line_start, edge.line_end),
      ...(edge.dispatch?.guards ?? []).map((guard) =>
        fileEvidence(input.sha, guard.path, guard.line_start, guard.line_end),
      ),
    ];
    const relation =
      edge.relation === "call" && edge.inReturn && trace.terminals.has(edge.to)
        ? ("return" as const)
        : edge.relation;
    links.push({
      id,
      from,
      to,
      relation,
      ...(relation === "return"
        ? { kind: "response" as const }
        : relation === "side_effect"
          ? { kind: "aside" as const }
          : {}),
      label: edge.label,
      evidence,
    });
    const to_ = symbolRef(trace.landmarks.get(edge.to)!);

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
      to: edge.receiver === undefined ? to_ : { ...to_, receiver: edge.receiver.qualified },
      evidence,
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

  const entryLandmark = trace.landmarks.get(trace.entry)!;
  const node: FlowNode = {
    type: "flow",
    id: nodeId(input, entryLandmark.type, entryLandmark.method),
    title: input.title,
    caption: `Traced from ${entryLandmark.type.name}.${entryLandmark.method.name} to ${terminalsInGraph
      .map((key) => {
        const landmark = trace.landmarks.get(key)!;
        return `${landmark.type.name}.${landmark.method.name}`;
      })
      .join(", ")}: ${steps.length} landmarks and ${links.length} independently resolved links.`,
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
    steps,
    links,
  };
  return { probe_id: input.probeId, node, flow_claims: claims };
};
