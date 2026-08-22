/**
 * The shared-state fan-out: one durable record and the derivations over it
 * (#35, PR 7, accepted design section 5.5).
 *
 * This is a SEPARATE TRACE MODE, not a request Flow with a different entry. A
 * request story starts where the outside world reaches the subject and runs
 * forward through one execution; a lineage story starts at a record that has
 * already been written and asks what independently derives from it. Nothing
 * executes the hub, so the arrows here run the way the DATA travels - from the
 * record to its readers - which is the opposite of the calls that establish
 * them, and that is why the claim they carry declares its own orientation
 * (`data_lineage`) rather than leaving a `read` arrow's direction to be guessed.
 *
 * The narrow structural condition is the one the design report measured (section
 * 3.4): "three classes use this repository" is not the insight and would draw a
 * diagram for every popular type. A branch has to be an application service the
 * container manages, holding the record, reading it without writing it, and
 * reaching a named pure derivation or terminal read model - and three of them
 * have to exist before there is a story at all.
 */
import { maskedJava, mentions } from "./reachability.js";
import { literalPredicates, readsDurably, writesDurably } from "./sql.js";
import type { JavaIndex, MethodSymbol, TypeSymbol } from "./symbols.js";
import {
  isRepositoryType,
  methodKey,
  traceFrom,
  type TraceEdge,
  type TraceGap,
  type TraceLandmark,
  type TraceResult,
} from "./trace.js";
import type { ProbeContext } from "../types.js";

const sqlText = (method: MethodSymbol): string =>
  `${method.body?.text ?? ""}\n${method.annotations.map((a) => a.args).join("\n")}`;

export interface DurableRead {
  method: MethodSymbol;
  /** The literal comparisons this read's own SQL writes, in source order. */
  predicates: string[];
}

/**
 * The SQL a method carries: its body, plus any annotation argument, so a Spring
 * Data `@Query` is read the same way a `JdbcClient` string is.
 */
export const durableReads = (type: TypeSymbol): DurableRead[] =>
  type.methods
    .filter((method) => readsDurably(sqlText(method)))
    .map((method) => ({ method, predicates: literalPredicates(sqlText(method)) }));

export const durableWrites = (type: TypeSymbol): MethodSymbol[] =>
  type.methods.filter((method) => writesDurably(sqlText(method)));

/**
 * The record a lineage story can be told about: a storage type this subject both
 * writes and reads with its own SQL.
 *
 * Selection is not assertion. Which record is worth a diagram is the piece of
 * human judgement this probe encodes (#5), and it is deliberately NOT rendered
 * as a claim: nothing in the figure says "this is the record the submission flow
 * writes", so nothing has to prove it. What the figure does say - each arrow -
 * carries its own atomic claim, as everywhere else.
 */
export const lineageHubs = (index: JavaIndex): TypeSymbol[] =>
  index.types.filter(
    (type) => isRepositoryType(type) && durableWrites(type).length > 0 && durableReads(type).length > 0,
  );

/** Why a consumer of the hub is not a branch of its story. */
export type BranchRefusal =
  | "writes_the_record"
  | "not_a_managed_service"
  | "no_derivation_reached"
  | "unresolved_call";

export interface LineageBranch {
  consumer: TypeSymbol;
  /** The consumer's methods that read the hub directly, in source order. */
  entries: MethodSymbol[];
  landmarks: Map<string, TraceLandmark>;
  edges: TraceEdge[];
  terminals: Set<string>;
  gaps: TraceGap[];
  /** The resolved read edges into the hub: one per call site. */
  reads: TraceEdge[];
  /** Terminal landmarks that are a named pure derivation or terminal read model. */
  derivations: string[];
}

export interface RefusedBranch {
  consumer: TypeSymbol;
  why: BranchRefusal;
  detail: string;
}

/**
 * A PURE type: one the container does not manage and that is not a storage
 * boundary, so the subject's own wiring says it holds a rule rather than a
 * dependency. `LearnedCriterion`, `ChallengeQuality` and `ConfusionPairs` are
 * this; every service and repository around them is not.
 */
