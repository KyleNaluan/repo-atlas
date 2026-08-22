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
  BOUNDS,
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

  if (keep.landmarks.size > BOUNDS.maxLandmarks) {
    return absentCandidate(
      input,
      `landmark_budget_exceeded: the traced story holds ${keep.landmarks.size} landmarks, past the ${BOUNDS.maxLandmarks} a readable figure carries, and compression at a verified seam is a later phase`,
    );
  }

  const keys = orderedKeys(trace, keep.landmarks, keep.edges);
  const ids = stepIds(keys, trace.landmarks);
  const terminalsInGraph = keys.filter((key) => trace.terminals.has(key));

  const steps: FlowStep[] = keys.map((key, i) => {
    const landmark = trace.landmarks.get(key)!;
    const kind =
      i === 0
        ? input.entryKind
        : trace.terminals.has(key) && landmark.dataAccess === undefined
          ? ("response" as const)
          : undefined;
    return {
      id: ids.get(key)!,
      node: i === 0 ? input.entryTitle : landmark.type.name,
      detail: i === 0 ? `${landmark.type.name}.${signature(landmark.method)}` : signature(landmark.method),
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
  for (const edge of keep.edges) {
    const from = ids.get(edge.from)!;
    const to = ids.get(edge.to)!;
    const base = `${from}-to-${to}`;
    let id = base;
    for (let n = 2; usedLinkIds.has(id); n += 1) id = `${base}-${n}`;
    usedLinkIds.add(id);
    const evidence = [fileEvidence(input.sha, edge.path, edge.line_start, edge.line_end)];
    const relation =
      edge.relation === "call" && edge.inReturn && trace.terminals.has(edge.to)
        ? ("return" as const)
        : edge.relation;
    links.push({
      id,
      from,
      to,
      relation,
      ...(relation === "return" ? { kind: "response" as const } : {}),
      label: edge.label,
      evidence,
    });
    claims.push({
      link_id: id,
      expect: "present",
      matcher: relation === "read" || relation === "write" ? "data_access" : "direct_call",
      from: symbolRef(trace.landmarks.get(edge.from)!),
      to: symbolRef(trace.landmarks.get(edge.to)!),
      evidence,
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