const isPure = (landmark: TraceLandmark, hub: TypeSymbol): boolean =>
  !landmark.type.bean &&
  !isRepositoryType(landmark.type) &&
  landmark.type.qualified !== hub.qualified &&
  landmark.dataAccess === undefined;

/**
 * A branch's NAMED PURE DERIVATION: a pure type THE CONSUMER ITSELF hands the
 * record's data to (report 5.5 point 3).
 *
 * "The consumer itself" is what makes it this branch's derivation rather than
 * somebody else's plumbing, and it was arrived at by measurement. A rule that
 * took any pure type the branch reaches collected `ContentParser` for three
 * different branches at once - every service loads the catalog, and the catalog
 * parses content - which is a shared dependency, not a derivation over the
 * record, and it made the independence claim below quantify over the catalog's
 * internals instead of over the derivations the figure draws.
 *
 * A branch with none of these is not refused for being hard to resolve: it
 * reached no rule at all, which is the structural condition 5.5 sets before
 * there is a branch to draw.
 */
const derivationsIn = (
  branch: { landmarks: Map<string, TraceLandmark>; edges: TraceEdge[] },
  consumer: TypeSymbol,
  hub: TypeSymbol,
): string[] =>
  [...branch.landmarks.keys()].filter(
    (key) =>
      isPure(branch.landmarks.get(key)!, hub) &&
      branch.edges.some((edge) => {
        const from = branch.landmarks.get(edge.from)!;
        return (
          edge.to === key &&
          from.type.qualified === consumer.qualified &&
          from.type.path === consumer.path
        );
      }),
  );

/**
 * Every consumer of the hub, sorted into branches and named refusals.
 *
 * A consumer is refused only on what the subject DECLARES - it writes the
 * record, the container does not manage it, its execution reaches no derivation -
 * or on a call this producer could not resolve, which is reported as itself and
 * never quietly skipped. Refusing on resolution difficulty without saying so
 * would be the "path that stops when resolution becomes difficult" the design
 * forbids, so every refusal travels with the hub's own absent reason when the
 * hub then has too few branches to tell a story.
 */
export const lineageBranches = (
  index: JavaIndex,
  hub: TypeSymbol,
): { branches: LineageBranch[]; refused: RefusedBranch[] } => {
  const reads = durableReads(hub);
  const readKeys = new Set(reads.map((read) => methodKey(hub, read.method)));
  const writeNames = new Set(durableWrites(hub).map((method) => method.name));
  const boundary = (type: TypeSymbol, method: MethodSymbol): "read" | "write" | undefined =>
    type.qualified !== hub.qualified || type.path !== hub.path
      ? undefined
      : readKeys.has(methodKey(type, method))
        ? "read"
        : writeNames.has(method.name)
          ? "write"
          : undefined;

  const branches: LineageBranch[] = [];
  const refused: RefusedBranch[] = [];

  for (const consumer of index.types) {
    if (consumer.qualified === hub.qualified && consumer.path === hub.path) continue;
    const fields = [...consumer.fields].filter(([, declared]) => declared === hub.name);
    if (fields.length === 0) continue;
    const holders = fields.map(([name]) => name);
    const touches = (method: MethodSymbol, names: Iterable<string>): boolean => {
      const text = method.body?.text ?? "";
      return [...names].some((name) =>
        holders.some((holder) => new RegExp(`\\b${holder}\\s*\\.\\s*${name}\\s*\\(`).test(text)),
      );
    };
    if (consumer.methods.some((method) => touches(method, writeNames))) {
      refused.push({
        consumer,
        why: "writes_the_record",
        detail: `${consumer.name} writes ${hub.name} as well as reading it, so it is the record's author rather than a derivation over it`,
      });
      continue;
    }
    if (!consumer.bean) {
      refused.push({
        consumer,
        why: "not_a_managed_service",
        detail: `${consumer.name} holds ${hub.name} but carries no Spring stereotype, so the subject's own wiring does not declare it a service`,
      });
      continue;
    }

    const entries = consumer.methods.filter((method) =>
      touches(method, reads.map((read) => read.method.name)),
    );
    if (entries.length === 0) continue;

    const landmarks = new Map<string, TraceLandmark>();
    const edges: TraceEdge[] = [];
    const terminals = new Set<string>();
    const gaps: TraceGap[] = [];
    for (const entry of entries) {
      const trace = traceFrom(index, consumer, entry, { boundary });
      for (const [key, landmark] of trace.landmarks) if (!landmarks.has(key)) landmarks.set(key, landmark);
      edges.push(...trace.edges);
      for (const key of trace.terminals) terminals.add(key);
      gaps.push(...trace.gaps);
    }
    if (gaps.length > 0) {
      const first = gaps[0]!;
      refused.push({
        consumer,
        why: "unresolved_call",
        detail: `${first.kind}: ${first.detail}`,
      });
      continue;
    }

    const hubReads = edges.filter((edge) => readKeys.has(edge.to) && edge.relation === "read");
    if (hubReads.length === 0) continue;
    // A LINEAGE branch ends where the subject stops deriving, so every leaf is an
    // ending. The request tracer's stricter rule - a leaf counts only when a
    // `return` hands it back - is right for an execution that has to reach a
    // response, and wrong here: nothing returns anywhere in a data-lineage story,
    // and applying it would prune the criterion and its inputs off the figure and
    // leave a branch with no visible answer.
    const outgoing = new Set(edges.map((edge) => edge.from));
    for (const key of landmarks.keys()) if (!outgoing.has(key)) terminals.add(key);
    const derivations = derivationsIn({ landmarks, edges }, consumer, hub).filter(
      (key) => !readKeys.has(key),
    );
    if (derivations.length === 0) {
      refused.push({
        consumer,
        why: "no_derivation_reached",
        detail: `${consumer.name} reads ${hub.name} but its execution ends at no named pure derivation or read model`,
      });
      continue;
    }
    branches.push({
      consumer,
      entries: entries.filter((entry) =>
        hubReads.some((edge) => edge.from === methodKey(consumer, entry)),
      ),
      landmarks,
      edges,
      terminals,
      gaps,
      reads: hubReads,
      derivations,
    });
  }
  return { branches, refused };
};

/**
 * The lineage graph as a `TraceResult`, so the ordinary compression, box and
 * link machinery reads it unchanged.
 *
 * Two assembly details are deliberate. The hub's read methods are joined to the
 * entry by internal edges: they carry no claim and are never drawn - every
 * method of the hub type compresses into ONE box - and they exist so that the
 * graph walk reaches each of them and the box names every read an arrow leaves
 * from, which is what keeps the gate's endpoint check meaningful. And each
 * resolved read edge is REVERSED into the lineage arrow: the call runs from the
 * service to the record, the data runs the other way, and the figure draws the
 * data.
 */
export const lineageTrace = (
  hub: TypeSymbol,
  reads: DurableRead[],
  branches: LineageBranch[],
): TraceResult => {
  const used = reads.filter((read) =>
    branches.some((branch) => branch.reads.some((edge) => edge.to === methodKey(hub, read.method))),
  );
  const entry = methodKey(hub, used[0]!.method);
  const landmarks = new Map<string, TraceLandmark>();
  const edges: TraceEdge[] = [];
  const terminals = new Set<string>();

  for (const read of used) {
    const key = methodKey(hub, read.method);
    landmarks.set(key, { key, type: hub, method: read.method, dataAccess: { relation: "read" } });
    if (key === entry) continue;
    edges.push({
      from: entry,
      to: key,
      relation: "call",
      label: `${read.method.name}(...)`,
      path: hub.path,
      line_start: read.method.line_start,
      line_end: read.method.line_end,
      inReturn: false,
      heldReceiver: false,
    });
  }

  for (const branch of branches) {
    for (const [key, landmark] of branch.landmarks) if (!landmarks.has(key)) landmarks.set(key, landmark);
    // A branch's named derivation is where its story ENDS, so it is a terminal
    // here even when it goes on to consult a configured value. Without that the
    // compression folds the rule into the service that called it - a static call
    // is otherwise an implementation detail of its caller - and the figure would
    // draw three services over a record and never name what each derives.
    for (const key of [...branch.terminals, ...branch.derivations]) terminals.add(key);
    for (const edge of branch.edges) {
      if (branch.reads.includes(edge)) {
        const read = used.find((candidate) => methodKey(hub, candidate.method) === edge.to)!;
        edges.push({
          from: edge.to,
          to: edge.from,
          relation: "read",
          lineage: true,
          // The label is a code identifier and, where the read's own SQL writes
          // one, its literal predicate - the two things report 5.5 allows a
          // branch label to carry. `where` and `and` are SQL's own words for the
          // join, not narration added around them.
          label:
            read.predicates.length === 0
              ? `${read.method.name}(...)`
              : `${read.method.name}(...) where ${read.predicates.join(" and ")}`,
          path: edge.path,
          line_start: edge.line_start,
          line_end: edge.line_end,
          inReturn: false,
          heldReceiver: true,
          cites: [
            { path: hub.path, line_start: read.method.line_start, line_end: read.method.line_end },
          ],
        });
        continue;
      }
      edges.push(edge);
    }
  }
  for (const key of [...terminals]) if (isHubRead(key, hub, used)) terminals.delete(key);

  // Two branches can reach the same collaborator by the same line - both loading
  // the catalog, say - and each traced it separately. That is ONE relationship in
  // the merged graph, so the duplicate is dropped here rather than becoming a
  // second identical claim for the gate to resolve twice.
  const seen = new Set<string>();
  const merged = edges.filter((edge) => {
    const key = `${edge.from}|${edge.to}|${edge.relation}|${edge.label}|${edge.path}:${edge.line_start}-${edge.line_end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { entry, landmarks, edges: merged, terminals, gaps: [], cyclesCut: 0, cycleAt: new Set() };
};

const isHubRead = (key: string, hub: TypeSymbol, reads: DurableRead[]): boolean =>
  reads.some((read) => methodKey(hub, read.method) === key);

/**
 * The subject-owned symbol graph the closed negative is proved over.
 *
 * Two edges, both deliberately coarse. A type is reachable from a file that
 * NAMES it in code, whether or not the file calls it; and a type is reachable
 * from anything its own declaration HEADER names, which is what stops an
 * implementation behind an interface from hiding - the caller's file names only
 * the interface. Nothing here looks for a call: a negative that survives a graph
 * this coarse is worth printing, and one that does not is omitted entirely
 * rather than softened to "appear independent" (report 5.5).
 *
 * Built once per subject and traversed per branch, because the over-approximation
 * is the same graph for every question asked of it.
 */
export interface SubjectGraph {
  /** Type name -> every type name its declaring file writes in code. */
  names: Map<string, Set<string>>;
  /** Type name -> every type whose declaration header names it. */
  subtypes: Map<string, Set<string>>;
}

export const subjectGraph = (ctx: ProbeContext, index: JavaIndex): SubjectGraph => {
  const masked = new Map<string, string>();
  const maskOf = (path: string): string => {
    if (!masked.has(path)) masked.set(path, maskedJava(ctx.read(path) ?? ""));
    return masked.get(path)!;
  };
  const every = [...new Set(index.types.map((type) => type.name))];
  const names = new Map<string, Set<string>>();
  const subtypes = new Map<string, Set<string>>();
  const perFile = new Map<string, Set<string>>();
  for (const path of index.paths) {
    const text = maskOf(path);
    perFile.set(path, new Set(every.filter((name) => mentions(text, name))));
  }
  for (const type of index.types) {
    const named = names.get(type.name) ?? new Set<string>();
    for (const other of perFile.get(type.path) ?? []) named.add(other);
    names.set(type.name, named);
    const header = maskOf(type.path)
      .split("\n")
      .slice(type.line_start - 1, type.header_line_end)
      .join("\n");
    for (const base of every) {
      if (base === type.name || !mentions(header, base)) continue;
      subtypes.set(base, (subtypes.get(base) ?? new Set()).add(type.name));
    }
  }
  return { names, subtypes };
};

/** Every type name the graph above says `start` can reach, `start` included. */
export const reachableFrom = (graph: SubjectGraph, start: string): Set<string> => {
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length > 0) {
    const name = pending.pop()!;
    for (const next of [...(graph.names.get(name) ?? []), ...(graph.subtypes.get(name) ?? [])]) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  return seen;
};
