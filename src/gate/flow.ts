/**
 * Flow-specific existence gate (#35, accepted design section 6.1).
 *
 * A Flow is one atomic behavioural claim. The producer may propose a complete
 * graph and one claim per call site each arrow cites - several on an arrow that
 * bundles several call sites; this module rereads the pinned tree and either
 * verifies the whole graph or quarantines the whole graph as `absent`. It never
 * returns a shortened path and never turns extractor uncertainty into a subject
 * divergence.
 */
import { isSourceFile } from "../harvest/tree.js";
import {
  maskedJava,
  mentions,
  type ParenList,
  readParenList,
  withoutComments,
} from "../probes/flow/reachability.js";
import { maskedPython, pythonWithoutComments } from "../probes/flow/py-mask.js";
import { dottedNamesOf, moduleOwnerName, packageDirsIn } from "../probes/flow/py-module.js";
import { normalizedRoute } from "../probes/flow/route.js";
import {
  literalPredicates,
  readVerbName,
  readsDurably,
  writeVerbName,
  writesDurably,
} from "../probes/flow/sql.js";
import { SPRING_STEREOTYPES } from "../probes/flow/stereotype.js";
import { simpleTypeName } from "../probes/flow/symbols.js";
import {
  annotationArgsInText,
  declaredDestination,
  declaredTrigger,
  ENABLE_SCHEDULING_ANNOTATION,
  MESSAGE_ANNOTATIONS,
  SCHEDULED_ANNOTATION,
  type MessageAnnotation,
} from "../probes/flow/trigger.js";
import { execStart, launchClassTokens } from "../probes/flow/unit.js";
import type { Candidate, FlowClaim, ProbeContext, SymbolRef } from "../probes/types.js";
import type {
  Evidence,
  FileEvidence,
  FlowLink,
  FlowNode,
  FlowRelation,
} from "../schema/types.js";

export type FlowResolution = "confirmed" | "contradicted" | "unresolved";

export interface FlowClaimResolution {
  verdict: FlowResolution;
  finding: string;
}

const RELATIONS = new Set<FlowRelation>([
  "call",
  "transport",
  "dispatch",
  "read",
  "write",
  "return",
  "side_effect",
]);

const MATCHER_RELATIONS: Record<FlowClaim["matcher"], ReadonlySet<FlowRelation>> = {
  direct_call: new Set(["call", "return", "side_effect"]),
  spring_route: new Set(["transport"]),
  closed_dispatch: new Set(["dispatch"]),
  data_access: new Set(["read", "write"]),
  data_lineage: new Set(["read"]),
  // A container trigger attaches to no arrow at all: nothing in the tree calls
  // the method, which is the whole of what it claims. It is a caption-level claim
  // like `reachability`, and an empty set is what refuses it a link.
  scheduled_trigger: new Set(),
  message_listener: new Set(),
  process_launch: new Set(["transport"]),
  // A declared pipeline arrow keeps the `call` relation at the schema level; the
  // matcher is what carries the distinction that no line of subject code calls
  // the target (#52, D2). The caption-level ENTRY claim attaches to no arrow at
  // all, and passes this table by carrying no link.
  declared_pipeline: new Set(["call"]),
  reachability: new Set(),
};

/**
 * Which end of the arrow each matcher's `from` symbol belongs to.
 *
 * Every matcher but one names the arrow's own source; a `data_lineage` arrow is
 * drawn the way the DATA travels and established by the call that runs the other
 * way, so its claim names the reader as `from` and the record as `to` (#35,
 * PR 7). The orientation is declared here rather than accepted in either order,
 * because a check that accepted both would accept a swapped arrow.
 */
const REVERSED: ReadonlySet<FlowClaim["matcher"]> = new Set(["data_lineage"]);

const observesBehaviour = (e: Evidence): boolean => e.kind === "file" || e.kind === "command";
const ABSENCE_SHAPED = /\b(no|none|never|not|without|absent|nothing|only|cannot)\b/i;

/**
 * Structural integrity of the durable FlowLink graph.
 *
 * `requireLinks` is true at the candidate gate: legacy calls_next input has no
 * place for atomic link claims and therefore cannot be admitted as a newly
 * checked behavioural Flow. The final-schema audit passes false so pre-1.1
 * artifacts remain readable through the explicit renderer compatibility bridge;
 * links-based artifacts still receive every check below.
 */
export const flowTopologyProblems = (
  flow: FlowNode,
  requireLinks: boolean,
): string[] => {
  const problems: string[] = [];
  if (flow.steps.length === 0) problems.push("the Flow has no steps");

  const stepIds = new Set<string>();
  for (const step of flow.steps) {
    if (stepIds.has(step.id)) problems.push(`step id ${step.id} is duplicated`);
    stepIds.add(step.id);
  }

  if (flow.links === undefined) {
    if (requireLinks) {
      problems.push(
        "the Flow uses legacy calls_next links, which carry no link-owned evidence or atomic gate claim",
      );
    }
    return problems;
  }

  if (flow.links.length === 0) problems.push("the Flow has no links");
  const linkIds = new Set<string>();
  const incoming = new Map(flow.steps.map((s) => [s.id, 0]));
  const outgoing = new Map(flow.steps.map((s) => [s.id, 0]));
  const adjacent = new Map(flow.steps.map((s) => [s.id, new Set<string>()]));

  for (const step of flow.steps) {
    if (!step.evidence || !observesBehaviour(step.evidence)) {
      problems.push(`step ${step.id} carries no file or command evidence`);
    }
  }

  for (const link of flow.links) {
    if (linkIds.has(link.id)) problems.push(`link id ${link.id} is duplicated`);
    linkIds.add(link.id);
    if (!RELATIONS.has(link.relation)) {
      problems.push(`link ${link.id} has unknown relation ${String(link.relation)}`);
    }
    if (!stepIds.has(link.from)) problems.push(`link ${link.id} starts at missing step ${link.from}`);
    if (!stepIds.has(link.to)) problems.push(`link ${link.id} ends at missing step ${link.to}`);
    const linkEvidence = Array.isArray(link.evidence) ? link.evidence : [];
    if (linkEvidence.length === 0 || !linkEvidence.some(observesBehaviour)) {
      problems.push(`link ${link.id} carries no file or command evidence`);
    }
    if (stepIds.has(link.from) && stepIds.has(link.to)) {
      outgoing.set(link.from, (outgoing.get(link.from) ?? 0) + 1);
      incoming.set(link.to, (incoming.get(link.to) ?? 0) + 1);
      adjacent.get(link.from)!.add(link.to);
      adjacent.get(link.to)!.add(link.from);
    }
  }

  if (flow.steps.length > 0 && flow.links.length > 0) {
    const root = flow.steps[0]!.id;
    const seen = new Set([root]);
    const pending = [root];
    while (pending.length > 0) {
      const id = pending.pop()!;
      for (const next of adjacent.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
      }
    }
    const disconnected = flow.steps.map((s) => s.id).filter((id) => !seen.has(id));
    if (disconnected.length > 0) {
      problems.push(`the Flow graph is disconnected at ${disconnected.join(", ")}`);
    }
    if (![...incoming.values()].some((n) => n === 0)) problems.push("the Flow graph has no root");
    if (![...outgoing.values()].some((n) => n === 0)) problems.push("the Flow graph has no terminal");
  }

  return problems;
};

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const simpleName = (value: string): string => {
  const pieces = value.split(/[.#:]/);
  return pieces[pieces.length - 1] ?? value;
};

/**
 * The shared definition of "the same route" (`normalizedRoute`). The producer
 * derives routes from a parse tree and this gate re-derives them from the blob;
 * the two derivations stay independent, but they compare the results through one
 * normalisation so a correct producer cannot look contradicted by a trailing
 * slash.
 */
const normalizedPath = normalizedRoute;

const lineSpan = (
  source: string,
  evidence: FileEvidence,
): { text?: string; problem?: string } => {
  if (evidence.line_start === undefined) return { text: source };
  const lines = source.split("\n");
  const end = evidence.line_end ?? evidence.line_start;
  if (evidence.line_start < 1 || end < evidence.line_start || end > lines.length) {
    return {
      problem: `${evidence.path}:${evidence.line_start}-${end} is outside its ${lines.length}-line file`,
    };
  }
  return { text: lines.slice(evidence.line_start - 1, end).join("\n") };
};

const checkedEvidence = (
  ctx: ProbeContext,
  evidence: FileEvidence[],
): { texts?: Map<string, string[]>; problem?: string } => {
  if (evidence.length === 0) return { problem: "the claim carries no file evidence" };
  const texts = new Map<string, string[]>();
  for (const e of evidence) {
    if (e.sha !== ctx.sha) {
      return { problem: `${e.path} is pinned to ${e.sha}, not the subject SHA ${ctx.sha}` };
    }
    const source = ctx.read(e.path);
    if (source === null) return { problem: `${e.path} does not exist at ${ctx.sha}` };
    const span = lineSpan(source, e);
    if (span.problem) return { problem: span.problem };
    texts.set(e.path, [...(texts.get(e.path) ?? []), span.text!]);
  }
  return { texts };
};

const evidenceKey = (e: FileEvidence): string =>
  JSON.stringify([e.path, e.line_start ?? null, e.line_end ?? null, e.sha]);

/**
 * Whether the claims on one arrow account for exactly the evidence it renders.
 *
 * An arrow may carry SEVERAL atomic claims - one component calling into another
 * at ten call sites is one relationship drawn once, not ten arrows (#35, PR 6) -
 * but the guarantee is unchanged and is checked here rather than assumed: every
 * line the arrow cites belongs to a claim this gate independently resolves, and
 * no claim resolves a line the arrow does not cite. An arrow that cited an
 * eleventh site no claim covered would be asserting a call nothing re-resolved.
 */
const linkEvidenceMatchesClaims = (link: FlowLink, claims: FlowClaim[]): boolean => {
  const proposed = new Set(claims.flatMap((claim) => claim.evidence.map(evidenceKey)));
  const rendered = (Array.isArray(link.evidence) ? link.evidence : []).filter(
    (e): e is FileEvidence => e.kind === "file",
  );
  const renderedKeys = new Set(rendered.map(evidenceKey));
  return (
    rendered.length === renderedKeys.size &&
    renderedKeys.size === proposed.size &&
    [...proposed].every((key) => renderedKeys.has(key))
  );
};

const parenEnd = (text: string, open: number): number => {
  let depth = 0;
  let quote = "";
  let escapedChar = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (escapedChar) escapedChar = false;
      else if (ch === "\\") escapedChar = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** The index of the `(` that opens the parenthesised group closing at `close`. */
const parenStart = (text: string, close: number): number => {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (ch === ")") depth += 1;
    else if (ch === "(") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** The identifier ending at `end` (inclusive), or null if that is not one. */
const identBefore = (text: string, end: number): string | null => {
  let start = end;
  while (start >= 0 && /[\w$]/.test(text[start]!)) start -= 1;
  const id = text.slice(start + 1, end + 1);
  return /^[A-Za-z_$][\w$]*$/.test(id) ? id : null;
};

type ReceiverShape =
  | { kind: "none" }
  | { kind: "named"; receiver: string }
  | { kind: "chained"; receiver: string };

/**
 * The receiver written immediately before a `.name(` call at `nameStart`.
 *
 * A chained receiver `accessor(...).name(` is resolved by matching the accessor's
 * own parentheses with `parenStart` rather than a bounded character class, so an
 * argument that is itself a call or a cast - `graderFor(exercise.type()).grade(...)`
 * - does not defeat the read. A receiver shape this gate cannot name (`arr[i].x(`)
 * reads as no receiver, exactly as the prior flat-regex form did.
 */
const receiverBefore = (span: string, nameStart: number): ReceiverShape => {
  let dot = nameStart - 1;
  while (dot >= 0 && /\s/.test(span[dot]!)) dot -= 1;
  if (dot < 0 || span[dot] !== ".") return { kind: "none" };
  let before = dot - 1;
  while (before >= 0 && /\s/.test(span[before]!)) before -= 1;
  if (before < 0) return { kind: "none" };
  if (span[before] === ")") {
    const open = parenStart(span, before);
    if (open < 0) return { kind: "none" };
    let callee = open - 1;
    while (callee >= 0 && /\s/.test(span[callee]!)) callee -= 1;
    const receiver = identBefore(span, callee);
    return receiver ? { kind: "chained", receiver } : { kind: "none" };
  }
  const receiver = identBefore(span, before);
  return receiver ? { kind: "named", receiver } : { kind: "none" };
};

/**
 * How many arguments or parameters sit between one pair of parentheses.
 *
 * `generics` is what separates a CALL from a DECLARATION. `Map<String, String>`
 * is one parameter written with a comma in it, and counting that comma turns a
 * five-parameter factory into a six-parameter one the gate then says the file no
 * longer declares - a real chain returning as a false contradiction. A call site
 * has no such spans, and `<` there is a comparison, so the two readings are
 * offered separately and the caller accepts either.
 */
const argumentCount = (text: string, open: number, generics = false): number | null => {
  const end = parenEnd(text, open);
  if (end < 0) return null;
  const body = text.slice(open + 1, end).trim();
  if (body === "") return 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let angle = 0;
  let quote = "";
  let escapedChar = false;
  let commas = 0;
  for (const ch of body) {
    if (quote) {
      if (escapedChar) escapedChar = false;
      else if (ch === "\\") escapedChar = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") round += 1;
    else if (ch === ")") round -= 1;
    else if (ch === "[") square += 1;
    else if (ch === "]") square -= 1;
    else if (ch === "{") curly += 1;
    else if (ch === "}") curly -= 1;
    else if (generics && ch === "<") angle += 1;
    else if (generics && ch === ">" && angle > 0) angle -= 1;
    else if (ch === "," && round === 0 && square === 0 && curly === 0 && angle === 0) commas += 1;
  }
  return commas + 1;
};

/** The two readings of one parenthesised list: as a call, and as a declaration. */
const argumentCounts = (text: string, open: number): Set<number> => {
  const counts = new Set<number>();
  for (const generics of [false, true]) {
    const count = argumentCount(text, open, generics);
    if (count !== null) counts.add(count);
  }
  return counts;
};

const symbolExists = (source: string, ref: SymbolRef): boolean => {
  if (ref.owner && !new RegExp(`\\b(?:class|interface|record|enum)\\s+${escaped(simpleName(ref.owner))}\\b`).test(source)) {
    return false;
  }
  const name = simpleName(ref.name);
  const calls = new RegExp(`\\b${escaped(name)}\\s*\\(`, "g");
  for (const match of source.matchAll(calls)) {
    if (ref.arity === undefined) return true;
    const open = source.indexOf("(", match.index);
    if (open >= 0 && argumentCounts(source, open).has(ref.arity)) return true;
  }
  return false;
};

/**
 * Whether the blob says `sub` is a `base` - by inheritance or by nesting.
 *
 * The producer draws an arrow whose target is declared on a supertype of the
 * type the call was written on (`Exercise.id()` declared on the sealed `Content`,
 * a nested record calling its enclosing interface's helper). PR 4 refused those
 * arrows because this gate could not check them; PR 5 lets it check them, by
 * re-deriving the relation from the source rather than trusting the claim. The
 * derivation stays independent: the producer read a parse tree, this reads text.
 */
const declaresSubtype = (ctx: ProbeContext, sub: string, base: string): boolean => {
  // A nested type IS its enclosing type's member: `Comparison.SetEquality` may
  // call what `Comparison` declares, and the qualified name states the nesting.
  if (sub.includes(".") && sub.split(".").includes(simpleName(base))) return true;
  if (simpleName(sub) === simpleName(base)) return true;
  return implementationsInTree(ctx, base).some((impl) => impl.name === simpleName(sub));
};

const typedReceivers = (source: string, owner: string): Set<string> => {
  const simple = simpleName(owner);
  const receivers = new Set<string>([simple]);
  const declarations = new RegExp(
    `\\b${escaped(simple)}(?:\\s*<[^;=(){}]+>)?\\s+([A-Za-z_$][\\w$]*)\\b`,
    "g",
  );
  for (const match of source.matchAll(declarations)) if (match[1]) receivers.add(match[1]);
  return receivers;
};

const looksLikeDeclaration = (text: string, index: number): boolean => {
  const line = text.slice(text.lastIndexOf("\n", index - 1) + 1, index);
  return /\b(?:public|private|protected|static|abstract|default|native|synchronized)\b/.test(line) ||
    /(?:^|\s)(?:void|[A-Z][\w$]*(?:<[^>]+>)?|[a-z][\w$]*\[\])\s+$/.test(line);
};

/**
 * Whether one of the cited spans in the caller's file resolves a call to `to`.
 *
 * `to.receiver` is the type the call was WRITTEN on when that differs from where
 * the target is declared, and it is checked rather than believed: the relation
 * between the two is re-derived from the caller's own source, and a claim whose
 * inheritance the blob does not state resolves nothing.
 *
 * `throughType` accepts a chained receiver of the form `accessor(...).name(...)`
 * where the calling file declares `accessor` returning that type - the one chained
 * receiver this gate can re-read, because the return type is written in the file
 * it is re-reading.
 */
const hasTypedCall = (
  fromSource: string,
  callSpans: string[],
  from: SymbolRef,
  to: SymbolRef,
  isSubtype: (sub: string, base: string) => boolean,
  throughType?: string,
): boolean => {
  const name = simpleName(to.name);
  const writtenOn = to.receiver ?? to.owner;
  const receivers = writtenOn ? typedReceivers(fromSource, writtenOn) : undefined;
  const accessors = throughType ? accessorsReturning(fromSource, throughType) : new Set<string>();
  // A receiver constructed on the spot - `new RepDeriver().derive(spec)` - names
  // its own type at the call site, so it is re-readable here even though it is
  // not a declared name the file binds. The constructor's own argument list is
  // skipped with `parenEnd` rather than a bounded character class, so a nested
  // call or cast - `new RepDeriver((Config) cfg).derive(...)` - still resolves.
  if (writtenOn !== undefined) {
    const ctorHead = new RegExp(
      `\\bnew\\s+(?:[\\w$]+\\s*\\.\\s*)*${escaped(simpleName(writtenOn))}\\s*(?:<[^;{}()]*>)?\\s*\\(`,
      "g",
    );
    const chainTail = new RegExp(`^\\s*\\.\\s*${escaped(name)}\\s*\\(`);
    for (const span of callSpans) {
      for (const match of span.matchAll(ctorHead)) {
        const ctorOpen = match.index + match[0].length - 1;
        const ctorClose = parenEnd(span, ctorOpen);
        if (ctorClose < 0) continue;
        const tail = chainTail.exec(span.slice(ctorClose + 1));
        if (!tail) continue;
        const callOpen = ctorClose + tail[0].length;
        if (to.arity === undefined || argumentCounts(span, callOpen).has(to.arity)) return true;
      }
    }
  }
  const call = new RegExp(`\\b${escaped(name)}\\s*\\(`, "g");
  for (const span of callSpans) {
    for (const match of span.matchAll(call)) {
      const shape = receiverBefore(span, match.index);
      const receiver = shape.kind === "none" ? undefined : shape.receiver;
      const chained = shape.kind === "chained";
      if (!receiver && looksLikeDeclaration(span, match.index)) continue;
      if (chained) {
        if (!receiver || !accessors.has(receiver)) continue;
      } else if (receivers && !receiver) {
        // A bare call resolves inside the caller's own type, or inside a type it
        // inherits from - which the caller's source has to say.
        const owner = simpleName(from.owner ?? "");
        if (owner !== simpleName(writtenOn ?? "") && !isSubtype(from.owner ?? "", writtenOn ?? "")) {
          continue;
        }
      } else if (receivers && receiver && !receivers.has(receiver)) {
        continue;
      }
      // `match` ends at the call's own `(`, so its position is exact. Finding it
      // by searching for the method name would land inside a receiver that merely
      // starts with it - `graderFor(x).grade(...)` counting `graderFor`'s
      // arguments as `grade`'s, and a real dispatch coming back contradicted.
      const callOpen = match.index + match[0].length - 1;
      if (to.arity !== undefined && !argumentCounts(span, callOpen).has(to.arity)) continue;
      return true;
    }
  }
  return false;
};

/** Methods the calling file declares as returning `type` - a re-readable accessor. */
const accessorsReturning = (source: string, type: string): Set<string> => {
  const names = new Set<string>();
  const declarations = new RegExp(
    `\\b${escaped(simpleName(type))}(?:\\s*<[^;=(){}]+>)?\\s+([A-Za-z_$][\\w$]*)\\s*\\(`,
    "g",
  );
  for (const match of source.matchAll(declarations)) if (match[1]) names.add(match[1]);
  return names;
};

const resolveDirectCall = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
): FlowClaimResolution => {
  const to = claim.to;
  if (!to) return { verdict: "unresolved", finding: "a direct_call claim names no target" };
  const fromSource = ctx.read(claim.from.path);
  const toSource = ctx.read(to.path);
  if (fromSource === null || toSource === null) {
    return { verdict: "unresolved", finding: "the caller or target source could not be read" };
  }
  if (!symbolExists(fromSource, claim.from)) {
    return {
      verdict: "contradicted",
      finding: `${claim.from.path} no longer declares ${claim.from.name}`,
    };
  }
  if (!symbolExists(toSource, to)) {
    return { verdict: "contradicted", finding: `${to.path} no longer declares ${to.name}` };
  }
  const spans = texts.get(claim.from.path) ?? [];
  if (spans.length === 0) {
    return {
      verdict: "unresolved",
      finding: `no cited span in ${claim.from.path} can establish the call`,
    };
  }
  // An arrow whose target is declared on a supertype of the type the call was
  // written on is checked, not believed: the gate re-enumerates that inheritance
  // from the tree, so a claim whose relation the source no longer states resolves
  // nothing rather than being taken at its word.
  const isSubtype = (sub: string, base: string): boolean => declaresSubtype(ctx, sub, base);
  if (
    to.receiver !== undefined &&
    to.owner !== undefined &&
    simpleName(to.receiver) !== simpleName(to.owner) &&
    !isSubtype(to.receiver, to.owner)
  ) {
    return {
      verdict: "contradicted",
      finding: `the tree does not declare ${simpleName(to.receiver)} as a ${simpleName(to.owner)}`,
    };
  }
  const found = hasTypedCall(fromSource, spans, claim.from, to, isSubtype, to.receiver ?? to.owner);
  if (claim.expect === "absent") {
    return found
      ? { verdict: "contradicted", finding: `${claim.from.name} still calls ${to.name}` }
      : {
          verdict: "unresolved",
          finding: "a cited span is not a closed call graph and cannot establish absence",
        };
  }
  return found
    ? { verdict: "confirmed", finding: `${claim.from.name} resolves to ${to.name}` }
    : {
        verdict: "contradicted",
        finding: `the cited caller span does not resolve ${claim.from.name} to ${to.name}`,
      };
};

const mappingPath = (args: string): string => {
  const quoted = /["'`]([^"'`]+)["'`]/.exec(args)?.[1];
  return quoted ?? "/";
};

const springEndpoint = (
  source: string,
  ref: SymbolRef,
): { method: string; path: string } | null => {
  const name = simpleName(ref.name);
  const declarations = new RegExp(`\\b${escaped(name)}\\s*\\(`, "g");
  for (const declaration of source.matchAll(declarations)) {
    const beforeMethod = source.slice(Math.max(0, declaration.index - 800), declaration.index);
    const mappings = [
      ...beforeMethod.matchAll(
        /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(([\s\S]{0,300}?)\))?/g,
      ),
    ];
    const mapping = mappings[mappings.length - 1];
    if (!mapping) continue;
    const kind = mapping[1]!;
    const args = mapping[2] ?? "";
    const method =
      kind === "Request"
        ? /RequestMethod\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/.exec(args)?.[1]
        : kind.toUpperCase();
    if (!method) continue;

    const classAt = source.lastIndexOf("class ", declaration.index);
    const classPrefix = classAt < 0 ? "" : source.slice(Math.max(0, classAt - 800), classAt);
    const prefixes = [...classPrefix.matchAll(/@RequestMapping\s*\(([^)]*)\)/g)];
    const prefix = prefixes.length === 0 ? "" : mappingPath(prefixes[prefixes.length - 1]![1] ?? "");
    return { method, path: normalizedPath(`${prefix}/${mappingPath(args)}`) };
  }
  return null;
};

/* ----------------------------------------- the client half of a transport */

/*
 * A transport claim is a claim that two files agree on one contract, and this is
 * the half of it written in TypeScript (#35, PR 6).
 *
 * It is deliberately NOT the producer's scanner. The producer masks a whole
 * module and walks it structurally; this re-derives the endpoint from the CITED
 * SPAN and nothing else, with its own reading, so a citation that points at the
 * wrong lines fails here even though the module elsewhere contains a matching
 * call. The two share exactly one thing - `normalizedRoute`, the definition of
 * "the same route" - for the same reason `manifests.ts` shares one definition of
 * "declared" while leaving both resolutions independent.
 *
 * Every reading below fails closed. A URL that is not one literal, an options
 * argument that is not an object literal, or a `method` that is not a string
 * literal all mean "this span does not establish an endpoint", which quarantines
 * the Flow rather than admitting an arrow drawn on a probable contract.
 */

/** `fetch` with no options is a GET, by specification; both halves know only that. */
const IMPLIED_CLIENT_VERB = "GET";

const clientCallsIn = (span: string): { name: string; open: number }[] => {
  const out: { name: string; open: number }[] = [];
  for (const match of span.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    out.push({ name: match[2]!, open: match.index + match[0].length - 1 });
  }
  return out;
};

/** The endpoint one client call writes down, or null when it writes none down. */
const clientEndpointAt = (
  span: string,
  open: number,
): { method: string; path: string } | null => {
  const close = parenEnd(span, open);
  if (close < 0) return null;
  const args = span.slice(open + 1, close);
  const offset = args.length - args.trimStart().length;
  const literal = /^(['"`])([^'"`\\]*)\1/.exec(args.trimStart());
  if (!literal) return null;
  // Test the captured literal, not the normalized route: normalizedPath prepends
  // a slash so its output always starts with "/". A relative fetch resolves against
  // the page URL and a cross-origin URL is not this subject's route, so the gate
  // independently refuses both rather than echoing a producer that admitted one.
  if (!literal[2]!.startsWith("/")) return null;
  const path = normalizedPath(literal[2]!);

  const rest = args.slice(offset + literal[0].length).trim();
  if (rest.length === 0) return { method: IMPLIED_CLIENT_VERB, path };
  if (!rest.startsWith(",")) return null;
  const options = rest.slice(1).trim();
  if (!options.startsWith("{") || !options.endsWith("}")) return null;
  if (!/(?:^|[{,\s])method\s*:/.test(options)) return { method: IMPLIED_CLIENT_VERB, path };
  const verb = /(?:^|[{,\s])method\s*:\s*(['"`])\s*([A-Za-z]+)\s*\1/.exec(options)?.[2];
  return verb === undefined ? null : { method: verb.toUpperCase(), path };
};

/**
 * Whether the cited evidence closes `name` as an HTTP client of this subject.
 *
 * `fetch` is one by definition. Anything else has to be a function the subject
 * declares that hands its first parameter to `fetch` and adds no literal path
 * text of its own - re-derived here from the span the claim cites, exactly as the
 * dispatch resolver re-derives a guard rather than believing the producer's label.
 * A helper that rewrote the path would make the call site's literal something
 * other than the route, so refusing it is what keeps the arrow honest.
 */
const closesHttpClient = (name: string, texts: Map<string, string[]>): boolean => {
  if (name === "fetch") return true;
  const declaration = new RegExp(
    `(?:function\\s+${escaped(name)}\\s*\\(|(?:const|let|var)\\s+${escaped(name)}\\s*(?::[^=]*?)?=\\s*(?:async\\s*)?\\()`,
  );
  for (const spans of texts.values()) {
    for (const span of spans) {
      const declared = declaration.exec(span);
      if (!declared) continue;
      const open = span.indexOf("(", declared.index + declared[0].length - 1);
      const close = parenEnd(span, open);
      if (close < 0) continue;
      const param = /^\s*([A-Za-z_$][\w$]*)/.exec(span.slice(open + 1, close))?.[1];
      if (!param) continue;
      for (const call of clientCallsIn(span.slice(close))) {
        if (call.name !== "fetch") continue;
        const body = span.slice(close);
        const end = parenEnd(body, call.open);
        if (end < 0) continue;
        const url = body.slice(call.open + 1, end).split(",")[0]!.trim();
        if (url === param) return true;
        const assigned = new RegExp(
          `(?:const|let|var)\\s+${escaped(url)}\\s*=\\s*\`([^\`]*)\``,
        ).exec(span);
        if (!assigned) continue;
        const template = assigned[1]!;
        if (template.replace(/\$\{[^}]*\}/g, "").trim().length > 0) continue;
        if (new RegExp(`\\$\\{[^}]*\\b${escaped(param)}\\b[^}]*\\}`).test(template)) return true;
      }
    }
  }
  return false;
};

/**
 * Whether the CITED caller spans re-derive this claim's endpoint.
 *
 * A transport arrow carries one atomic claim PER call site (#35, PR 6), so the
 * claim cites exactly one call span in the caller's own file - the loop is not a
 * tolerance for several unrelated call sites riding in on one another, it iterates
 * because a wrapper declared in the caller's OWN module cites a second span for
 * this path, and that declaration span establishes no endpoint of its own.
 */
const clientEstablishes = (
  claim: FlowClaim,
  texts: Map<string, string[]>,
  protocol: NonNullable<SymbolRef["protocol"]>,
): boolean => {
  const wantedPath = normalizedPath(protocol.path);
  for (const span of texts.get(claim.from.path) ?? []) {
    for (const call of clientCallsIn(span)) {
      if (!closesHttpClient(call.name, texts)) continue;
      const endpoint = clientEndpointAt(span, call.open);
      if (endpoint === null) continue;
      if (endpoint.path === wantedPath && endpoint.method === protocol.method) return true;
    }
  }
  return false;
};

const endpointEquals = (
  actual: { method: string; path: string } | null,
  expected: NonNullable<SymbolRef["protocol"]>,
): boolean =>
  actual !== null &&
  actual.method.toUpperCase() === expected.method &&
  normalizedPath(actual.path) === normalizedPath(expected.path);

const resolveSpringRoute = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
): FlowClaimResolution => {
  const to = claim.to;
  if (!to?.protocol || !claim.from.protocol) {
    return { verdict: "unresolved", finding: "a spring_route claim needs protocol data at both ends" };
  }
  const sameContract =
    claim.from.protocol.method === to.protocol.method &&
    normalizedPath(claim.from.protocol.path) === normalizedPath(to.protocol.path);
  if (!sameContract) {
    return { verdict: "contradicted", finding: "the caller and handler claim different HTTP contracts" };
  }
  const citedPaths = new Set(claim.evidence.map((e) => e.path));
  if (!citedPaths.has(claim.from.path) || !citedPaths.has(to.path)) {
    return {
      verdict: "unresolved",
      finding: "a transport link must cite both the caller and the handler",
    };
  }
  const fromSource = ctx.read(claim.from.path);
  const toSource = ctx.read(to.path);
  if (fromSource === null || toSource === null) {
    return { verdict: "unresolved", finding: "the caller or handler source could not be read" };
  }
  // Three readings, chosen by what the cited file IS: a Java handler's
  // annotations, a Python handler's decorator, or a TypeScript client's call.
  // The matcher's name is Java-flavoured history; what it asserts is that both
  // ends establish the same verb and the same normalized path, and #52 fixes the
  // new-matcher budget at one, so renaming it is its own decision.
  const handlerEndpoint = (path: string, source: string, ref: SymbolRef) =>
    path.endsWith(".py") ? pythonRouteEndpoint(ctx, claim, texts, ref) : springEndpoint(source, ref);
  const fromMatches =
    claim.from.path.endsWith(".java") || claim.from.path.endsWith(".py")
      ? endpointEquals(handlerEndpoint(claim.from.path, fromSource, claim.from), claim.from.protocol)
      : clientEstablishes(claim, texts, claim.from.protocol);
  const toMatches = endpointEquals(handlerEndpoint(to.path, toSource, to), to.protocol);
  const found = fromMatches && toMatches;
  if (claim.expect === "absent") {
    return found
      ? { verdict: "contradicted", finding: "caller and handler still share the claimed route" }
      : {
          verdict: "unresolved",
          finding: "two cited endpoint spans are not a closed route inventory and cannot establish absence",
        };
  }
  return found
    ? {
        verdict: "confirmed",
        finding: `${to.protocol.method} ${normalizedPath(to.protocol.path)} resolves at both ends`,
      }
    : {
        verdict: "contradicted",
        finding: `the cited caller and Spring handler do not both establish ${to.protocol.method} ${normalizedPath(to.protocol.path)}`,
      };
};

/**
 * Every subject type the BLOB says implements or extends `base`, transitively.
 *
 * This is the whole point of the `closed_dispatch` check and the reason it cannot
 * be reduced to "does the target exist". A dispatch arrow claims the call reaches
 * one of a CLOSED set; proving one member exists says nothing about whether a
 * fifth implementation was added since. So the gate re-enumerates the set from
 * the tree, by its own textual derivation, and refuses a claim whose count no
 * longer matches - the producer read a parse tree, this reads source.
 */
// A per-context cache: one dispatch claim re-enumerates the same set several
// times (the membership count, the branch-guard sources, the abstract-intermediate
// subtype check), each a fixed-point scan over every subject .java file. The read
// is deterministic for a fixed context, so the cache is pure - same inputs, same
// answer - and keyed by simple name because the enumeration already is.
const implementationsCache = new WeakMap<
  ProbeContext,
  Map<string, { path: string; name: string }[]>
>();

const implementationsInTree = (ctx: ProbeContext, base: string): { path: string; name: string }[] => {
  const key = simpleName(base);
  let perContext = implementationsCache.get(ctx);
  if (!perContext) {
    perContext = new Map();
    implementationsCache.set(ctx, perContext);
  }
  const cached = perContext.get(key);
  if (cached) return cached;
  const found: { path: string; name: string }[] = [];
  const named = new Set<string>([key]);
  const sources = ctx.paths
    .filter((path) => path.endsWith(".java") && isSourceFile(path))
    .map((path) => ({ path, source: ctx.read(path) }))
    .filter((entry): entry is { path: string; source: string } => entry.source !== null);
  for (let changed = true; changed; ) {
    changed = false;
    for (const supertype of [...named]) {
      const declaration = new RegExp(
        `\\b(?<abstract>abstract\\s+)?(?<kind>class|interface|record|enum)\\s+(?<name>[A-Za-z_$][\\w$]*)\\b(?:\\s*<[^{;]*?>)?\\s*(?<params>\\([^)]*\\))?[^{;]*?\\b(?:extends|implements)\\b[^{;]*?\\b${escaped(supertype)}\\b`,
        "g",
      );
      for (const entry of sources) {
        for (const match of entry.source.matchAll(declaration)) {
          const name = match.groups?.["name"];
          if (!name || named.has(name)) continue;
          named.add(name);
          changed = true;
          // Interfaces and abstract classes are waypoints in the hierarchy, not
          // members of the dispatch set, exactly as the producer counts them.
          if (match.groups?.["kind"] === "interface" || match.groups?.["abstract"]) continue;
          found.push({ path: entry.path, name });
        }
      }
    }
  }
  perContext.set(key, found);
  return found;
};

/** Whether the tree declares `type` as sealed - a set the compiler itself closes. */
const declaredSealed = (source: string, type: string): boolean =>
  new RegExp(`\\bsealed\\s+(?:abstract\\s+)?(?:class|interface|record)\\s+${escaped(simpleName(type))}\\b`).test(
    source,
  );

const resolveClosedDispatch = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
): FlowClaimResolution => {
  const to = claim.to;
  const dispatch = claim.dispatch;
  if (!to) return { verdict: "unresolved", finding: "a closed_dispatch claim names no target" };
  if (!dispatch) {
    return {
      verdict: "unresolved",
      finding: "a closed_dispatch claim carries no declared type and implementation count to re-resolve",
    };
  }
  if (claim.expect === "absent") {
    return {
      verdict: "unresolved",
      finding: "a dispatch arrow cannot express absence; a closed negative claim is a reachability check",
    };
  }
  const baseSource = ctx.read(dispatch.base.path);
  const fromSource = ctx.read(claim.from.path);
  const toSource = ctx.read(to.path);
  if (baseSource === null || fromSource === null || toSource === null) {
    return { verdict: "unresolved", finding: "the declared type, caller or target source could not be read" };
  }
  const baseName = simpleName(dispatch.base.name);
  if (!new RegExp(`\\b(?:interface|class|record|enum)\\s+${escaped(baseName)}\\b`).test(baseSource)) {
    return { verdict: "contradicted", finding: `${dispatch.base.path} no longer declares ${baseName}` };
  }
  const implementations = implementationsInTree(ctx, baseName);
  if (implementations.length !== dispatch.member_count) {
    return {
      verdict: "contradicted",
      finding: `${baseName} now has ${implementations.length} subject implementations, not the ${dispatch.member_count} this arrow closed the set at`,
    };
  }
  // The target may be the declared type's OWN default method - what every
  // implementation that does not override it inherits - which is a member of the
  // set without being one of its implementations.
  const inheritedDefault =
    to.path === dispatch.base.path &&
    new RegExp(`\\bdefault\\b[^;{]*\\b${escaped(simpleName(to.name))}\\s*\\(`).test(baseSource);
  // A concrete member may inherit the dispatched method from an ABSTRACT subject
  // superclass instead of declaring it itself; the producer's methodOn() follows
  // supertypes, so the target's file is that abstract intermediate, which the set
  // deliberately excludes as a waypoint. Accept it only when the tree re-derives
  // it as a supertype of a member of the set - proving the relation from source,
  // as the inheritedDefault case does for an interface's own default.
  const declaringType = to.receiver ?? to.owner;
  const inheritedFromIntermediate =
    !inheritedDefault &&
    declaringType !== undefined &&
    to.path !== dispatch.base.path &&
    implementations.some((impl) => declaresSubtype(ctx, impl.name, declaringType));
  if (
    !inheritedDefault &&
    !inheritedFromIntermediate &&
    !implementations.some((impl) => impl.path === to.path)
  ) {
    return {
      verdict: "contradicted",
      finding: `${to.path} is not among the ${implementations.length} subject implementations of ${baseName}`,
    };
  }
  if (!symbolExists(toSource, to)) {
    return { verdict: "contradicted", finding: `${to.path} no longer declares ${to.name}` };
  }
  if (inheritedDefault) {
    // A branch that resolves to the shared default is named by the guards of the
    // implementations that inherit it, and those live in their own files; the set
    // count above is what this arrow's completeness rests on.
    const spansForDefault = texts.get(claim.from.path) ?? [];
    if (spansForDefault.length === 0) {
      return { verdict: "unresolved", finding: `no cited span in ${claim.from.path} can establish the dispatch` };
    }
    return hasTypedCall(
      fromSource,
      spansForDefault,
      claim.from,
      { ...to, owner: dispatch.base.name, receiver: undefined },
      (sub, base) => declaresSubtype(ctx, sub, base),
      baseName,
    )
      ? {
          verdict: "confirmed",
          finding: `${claim.from.name} dispatches ${baseName}.${simpleName(to.name)} into the declared type's own default (${dispatch.member_count} implementations inherit it)`,
        }
      : {
          verdict: "contradicted",
          finding: `the cited caller span does not dispatch ${baseName}.${simpleName(to.name)}`,
        };
  }
  const branchProblem = dispatchBranchProblem(ctx, dispatch, baseSource, toSource, implementations.length);
  if (branchProblem) return { verdict: "contradicted", finding: branchProblem };

  const spans = texts.get(claim.from.path) ?? [];
  if (spans.length === 0) {
    return { verdict: "unresolved", finding: `no cited span in ${claim.from.path} can establish the dispatch` };
  }
  // The call is written on the DECLARED type, never on the implementation - that
  // is what makes it a dispatch - so the receiver is re-typed against the base.
  const throughBase: SymbolRef = { ...to, owner: dispatch.base.name, receiver: undefined };
  if (
    !hasTypedCall(
      fromSource,
      spans,
      claim.from,
      throughBase,
      (sub, base) => declaresSubtype(ctx, sub, base),
      baseName,
    )
  ) {
    return {
      verdict: "contradicted",
      finding: `the cited caller span does not dispatch ${baseName}.${simpleName(to.name)}`,
    };
  }
  return {
    verdict: "confirmed",
    finding: `${claim.from.name} dispatches ${baseName}.${simpleName(to.name)} into ${to.owner ?? to.path} (${dispatch.via}, ${dispatch.member_count} implementations)`,
  };
};

/** Whether the tree still names this branch the way the arrow's label says. */
const dispatchBranchProblem = (
  ctx: ProbeContext,
  dispatch: NonNullable<FlowClaim["dispatch"]>,
  baseSource: string,
  toSource: string,
  memberCount: number,
): string | null => {
  const baseName = simpleName(dispatch.base.name);
  // A branch label is guarded in the file of the implementation that declares the
  // guard, which is not always the arrow's target file: when the dispatched method
  // is inherited from a shared abstract intermediate, the target collapses onto the
  // base while each `instanceof`/`return "key"` guard stays in its own concrete
  // implementation. So the gate re-reads the whole set's own sources, exactly as
  // the closed_set case does, and a label is satisfied when SOME member declares it.
  const guardSources = (): string[] =>
    [toSource, ...implementationsInTree(ctx, baseName).map((impl) => ctx.read(impl.path))].filter(
      (source): source is string => source !== null,
    );
  switch (dispatch.via) {
    case "sole_implementation":
      return memberCount === 1
        ? null
        : `${baseName} is claimed to have a sole implementation but the tree holds ${memberCount}`;
    case "sealed_guard": {
      const sources = guardSources();
      const missing = dispatch.labels.filter(
        (label) =>
          !sources.some((source) =>
            // The producer normalises the guard type through `qualifiedTypeName`,
            // which drops lowercase (package) segments, so a source written
            // `instanceof com.grader.Grading.TestCases` yields the label
            // `Grading.TestCases`. The gate strips the same optional leading
            // package path here rather than requiring the label immediately after
            // `instanceof`, mirroring the producer exactly as the keyed_registry
            // check already tolerates the formatting the producer is blind to.
            new RegExp(`instanceof\\s+(?:[a-z$][\\w$]*\\.)*${escaped(label)}\\b`).test(source),
          ),
      );
      return missing.length === 0
        ? null
        : `no subject implementation of ${baseName} guards on ${missing.join(", ")}`;
    }
    case "keyed_registry": {
      const sources = guardSources();
      const missing = dispatch.labels.filter(
        (label) => !sources.some((source) => new RegExp(`\\breturn\\s*\\(?\\s*${escaped(label)}\\s*\\)?\\s*;`).test(source)),
      );
      return missing.length === 0
        ? null
        : `no subject implementation of ${baseName} returns the key ${missing.join(", ")}`;
    }
    case "closed_set": {
      if (declaredSealed(baseSource, baseName)) return null;
      // Not sealed, so the container is what closes it: every implementation has
      // to be a bean, or the set is one this gate cannot call complete.
      const unmanaged = implementationsInTree(ctx, baseName).filter((impl) => {
        const source = ctx.read(impl.path);
        return source === null || !STEREOTYPE.test(source);
      });
      return unmanaged.length === 0
        ? null
        : `${baseName} is neither sealed nor closed by the container: ${unmanaged.map((i) => i.name).join(", ")} carries no Spring stereotype`;
    }
  }
};

// Built from the shared list so the gate re-derives "is a bean" from the same
// definition the producer draws it from, reading annotation text where the
// producer read annotation nodes. Hand-writing `@Controller\b` here is what
// caused the drift this replaces: it cannot match `@ControllerAdvice`, whose own
// `\b` falls after `Advice`, so a longer stereotype name needs its own alternative.
const STEREOTYPE = new RegExp(`@(?:${SPRING_STEREOTYPES.map(escaped).join("|")})\\b`);

const sqlAccess = (spans: string[], target: string, relation: FlowRelation): boolean => {
  const t = escaped(simpleName(target));
  const pattern =
    relation === "read"
      ? new RegExp(`\\b(?:select\\b[\\s\\S]{0,500}?\\bfrom|from|join)\\s+[\\w.\"\`]*${t}\\b`, "i")
      : new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from|merge\\s+into)\\s+[\\w.\"\`]*${t}\\b`, "i");
  return spans.some((span) => pattern.test(span));
};

const resolveDataAccess = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
  relation: FlowRelation,
): FlowClaimResolution => {
  const to = claim.to;
  if (!to) return { verdict: "unresolved", finding: "a data_access claim names no target" };
  const fromSource = ctx.read(claim.from.path);
  const toSource = ctx.read(to.path);
  if (fromSource === null || toSource === null) {
    return { verdict: "unresolved", finding: "the data caller or target source could not be read" };
  }
  const spans = texts.get(claim.from.path) ?? [];
  if (spans.length === 0) {
    return { verdict: "unresolved", finding: "no cited caller span can establish the data access" };
  }
  const method = simpleName(to.name);
  const conventionMatches = relation === "read" ? readVerbName(method) : writeVerbName(method);
  const typed =
    conventionMatches &&
    symbolExists(toSource, to) &&
    hasTypedCall(
      fromSource,
      spans,
      claim.from,
      to,
      (sub, base) => declaresSubtype(ctx, sub, base),
      to.receiver ?? to.owner,
    );
  const sql = sqlAccess(spans, to.name, relation);
  const found = typed || sql;
  if (claim.expect === "absent") {
    return found
      ? { verdict: "contradicted", finding: `${claim.from.name} still ${relation}s ${to.name}` }
      : {
          verdict: "unresolved",
          finding: "a cited data-access span is not a closed reachability proof of absence",
        };
  }
  return found
    ? { verdict: "confirmed", finding: `${claim.from.name} ${relation}s ${to.name}` }
    : {
        verdict: "contradicted",
        finding: `the cited source does not establish a ${relation} from ${claim.from.name} to ${to.name}`,
      };
};

/**
 * A DATA-LINEAGE arrow, re-derived from the two spans it cites (#35, PR 7).
 *
 * The arrow asserts two things at once and both are checked here, from the blob
 * and never from the producer's word for it: that the derivation's own cited
 * line calls this read on a receiver the file types as the record, and that the
 * read the arrow names IS a durable read - its declaration writes a SELECT. A
 * method name proves neither. `cleanPassInstants` matches no read-verb
 * convention and is the most load-bearing read on the reference subject, while
 * a helper called `findAll` on a repository might be a private list filter.
 *
 * The LABEL is checked too, which no other matcher needs to do. A lineage label
 * carries literal SQL predicates - `outcome = 'PASSED'` - and a predicate is a
 * claim about what the record's reader sees, so it has to appear in the read the
 * arrow cites. A label naming a filter the SQL does not write would be the
 * figure asserting something nothing established.
 */
const resolveDataLineage = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
): FlowClaimResolution => {
  const to = claim.to;
  if (!to) return { verdict: "unresolved", finding: "a data_lineage claim names no durable read" };
  if (claim.expect !== "present") {
    return { verdict: "unresolved", finding: "a data_lineage claim can only establish a rendered arrow" };
  }
  const readerSource = ctx.read(claim.from.path);
  const recordSource = ctx.read(to.path);
  if (readerSource === null || recordSource === null) {
    return { verdict: "unresolved", finding: "the reader or the record source could not be read" };
  }
  const readSpans = texts.get(to.path) ?? [];
  const callSpans = (texts.get(claim.from.path) ?? []).filter((span) => !readSpans.includes(span));
  if (callSpans.length === 0) {
    return { verdict: "unresolved", finding: "no cited reader span can establish the read" };
  }
  if (readSpans.length === 0) {
    return { verdict: "unresolved", finding: `no cited span declares ${to.name}` };
  }
  const declaration = readSpans.find(
    (span) => new RegExp(`\\b${escaped(simpleName(to.name))}\\s*\\(`).test(span),
  );
  if (declaration === undefined) {
    return {
      verdict: "contradicted",
      finding: `the cited declaration span does not declare ${to.name}`,
    };
  }
  if (!readsDurably(declaration)) {
    return {
      verdict: "contradicted",
      finding: `${to.name} does not read durable storage: its declaration writes no SELECT`,
    };
  }
  if (
    !hasTypedCall(
      readerSource,
      callSpans,
      claim.from,
      to,
      (sub, base) => declaresSubtype(ctx, sub, base),
      to.receiver ?? to.owner,
    )
  ) {
    return {
      verdict: "contradicted",
      finding: `the cited source does not establish ${claim.from.name} reading ${to.name}`,
    };
  }
  return { verdict: "confirmed", finding: `${claim.from.name} reads ${to.name}` };
};

/**
 * A lineage arrow's LABEL is a claim, and this is where it is checked.
 *
 * No other matcher needs this. A lineage label carries literal SQL predicates -
 * `outcome = 'PASSED'` - and a predicate is a statement about what the record's
 * reader can see, which is the whole insight the second reference Flow exists to
 * carry. A label naming a filter the SQL does not write would be the figure
 * asserting something nothing established.
 *
 * It is checked once per ARROW rather than once per claim, because one arrow
 * bundles every call site between two components (#35, PR 6) and its label is
 * therefore the union of what those reads write. Checking a merged label against
 * one claim's span alone rejects a correct arrow - which is how this check was
 * found wrong the first time it ran on the reference subject.
 */
const lineageLabelProblem = (
  ctx: ProbeContext,
  link: FlowLink,
  claims: FlowClaim[],
): string | null => {
  const spans: string[] = [];
  for (const claim of claims) {
    const recordPath = claim.to?.path;
    if (recordPath === undefined) continue;
    const source = ctx.read(recordPath);
    if (source === null) continue;
    for (const evidence of claim.evidence) {
      if (evidence.path !== recordPath) continue;
      const span = lineSpan(source, evidence);
      if (span.text !== undefined) spans.push(span.text);
    }
  }
  const written = new Set(spans.flatMap((span) => literalPredicates(span)));
  for (const predicate of literalPredicates(link.label ?? "")) {
    if (!written.has(predicate)) {
      return `the arrow is labelled \`${predicate}\`, which the SQL it cites does not write`;
    }
  }
  return null;
};

/**
 * The CLOSED negative: nothing reachable from one type is the other (#35, PR 7,
 * report 5.5).
 *
 * A negative claim is admissible only if a closed check over the subject-owned
 * symbol graph establishes it, so this is the one resolver that has to be sound
 * rather than merely exact: it over-approximates reachability and confirms only
 * when even the over-approximation misses. A type is reachable if any file in
 * the closure names it in CODE, or if its own declaration header names something
 * already in the closure - the second rule is what stops an implementation
 * behind an interface from hiding, because the caller's file names only the
 * interface.
 *
 * The inventory and the traversal are this gate's own: it finds declarations by
 * scanning the blob, where the producer read a parse tree. What the two share is
 * one definition of what "names a type in code" means - the same arrangement
 * `normalizedRoute` and `manifests.ts` use.
 *
 * Failing to close it is `unresolved`, not `contradicted`: an over-approximation
 * that reaches something has not proved a read exists, only that it cannot rule
 * one out, and a Flow whose caption says otherwise is quarantined rather than
 * relabelled.
 */
const DECLARATION = /\b(?:class|interface|record|enum)\s+([A-Z][\w$]*)/g;

interface SubjectGraph {
  /** Type name -> every type name its declaring file writes in code. */
  names: Map<string, Set<string>>;
  /** Type name -> every type whose declaration header names it. */
  subtypes: Map<string, Set<string>>;
  declared: Set<string>;
}

const graphCache = new WeakMap<ProbeContext, SubjectGraph>();

/**
 * The gate's OWN inventory and its own graph, built by scanning the blob for
 * declarations where the producer read a parse tree. The two share exactly one
 * thing - what `mentions` means - for the same reason `normalizedRoute` is
 * shared while both route derivations stay independent.
 */
const subjectGraph = (ctx: ProbeContext): SubjectGraph => {
  const cached = graphCache.get(ctx);
  if (cached) return cached;
  const files = ctx.paths.filter((path) => path.endsWith(".java") && isSourceFile(path));
  const masked = new Map<string, string>();
  for (const path of files) masked.set(path, maskedJava(ctx.read(path) ?? ""));
  const declaredIn = new Map<string, string[]>();
  const headers = new Map<string, string[]>();
  for (const [path, text] of masked) {
    for (const match of text.matchAll(DECLARATION)) {
      const name = match[1]!;
      const brace = text.indexOf("{", match.index);
      declaredIn.set(name, [...(declaredIn.get(name) ?? []), path]);
      headers.set(name, [
        ...(headers.get(name) ?? []),
        text.slice(match.index, brace === -1 ? match.index + 200 : brace),
      ]);
    }
  }
  const declared = new Set(declaredIn.keys());
  const every = [...declared];
  const perFile = new Map<string, Set<string>>();
  for (const [path, text] of masked) {
    perFile.set(path, new Set(every.filter((name) => mentions(text, name))));
  }
  const names = new Map<string, Set<string>>();
  const subtypes = new Map<string, Set<string>>();
  for (const [name, paths] of declaredIn) {
    const named = new Set<string>();
    for (const path of paths) for (const other of perFile.get(path) ?? []) named.add(other);
    names.set(name, named);
  }
  for (const [name, spans] of headers) {
    for (const base of every) {
      if (base === name || !spans.some((span) => mentions(span, base))) continue;
      subtypes.set(base, (subtypes.get(base) ?? new Set()).add(name));
    }
  }
  const graph = { names, subtypes, declared };
  graphCache.set(ctx, graph);
  return graph;
};

const reachableFrom = (graph: SubjectGraph, start: string): Set<string> => {
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

const resolveReachability = (ctx: ProbeContext, claim: FlowClaim): FlowClaimResolution => {
  const to = claim.to;
  if (!to) return { verdict: "unresolved", finding: "a reachability claim names no target" };
  if (claim.expect !== "absent") {
    // A POSITIVE reachability claim has no closed proof - finding one path says
    // nothing about the path the story draws - so it fails closed rather than
    // being answered by whatever the over-approximation happens to include.
    return {
      verdict: "unresolved",
      finding: "reachability establishes absence only; a positive claim needs a resolved call",
    };
  }
  const graph = subjectGraph(ctx);
  const start = simpleName(claim.from.owner ?? claim.from.name);
  const target = simpleName(to.owner ?? to.name);
  if (!graph.declared.has(start) || !graph.declared.has(target)) {
    const missing = graph.declared.has(start) ? target : start;
    return {
      verdict: "unresolved",
      finding: `the tree declares no ${missing} to close a reachability check over`,
    };
  }
  if (start === target) return { verdict: "contradicted", finding: `${start} reaches itself` };
  return reachableFrom(graph, start).has(target)
    ? {
        verdict: "unresolved",
        finding: `the closed symbol graph from ${start} reaches ${target}, so its absence is not established`,
      }
    : {
        verdict: "confirmed",
        finding: `no path in the subject-owned symbol graph takes ${start} to ${target}`,
      };
};

/* ------------------------------- container triggers and process launches */

/*
 * The three claim kinds PR 8 adds share one problem and one rule.
 *
 * The problem: none of them has a caller in the tree. A `@Scheduled` method is
 * reached because the container decided to, a listener because a broker did, and
 * a `main` because something outside the process started it. There is no call
 * site to re-resolve, so what the gate re-resolves instead is the DECLARATION
 * that establishes the trigger, and everything the entry box prints about it.
 *
 * The rule: this is an independent derivation, not a second reading of the
 * producer's answer. The producer took annotation nodes off a parse tree and
 * `packageByPath` off an index; every check below re-derives the same facts by
 * scanning the pinned blob, sharing only the vocabulary in `trigger.ts` and the
 * `ExecStart` reader in `unit.ts` - exactly as `normalizedRoute` is shared while
 * the two route derivations stay apart.
 */

/**
 * The parameter list of a method this span declares, or null.
 *
 * The paren-balance and the top-level comma split are the shared `readParenList`,
 * so a parameter carrying a parenthesised annotation (`@Header(name = "x")`) or a
 * bracket inside a string literal (`@Header("a)b")`) is read whole - the gate and
 * the producer cannot fail closed on different characters. `elements.length` is
 * the arity, generic commas not counted, because `<>` counts toward depth.
 */
const declaredParams = (span: string, ref: SymbolRef): ParenList | null => {
  const masked = maskedJava(span);
  const name = simpleName(ref.name);
  for (const open of masked.matchAll(new RegExp(`\\b${escaped(name)}\\s*\\(`, "g"))) {
    const list = readParenList(span, open.index + open[0].length - 1, masked);
    if (list === null) continue;
    if (ref.arity === undefined || list.elements.length === ref.arity) return list;
  }
  return null;
};

/** The first parameter's declared type, which is what an `@EventListener` subscribes to. */
const firstParameterType = (param: string): string | null => {
  // A declared type name is code, never inside a string literal, so reading it off
  // a length-preserving mask cannot lose it - while the mask stops a `)` inside a
  // parameter annotation's string (`@Header("x)")`) from cutting the strip early.
  const masked = maskedJava(param);
  const first = masked.trim().replace(/^(?:final\s+|@\w+(?:\([^)]*\))?\s+)+/, "");
  const type = first.split(/\s+/)[0];
  return type === undefined || type === "" ? null : simpleTypeName(type);
};

const STEREOTYPE_ANNOTATION = new RegExp(`@(?:${SPRING_STEREOTYPES.join("|")})\\b`);

/**
 * A container trigger, re-derived from the cited spans.
 *
 * Three things have to hold, and each of them is something the figure asserts:
 * the method really carries the annotation and declares the trigger the entry box
 * prints; its declaring type really is container-managed, so something actually
 * calls it; and, for a clock trigger, the subject really turns scheduling on.
 * Spring Boot autoconfigures the listener containers but NOT `@Scheduled`, so
 * dropping that last check would let a figure show an execution that never runs.
 */
const resolveContainerTrigger = (
  claim: FlowClaim,
  texts: Map<string, string[]>,
  family: "scheduled" | "message",
): FlowClaimResolution => {
  const trigger = claim.trigger;
  if (!trigger) {
    return { verdict: "unresolved", finding: `a ${claim.matcher} claim needs the trigger its entry box prints` };
  }
  const known =
    family === "scheduled"
      ? trigger.annotation === SCHEDULED_ANNOTATION
      : (MESSAGE_ANNOTATIONS as readonly string[]).includes(trigger.annotation);
  if (!known) {
    return {
      verdict: "contradicted",
      finding: `@${trigger.annotation} is not an annotation this matcher establishes a trigger from`,
    };
  }
  // Comments blanked, string literals kept: the trigger EXPRESSION is a string
  // the code declares, and `maskedJava` - which asks the opposite question -
  // would report every cron expression as empty.
  const spans = (texts.get(claim.from.path) ?? []).map(withoutComments);
  let declared: { attribute: string; text: string } | null = null;
  for (const span of spans) {
    const args = annotationArgsInText(span, trigger.annotation);
    if (args === null) continue;
    const params = declaredParams(span, claim.from);
    if (params === null) continue;
    declared =
      family === "scheduled"
        ? declaredTrigger(args)
        : declaredDestination(
            trigger.annotation as MessageAnnotation,
            args,
            firstParameterType(params.elements[0] ?? ""),
          );
    if (declared !== null) break;
  }
  const found =
    declared !== null &&
    declared.attribute === trigger.attribute &&
    declared.text === trigger.expression;
  if (claim.expect === "absent") {
    return found
      ? { verdict: "contradicted", finding: `${claim.from.name} still declares @${trigger.annotation}` }
      : {
          verdict: "unresolved",
          finding: "a cited annotation span is not a closed inventory and cannot establish absence",
        };
  }
  if (!found) {
    return {
      verdict: "contradicted",
      finding:
        declared === null
          ? `no cited span in ${claim.from.path} declares ${simpleName(claim.from.name)} under @${trigger.annotation}`
          : `${simpleName(claim.from.name)} declares @${trigger.annotation} ${declared.attribute} = ${declared.text}, not ${trigger.attribute} = ${trigger.expression}`,
    };
  }
  const owner = simpleName(claim.from.owner ?? "");
  const managed = spans.some(
    (span) =>
      STEREOTYPE_ANNOTATION.test(span) &&
      new RegExp(`\\b(?:class|record|enum)\\s+${escaped(owner)}\\b`).test(span),
  );
  if (!managed) {
    return {
      verdict: "contradicted",
      finding: `the cited spans do not establish ${owner} as a container-managed bean, so nothing calls its @${trigger.annotation} method`,
    };
  }
  if (family === "scheduled") {
    const enabled = [...texts.values()]
      .flat()
      .some((span) => new RegExp(`@${ENABLE_SCHEDULING_ANNOTATION}\\b`).test(withoutComments(span)));
    if (!enabled) {
      return {
        verdict: "contradicted",
        finding: `nothing cited declares @${ENABLE_SCHEDULING_ANNOTATION}, and Spring Boot does not enable scheduling on its own`,
      };
    }
  }
  return {
    verdict: "confirmed",
    finding: `${owner}.${simpleName(claim.from.name)} is triggered by @${trigger.annotation} ${trigger.attribute} = ${trigger.expression}`,
  };
};

/**
 * Whether a span declares a real program entry `main`, re-derived to accept
 * exactly what the producer's `mainEntries` accepts and no less.
 *
 * The modifiers are matched as a SET rather than in a fixed order: `static public
 * void main` and `public static final void main` are both legal Java and both are
 * what the producer draws, so hard-coding `public static void` would reject a
 * launch the producer legitimately established. What is NOT relaxed is the
 * requirement that both `public` and `static` are present and the return is
 * `void` with a single `String[]`/`String...` parameter - that signature is what
 * separates a program entry from a method named `main`. Scanned over a mask so a
 * `main(...)` inside a string cannot match.
 */
const MAIN_MODIFIER = "public|protected|private|static|final|synchronized|strictfp|abstract|native|default";
const declaresMainEntry = (span: string): boolean => {
  const re = new RegExp(
    `((?:\\b(?:${MAIN_MODIFIER})\\b\\s+)+)void\\s+main\\s*\\(\\s*(?:final\\s+)?String\\s*(?:\\[\\s*\\]|\\.\\.\\.)\\s*\\w+\\s*\\)`,
    "g",
  );
  for (const m of maskedJava(span).matchAll(re)) {
    const mods = m[1]!;
    if (/\bpublic\b/.test(mods) && /\bstatic\b/.test(mods)) return true;
  }
  return false;
};

/**
 * A process launch, re-derived from the unit blob and the `main` declaration.
 *
 * The unit is reread WHOLE rather than from the cited span, because `ExecStart`
 * only means anything inside a `[Service]` section and a span could be cited
 * around the directive while the section header sits above it. The cited span is
 * then required to cover the directive this reader found, so the claim and the
 * re-derivation are talking about the same line.
 */
const resolveProcessLaunch = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
): FlowClaimResolution => {
  const to = claim.to;
  const target = claim.launch?.target;
  if (!to || target === undefined) {
    return {
      verdict: "unresolved",
      finding: "a process_launch claim needs the class the unit names and the entry it lands on",
    };
  }
  const unit = ctx.read(claim.from.path);
  if (unit === null) {
    return { verdict: "unresolved", finding: `${claim.from.path} does not exist at ${ctx.sha}` };
  }
  const exec = execStart(unit);
  const names = exec === null ? [] : launchClassTokens(exec.command);
  const found = names.includes(target);
  if (claim.expect === "absent") {
    return found
      ? { verdict: "contradicted", finding: `${claim.from.path} still launches ${target}` }
      : {
          verdict: "unresolved",
          finding: "one unit's ExecStart is not a closed inventory and cannot establish absence",
        };
  }
  if (exec === null) {
    return {
      verdict: "contradicted",
      finding: `${claim.from.path} declares no ExecStart in a [Service] section`,
    };
  }
  if (!found) {
    return {
      verdict: "contradicted",
      finding: `${claim.from.path}'s ExecStart names ${names.length === 0 ? "no fully-qualified class" : names.join(", ")}, not ${target}`,
    };
  }
  const cites = claim.evidence.some(
    (e) =>
      e.path === claim.from.path &&
      (e.line_start ?? 1) <= exec.line_start &&
      (e.line_end ?? Number.MAX_SAFE_INTEGER) >= exec.line_end,
  );
  if (!cites) {
    return {
      verdict: "unresolved",
      finding: `the launch link does not cite ${claim.from.path}:${exec.line_start}-${exec.line_end}, the ExecStart it resolves`,
    };
  }
  const source = ctx.read(to.path);
  if (source === null) {
    return { verdict: "unresolved", finding: `${to.path} does not exist at ${ctx.sha}` };
  }
  const declaredPackage = /^\s*package\s+([\w.]+)\s*;/m.exec(maskedJava(source))?.[1] ?? "";
  // `declaredMains` keys a nested `main` on its in-file qualified path
  // (`Outer.Inner`), so the target is reconstructed from `to.owner` UNCHANGED
  // rather than reduced to its last segment - reducing it would drop the enclosing
  // class and contradict a launch the producer legitimately drew.
  const inFileName = to.owner ?? to.name;
  const qualified = declaredPackage === "" ? inFileName : `${declaredPackage}.${inFileName}`;
  if (qualified !== target) {
    return {
      verdict: "contradicted",
      finding: `the unit launches ${target}, but the arrow lands on ${qualified}`,
    };
  }
  const declaresMain = (texts.get(to.path) ?? []).some((span) => declaresMainEntry(span));
  return declaresMain
    ? {
        verdict: "confirmed",
        finding: `${claim.from.path} starts ${target} through a real main declaration`,
      }
    : {
        verdict: "contradicted",
        finding: `the cited span in ${to.path} declares no public static void main(String[]) for ${inFileName}`,
      };
};


/* ------------------------------------------- the Python halves (#52) */

/*
 * Four claim kinds get a Python re-derivation here: `direct_call`,
 * `data_access`, `closed_dispatch` and the route half of `spring_route`, plus the
 * one new matcher `declared_pipeline`. They are dispatched on the claim's own file
 * extension, which is the same seam `resolveSpringRoute` already uses to tell a
 * Java handler from a TypeScript caller.
 *
 * Everything below is this gate's OWN reading. It shares exactly two definitions
 * with the producer and nothing else: `normalizedRoute` ("the same route") and
 * `py-module.ts` ("what a file is importable as"). Both are shared for the reason
 * `manifests.ts` is - two sides that disagreed about what a module is CALLED would
 * quarantine correct arrows over spelling - while the resolutions stay split: the
 * producer walks a parse tree, this rereads the blob with regexes over a
 * length-preserving mask.
 *
 * Two things the Java resolvers check are deliberately NOT checked here:
 *
 * - **Arity.** Python has no overloading, and defaults plus keyword arguments make
 *   a call-site comma count a poor discriminator: `query_rows(session_id)` and
 *   `def query_rows(session_id, limit=50)` are the same function called two ways,
 *   and refusing that would refuse correct arrows. The claim still carries the
 *   number; nothing here rests on it.
 * - **A global type namespace.** Java can ask "which subject type is called
 *   `Store`"; Python cannot, because the answer is whatever the importing file
 *   said. So every check below is anchored in the CALLER'S OWN import statements
 *   and declarations, which is also exactly what a single blob can establish.
 */

const pyCache = new WeakMap<ProbeContext, Set<string>>();

/** The subject's package directories, computed once per context. */
const pyPackageDirs = (ctx: ProbeContext): Set<string> => {
  const cached = pyCache.get(ctx);
  if (cached) return cached;
  const dirs = packageDirsIn(ctx.paths.filter((path) => path.endsWith("__init__.py")));
  pyCache.set(ctx, dirs);
  return dirs;
};

/** Whether a claim's target is a module-level `def` rather than a class member. */
const isModuleOwned = (ref: SymbolRef): boolean =>
  ref.owner === undefined || simpleName(ref.owner) === moduleOwnerName(ref.path);

/** The block of source one `class` statement owns, by indentation. */
const pyClassBody = (source: string, masked: string, className: string): string | null => {
  const declaration = new RegExp(`^([ \\t]*)class[ \\t]+${escaped(className)}\\b`, "m").exec(masked);
  if (!declaration) return null;
  const indent = declaration[1]!.length;
  const lines = source.split("\n");
  const maskedLines = masked.split("\n");
  const at = masked.slice(0, declaration.index).split("\n").length - 1;
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = maskedLines[i] ?? "";
    if (line.trim() === "") {
      body.push(lines[i] ?? "");
      continue;
    }
    const lead = /^[ \t]*/.exec(line)![0].length;
    if (lead <= indent) break;
    body.push(lines[i] ?? "");
  }
  return body.join("\n");
};

const PY_DEF = (name: string, indented: boolean): RegExp =>
  new RegExp(`^${indented ? "[ \\t]+" : ""}(?:async[ \\t]+)?def[ \\t]+${escaped(name)}[ \\t]*\\(`, "m");

/**
 * Whether the blob says this file declares the claim's symbol.
 *
 * The two cases are told apart by comparing the claim's `owner` with the name the
 * shared `moduleOwnerName` gives its PATH, rather than by the claim declaring
 * which it is: a module-level `def` must sit at column zero, and a method must sit
 * inside the block its class owns. Reading the module case as "a `def` anywhere"
 * would let a closure nested in some unrelated function satisfy a module-level
 * claim.
 */
const pyDeclaresSymbol = (source: string, ref: SymbolRef): boolean => {
  const masked = maskedPython(source);
  const name = simpleName(ref.name);
  if (isModuleOwned(ref)) return PY_DEF(name, false).test(masked);
  const owner = simpleName(ref.owner!);
  const body = pyClassBody(source, masked, owner);
  if (body === null) return false;
  return PY_DEF(name, true).test(maskedPython(body));
};

/** Whether one cited SPAN declares a `def` by this name, at any indentation. */
const pySpanDeclaresDef = (span: string, name: string): boolean =>
  new RegExp(`(?:^|[ \\t])(?:async[ \\t]+)?def[ \\t]+${escaped(name)}[ \\t]*\\(`, "m").test(
    maskedPython(span),
  );

/** Whether the blob says this file declares `sub` as a class with base `base`. */
const pyDeclaresBase = (source: string, sub: string, base: string): boolean =>
  new RegExp(
    `^[ \\t]*class[ \\t]+${escaped(simpleName(sub))}[ \\t]*\\([^)]*\\b${escaped(simpleName(base))}\\b`,
    "m",
  ).test(maskedPython(source));

/**
 * The local names one file binds to another file, re-derived from its imports.
 *
 * Two answers, because the two mean different things at a call site: a MODULE
 * binding makes `decision_logs.query_rows(...)` a call on a module-level `def`,
 * while a SYMBOL binding makes `query_rows(...)` one. The symbol binding maps the
 * local name to the imported NAME, so a call written on an alias (`from mod import
 * run_job as go` then `go()`) is re-resolved to the def it names - the gate's half
 * of the producer's `bound.name`. Both are read off the caller's own import
 * statements, and the dotted names the target answers to come from the shared
 * `py-module.ts` definition - so the two sides cannot disagree about what a module
 * is called while still deriving the binding independently.
 */
const pyBindingsTo = (
  ctx: ProbeContext,
  fromPath: string,
  fromSource: string,
  targetPath: string,
): { modules: Set<string>; symbolNames: Map<string, string> } => {
  const modules = new Set<string>();
  const symbolNames = new Map<string, string>();
  const dotted = new Set(dottedNamesOf(targetPath, pyPackageDirs(ctx)));
  const masked = maskedPython(fromSource);

  // `from <module> import a as b, c` - one statement, which both #52 subjects
  // write parenthesised over a dozen lines, so the list is read to its own
  // terminator rather than to the end of the line. Reading it to the line end was
  // the first draft, and it resolved none of ftb's module-qualified calls.
  for (const match of masked.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+/gm)) {
    const moduleText = match[1]!;
    const after = match.index + match[0].length;
    const list = pyImportList(masked, after);
    const resolved = pyResolveModuleText(ctx, fromPath, moduleText);
    const imported = list
      .replace(/[()\\]/g, "")
      .split(",")
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0);
    for (const piece of imported) {
      const parts = /^([\w.]+)(?:[ \t]+as[ \t]+(\w+))?$/.exec(piece);
      if (!parts) continue;
      const name = parts[1]!;
      const local = parts[2] ?? name;
      // The imported name may itself be the target MODULE (`from webui import
      // decision_logs`), which is the more specific reading and is tried first.
      if (resolved !== null && dotted.has(`${resolved}.${name}`)) {
        modules.add(local);
        continue;
      }
      if (resolved !== null && dotted.has(resolved)) symbolNames.set(local, simpleName(name));
    }
  }

  for (const match of masked.matchAll(/^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+(\w+))?/gm)) {
    const moduleText = match[1]!;
    const alias = match[2];
    if (!dotted.has(moduleText)) continue;
    if (alias !== undefined) modules.add(alias);
    else if (!moduleText.includes(".")) modules.add(moduleText);
  }
  return { modules, symbolNames };
};

/**
 * The imported-names list of a `from ... import ...` statement starting at `at`.
 *
 * Three spellings, all of them in the two #52 subjects: a parenthesised list over
 * many lines, a backslash-continued list, and a plain one. A `*` import binds no
 * name and reads as an empty list, which is what fails closed.
 */
const pyImportList = (masked: string, at: number): string => {
  const rest = masked.slice(at);
  const open = /^\s*\(/.exec(rest);
  if (open) {
    const start = at + open[0].length - 1;
    const end = parenEnd(masked, start);
    return end < 0 ? "" : masked.slice(start + 1, end);
  }
  let end = at;
  for (;;) {
    const newline = masked.indexOf("\n", end);
    if (newline < 0) return masked.slice(at);
    // A backslash before the newline continues the statement onto the next line.
    if (!/\\[ \t]*$/.test(masked.slice(end, newline))) return masked.slice(at, newline);
    end = newline + 1;
  }
};

/**
 * A `from`-import's module text resolved to a dotted name, relative imports
 * included.
 *
 * A relative import states its own base - the importing file's package - so it is
 * resolved on the path rather than through the dotted table, exactly as the
 * producer resolves it.
 */
const pyResolveModuleText = (
  ctx: ProbeContext,
  fromPath: string,
  moduleText: string,
): string | null => {
  const dots = /^\.+/.exec(moduleText)?.[0].length ?? 0;
  if (dots === 0) return moduleText;
  const pieces = fromPath.replace(/\.py$/, "").split("/");
  const inPackage = pieces.slice(0, -1);
  const base = inPackage.slice(0, inPackage.length - (dots - 1));
  const tail = moduleText.slice(dots);
  const asPath = [...base, ...(tail === "" ? [] : tail.split("."))].join("/");
  const names = dottedNamesOf(`${asPath}.py`, pyPackageDirs(ctx));
  const packaged = dottedNamesOf(`${asPath}/__init__.py`, pyPackageDirs(ctx));
  return names[0] ?? packaged[0] ?? null;
};

/**
 * The optional annotation wrapper before the named type, matching the producer's
 * `TRANSPARENT` set (`annotationName`, `src/probes/python.ts`) exactly: `Optional`,
 * `type`, `Type`, `Final`, `Annotated`, `ClassVar`, plus a leading `None |` for the
 * union written in either order (`X | None` needs no prefix, since `X` is first),
 * and a forward-reference quote. A CONTAINER (`list[X]`, `Sequence[X]`) is
 * deliberately absent - the producer refuses to type a receiver as its element, so
 * the gate must not either.
 */
const PY_TRANSPARENT_PREFIX = `(?:(?:Optional|type|Type|Final|Annotated|ClassVar)\\s*\\[\\s*|None\\s*\\|\\s*|"|')?`;

/**
 * The receiver expressions this file types as `owner`.
 *
 * Five declaration shapes, and every one of them is a line in the file being
 * reread: an annotation, a construction, an annotated attribute, an attribute
 * assigned a construction, and an attribute assigned an annotated parameter. The
 * last is the shape `py-symbols.ts` calls the passthrough, and it is derived here
 * in two independent steps - which names the annotation carries, then which
 * attributes are assigned one of those names - rather than by trusting the
 * producer's reconstruction.
 *
 * The owner's own simple name is in the set because a class name IS a receiver: a
 * classmethod or a static call is written on it.
 */
const pyReceiverNames = (source: string, owner: string): Set<string> => {
  const simple = simpleName(owner);
  const masked = maskedPython(source);
  const names = new Set<string>([simple]);
  const annotated = new Set<string>();
  const typed = new RegExp(
    `(?:^|[(,\\s])(self\\s*\\.\\s*\\w+|\\w+)\\s*:\\s*${PY_TRANSPARENT_PREFIX}${escaped(simple)}\\b`,
    "g",
  );
  for (const match of masked.matchAll(typed)) {
    const bound = match[1]!.replace(/\s+/g, "");
    names.add(bound);
    if (!bound.startsWith("self.")) annotated.add(bound);
  }
  const constructed = new RegExp(
    `(self\\s*\\.\\s*\\w+|\\w+)\\s*(?::[^=\\n]*)?=\\s*${escaped(simple)}\\s*\\(`,
    "g",
  );
  for (const match of masked.matchAll(constructed)) names.add(match[1]!.replace(/\s+/g, ""));
  if (annotated.size > 0) {
    const passthrough = new RegExp(`(self\\s*\\.\\s*\\w+)\\s*=\\s*(\\w+)\\s*(?:$|[\\n#)])`, "gm");
    for (const match of masked.matchAll(passthrough)) {
      if (annotated.has(match[2]!)) names.add(match[1]!.replace(/\s+/g, ""));
    }
  }
  return names;
};

type PyReceiver =
  | { kind: "none" }
  /** A dotted receiver expression, whitespace removed: `store`, `self._driver`. */
  | { kind: "name"; receiver: string }
  /** A chained receiver: the dotted callee text of the call before the dot. */
  | { kind: "chained"; callee: string };

/** The receiver written immediately before a `.name(` call at `nameStart`. */
const pyReceiverBefore = (span: string, nameStart: number): PyReceiver => {
  let dot = nameStart - 1;
  while (dot >= 0 && /[ \t\r\n\\]/.test(span[dot]!)) dot -= 1;
  if (dot < 0 || span[dot] !== ".") return { kind: "none" };
  let before = dot - 1;
  while (before >= 0 && /[ \t\r\n\\]/.test(span[before]!)) before -= 1;
  if (before < 0) return { kind: "none" };
  if (span[before] === ")") {
    const open = parenStart(span, before);
    if (open < 0) return { kind: "none" };
    let callee = open - 1;
    while (callee >= 0 && /[ \t\r\n\\]/.test(span[callee]!)) callee -= 1;
    const dotted = pyDottedBefore(span, callee);
    return dotted === null ? { kind: "none" } : { kind: "chained", callee: dotted };
  }
  const dotted = pyDottedBefore(span, before);
  return dotted === null ? { kind: "none" } : { kind: "name", receiver: dotted };
};

/** The dotted identifier chain ending at `end`, whitespace removed, or null. */
const pyDottedBefore = (span: string, end: number): string | null => {
  let i = end;
  const pieces: string[] = [];
  for (;;) {
    let start = i;
    while (start >= 0 && /[\w$]/.test(span[start]!)) start -= 1;
    const piece = span.slice(start + 1, i + 1);
    if (!/^[A-Za-z_]\w*$/.test(piece)) return pieces.length === 0 ? null : pieces.join(".");
    pieces.unshift(piece);
    let back = start;
    while (back >= 0 && /[ \t\r\n\\]/.test(span[back]!)) back -= 1;
    if (back < 0 || span[back] !== ".") return pieces.join(".");
    i = back - 1;
    while (i >= 0 && /[ \t\r\n\\]/.test(span[i]!)) i -= 1;
    if (i < 0) return pieces.join(".");
  }
};

/**
 * Whether one of the cited caller spans resolves a call to `to`.
 *
 * Every accepted receiver shape is one #52 report 4.2 measured as re-derivable
 * within one file, and each is checked against the CALLER'S OWN source rather
 * than believed: an import statement, an annotation, a construction, an
 * `__init__` assignment, or a same-file `def` with a return annotation. A shape
 * this reader cannot name resolves nothing, which quarantines the Flow - the same
 * failure mode `hasTypedCall` has, and the reason the producer stops on the same
 * lines.
 */
const pyResolvesCall = (
  ctx: ProbeContext,
  fromSource: string,
  spans: string[],
  from: SymbolRef,
  to: SymbolRef,
): boolean => {
  const name = simpleName(to.name);
  const bindings = pyBindingsTo(ctx, from.path, fromSource, to.path);
  const sameFile = to.path === from.path;
  const moduleTarget = isModuleOwned(to);
  const receivers = moduleTarget ? new Set<string>() : pyReceiverNames(fromSource, to.owner!);
  // A module-level def may be called through an import alias (`from mod import
  // run_job as go` then `go()`), so the callee names searched include every local
  // the caller binds to THIS def - the gate's half of the producer's `bound.name`.
  const callNames = new Set<string>([name]);
  if (moduleTarget) {
    for (const [local, imported] of bindings.symbolNames) {
      if (imported === name) callNames.add(local);
    }
  }
  const call = new RegExp(`\\b(${[...callNames].map(escaped).join("|")})\\s*\\(`, "g");
  // A `self`/`cls` call resolves only WITHIN one file: two unrelated classes that
  // happen to share a simple name in two modules are not the same receiver, so the
  // simple-name branch carries the same `sameFile` guard the inherited-base branch
  // already does.
  const selfResolves =
    !moduleTarget &&
    from.owner !== undefined &&
    sameFile &&
    (simpleName(from.owner) === simpleName(to.owner!) ||
      pyDeclaresBase(fromSource, from.owner, to.owner!));
  const accessors = moduleTarget ? new Set<string>() : pyAccessorsReturning(fromSource, to.owner!);

  for (const span of spans) {
    const masked = maskedPython(span);
    for (const match of masked.matchAll(call)) {
      // A `def` of this name is a declaration, not a call to it.
      if (/(?:^|[ \t])def[ \t]+$/.test(masked.slice(Math.max(0, match.index - 12), match.index))) {
        continue;
      }
      const shape = pyReceiverBefore(masked, match.index);
      if (shape.kind === "none") {
        const callee = match[1]!;
        // Same-file calls use the def's own name; a cross-file call must reach it
        // through an import that binds that exact name, alias or not.
        if (
          moduleTarget &&
          ((sameFile && callee === name) || bindings.symbolNames.get(callee) === name)
        ) {
          return true;
        }
        continue;
      }
      if (shape.kind === "chained") {
        if (!moduleTarget && accessors.has(shape.callee)) return true;
        continue;
      }
      if (moduleTarget) {
        if (bindings.modules.has(shape.receiver)) return true;
        continue;
      }
      if (shape.receiver === "self" || shape.receiver === "cls") {
        if (selfResolves) return true;
        continue;
      }
      if (receivers.has(shape.receiver)) return true;
    }
  }
  return false;
};

/**
 * Bare `def`s this file declares as returning `type` - the one chained receiver
 * this gate can re-read, because the return annotation is written in the file it
 * is rereading.
 */
const pyAccessorsReturning = (source: string, type: string): Set<string> => {
  const names = new Set<string>();
  const declarations = new RegExp(
    `^(?:async[ \\t]+)?def[ \\t]+(\\w+)[ \\t]*\\([^\\n]*\\)[ \\t]*->[ \\t]*${PY_TRANSPARENT_PREFIX}${escaped(simpleName(type))}\\b`,
    "gm",
  );
  for (const match of maskedPython(source).matchAll(declarations)) names.add(match[1]!);
  return names;
};

const resolvePyDirectCall = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
): FlowClaimResolution => {
  const to = claim.to;
  if (!to) return { verdict: "unresolved", finding: "a direct_call claim names no target" };
  const fromSource = ctx.read(claim.from.path);
  const toSource = ctx.read(to.path);
  if (fromSource === null || toSource === null) {
    return { verdict: "unresolved", finding: "the caller or target source could not be read" };
  }
  if (!pyDeclaresSymbol(fromSource, claim.from)) {
    return {
      verdict: "contradicted",
      finding: `${claim.from.path} no longer declares ${claim.from.name}`,
    };
  }
  if (!pyDeclaresSymbol(toSource, to)) {
    return { verdict: "contradicted", finding: `${to.path} no longer declares ${to.name}` };
  }
  const spans = texts.get(claim.from.path) ?? [];
  if (spans.length === 0) {
    return {
      verdict: "unresolved",
      finding: `no cited span in ${claim.from.path} can establish the call`,
    };
  }
  const found = pyResolvesCall(ctx, fromSource, spans, claim.from, to);
  if (claim.expect === "absent") {
    return found
      ? { verdict: "contradicted", finding: `${claim.from.name} still calls ${to.name}` }
      : {
          verdict: "unresolved",
          finding: "a cited span is not a closed call graph and cannot establish absence",
        };
  }
  return found
    ? { verdict: "confirmed", finding: `${claim.from.name} resolves to ${to.name}` }
    : {
        verdict: "contradicted",
        finding: `the cited caller span does not resolve ${claim.from.name} to ${to.name}`,
      };
};

/**
 * A Python data-access arrow, re-derived from the two spans it cites.
 *
 * The arrow asserts two things and both are checked from the blob: that the
 * caller's cited line calls the target, and that the target's own DECLARATION
 * writes durable SQL of the claimed relation. The second is why the arrow cites
 * the target's declaration span - the SQL in that body is half of what the arrow
 * says, exactly as a lineage arrow cites the read whose SELECT it rests on.
 *
 * A name convention is deliberately not consulted. `sql.ts` records why for Java
 * and Python has no repository type to fall back on anyway: what makes
 * `Store.get_run` a read is the `SELECT` in its body, and nothing else here would
 * establish it.
 */
const resolvePyDataAccess = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
  relation: FlowRelation,
): FlowClaimResolution => {
  const to = claim.to!;
  const fromSource = ctx.read(claim.from.path);
  const toSource = ctx.read(to.path);
  if (fromSource === null || toSource === null) {
    return { verdict: "unresolved", finding: "the data caller or target source could not be read" };
  }
  if (!pyDeclaresSymbol(toSource, to)) {
    return { verdict: "contradicted", finding: `${to.path} no longer declares ${to.name}` };
  }
  const targetSpans = texts.get(to.path) ?? [];
  // The span is the METHOD, so only the `def` is looked for in it: the class the
  // method belongs to was already checked against the whole file above, and
  // demanding the `class` line inside a method's own span would refuse every
  // correct citation.
  const declared = targetSpans.filter((span) => pySpanDeclaresDef(span, simpleName(to.name)));
  if (declared.length === 0) {
    return {
      verdict: "unresolved",
      finding: `the arrow does not cite a span in ${to.path} that declares ${to.name}, so its durable access cannot be re-derived`,
    };
  }
  const sql = declared.some((span) =>
    relation === "read" ? readsDurably(span) : writesDurably(span),
  );
  const called = pyResolvesCall(ctx, fromSource, texts.get(claim.from.path) ?? [], claim.from, to);
  const found = sql && called;
  if (claim.expect === "absent") {
    return found
      ? { verdict: "contradicted", finding: `${claim.from.name} still ${relation}s ${to.name}` }
      : {
          verdict: "unresolved",
          finding: "a cited data-access span is not a closed reachability proof of absence",
        };
  }
  if (!sql) {
    return {
      verdict: "contradicted",
      finding: `the cited declaration of ${to.name} writes no SQL that ${relation}s durable storage`,
    };
  }
  return called
    ? { verdict: "confirmed", finding: `${claim.from.name} ${relation}s ${to.name} through its own SQL` }
    : {
        verdict: "contradicted",
        finding: `the cited caller span does not resolve ${claim.from.name} to ${to.name}`,
      };
};

/**
 * The `key: Value` pairs one module-level dict literal declares, or null.
 *
 * Read from the blob with this gate's own bracket balancing, so a registry whose
 * member count moved is CONTRADICTED rather than accepted: proving one member
 * exists says nothing about whether it is still the only thing the call can reach,
 * which is the whole point of the check.
 */
const pyRegistryPairs = (
  source: string,
  name: string,
): { key: string; value: string }[] | null => {
  const masked = pythonWithoutComments(source);
  const assignment = new RegExp(
    `^${escaped(name)}[ \\t]*(?::[^=\\n]*)?=[ \\t]*\\{`,
    "m",
  ).exec(masked);
  if (!assignment) return null;
  const open = assignment.index + assignment[0].length - 1;
  let depth = 0;
  let close = -1;
  const scan = maskedPython(source);
  for (let i = open; i < scan.length; i += 1) {
    const ch = scan[i];
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const inner = masked.slice(open + 1, close);
  const guard = scan.slice(open + 1, close);
  const pairs: { key: string; value: string }[] = [];
  let level = 0;
  let start = 0;
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < guard.length; i += 1) {
    const ch = guard[i];
    if (ch === "{" || ch === "[" || ch === "(") level += 1;
    else if (ch === "}" || ch === "]" || ch === ")") level -= 1;
    else if (ch === "," && level === 0) {
      ranges.push({ start, end: i });
      start = i + 1;
    }
  }
  ranges.push({ start, end: guard.length });
  for (const { start: s, end: e } of ranges) {
    const piece = inner.slice(s, e);
    if (piece.trim() === "") continue;
    // The key/value split is found on the STRING-MASKED copy, so a colon inside a
    // string key (`"http:get": Handler`) does not split the piece inside its own
    // literal - the same masked copy the bracket balancing and comma splitting use.
    const split = guard.slice(s, e).indexOf(":");
    if (split < 0) return null;
    pairs.push({ key: piece.slice(0, split).trim(), value: piece.slice(split + 1).trim() });
  }
  return pairs;
};

/**
 * A Python closed dispatch, re-derived from the registry literal (#52 D3).
 *
 * v1 ships exactly one closure rule and this is its check. The set is a
 * module-level dict literal, so the gate re-enumerates the whole literal from the
 * blob and refuses a claim whose member count moved, refuses a label no key
 * carries, and refuses a target no value names - then requires the caller's own
 * cited spans to subscript that registry and call the method on what came out.
 * Proving `SignalRecord.from_dict` exists says nothing about whether the four
 * payload types are still the only things that call can reach.
 */
const resolvePyClosedDispatch = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
): FlowClaimResolution => {
  const to = claim.to!;
  const dispatch = claim.dispatch!;
  if (dispatch.via !== "keyed_registry") {
    return {
      verdict: "unresolved",
      finding: `a Python dispatch closed by ${dispatch.via} has no re-derivation in v1; #52 D3 ships the keyed registry alone`,
    };
  }
  const registrySource = ctx.read(dispatch.base.path);
  const fromSource = ctx.read(claim.from.path);
  const toSource = ctx.read(to.path);
  if (registrySource === null || fromSource === null || toSource === null) {
    return { verdict: "unresolved", finding: "the registry, caller or target source could not be read" };
  }
  const registry = simpleName(dispatch.base.name);
  const pairs = pyRegistryPairs(registrySource, registry);
  if (pairs === null) {
    return {
      verdict: "contradicted",
      finding: `${dispatch.base.path} no longer declares ${registry} as a module-level dict literal`,
    };
  }
  if (pairs.length !== dispatch.member_count) {
    return {
      verdict: "contradicted",
      finding: `${registry} now holds ${pairs.length} members, not the ${dispatch.member_count} this arrow closed the set at`,
    };
  }
  const keys = new Set(pairs.map((pair) => pair.key));
  const missing = dispatch.labels.filter((label) => !keys.has(label));
  if (missing.length > 0) {
    return {
      verdict: "contradicted",
      finding: `${registry} declares no key ${missing.join(", ")}`,
    };
  }
  const owner = simpleName(to.owner ?? to.name);
  if (!pairs.some((pair) => pair.value === owner)) {
    return {
      verdict: "contradicted",
      finding: `${owner} is not among the ${pairs.length} members ${registry} holds`,
    };
  }
  if (!pyDeclaresSymbol(toSource, to)) {
    return { verdict: "contradicted", finding: `${to.path} no longer declares ${to.name}` };
  }
  const spans = texts.get(claim.from.path) ?? [];
  if (spans.length === 0) {
    return { verdict: "unresolved", finding: `no cited span in ${claim.from.path} can establish the dispatch` };
  }
  // The selection and the call are two lines, so the arrow cites both: one span
  // subscripts the registry into a name, and one calls the method on that name.
  const selected = new Set<string>();
  const subscript = new RegExp(`(\\w+)[ \\t]*=[ \\t]*${escaped(registry)}[ \\t]*\\[`, "g");
  for (const span of spans) {
    for (const match of maskedPython(span).matchAll(subscript)) selected.add(match[1]!);
  }
  if (selected.size === 0) {
    return {
      verdict: "contradicted",
      finding: `no cited span in ${claim.from.path} selects a member out of ${registry}`,
    };
  }
  const name = simpleName(to.name);
  const dispatched = spans.some((span) => {
    const masked = maskedPython(span);
    return [...masked.matchAll(new RegExp(`\\b${escaped(name)}\\s*\\(`, "g"))].some((match) => {
      const shape = pyReceiverBefore(masked, match.index);
      return shape.kind === "name" && selected.has(shape.receiver);
    });
  });
  if (claim.expect === "absent") {
    return {
      verdict: "unresolved",
      finding: "a dispatch arrow cannot express absence; a closed negative claim is a reachability check",
    };
  }
  return dispatched
    ? {
        verdict: "confirmed",
        finding: `${claim.from.name} dispatches ${name} into ${owner} through ${registry} (keyed_registry, ${pairs.length} members)`,
      }
    : {
        verdict: "contradicted",
        finding: `the cited caller span does not call ${name} on a member selected out of ${registry}`,
      };
};

/**
 * A declared pipeline arrow or entry, re-derived from the topology's own literals
 * (#52, D2).
 *
 * Four things, and each is one of the four #52 report 5.1 names: the edge names
 * both keys as string literals; each key was registered by an `add_node` carrying
 * that literal and a bare identifier; that identifier is declared as a `def` in
 * the same file; and the entry key came from `set_entry_point` or an edge out of
 * `START`. The `def` is looked for anywhere in the file rather than at column zero,
 * because the reference subject declares its node functions as closures inside the
 * builder - which is the same question both sides ask, and deliberately not the
 * module-level question `direct_call` asks.
 */
const resolveDeclaredPipeline = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
): FlowClaimResolution => {
  const to = claim.to;
  const pipeline = claim.pipeline;
  if (!to || !pipeline) {
    return { verdict: "unresolved", finding: "a declared_pipeline claim names no target or no node keys" };
  }
  if (claim.expect === "absent") {
    return {
      verdict: "unresolved",
      finding: "a declared topology cannot express absence; a missing edge is simply not declared",
    };
  }
  const isEntry = pipeline.entry_key !== undefined;
  const isEdge = pipeline.from_key !== undefined && pipeline.to_key !== undefined;
  if (isEntry === isEdge) {
    return {
      verdict: "unresolved",
      finding: "a declared_pipeline claim must carry either an entry key or both edge keys, never both shapes and never neither",
    };
  }
  if (claim.from.path !== to.path) {
    return {
      verdict: "contradicted",
      finding: "a declared topology is one file's declaration, and this claim spans two",
    };
  }
  const source = ctx.read(to.path);
  if (source === null) {
    return { verdict: "unresolved", finding: `${to.path} does not exist at ${ctx.sha}` };
  }
  const spans = (texts.get(to.path) ?? []).map(pythonWithoutComments);
  if (spans.length === 0) {
    return { verdict: "unresolved", finding: `no cited span in ${to.path} can establish the topology` };
  }
  const declaresDef = (name: string): boolean =>
    new RegExp(`(?:^|[ \\t])(?:async[ \\t]+)?def[ \\t]+${escaped(name)}[ \\t]*\\(`, "m").test(
      maskedPython(source),
    );
  const registered = (key: string, symbol: string): boolean =>
    spans.some(
      (span) =>
        new RegExp(
          `add_node\\s*\\(\\s*(['"])${escaped(key)}\\1\\s*,\\s*${escaped(symbol)}\\s*[,)]`,
        ).test(span) ||
        // The single-argument `add_node(<fn>)` form infers the key from the
        // function name, so key and symbol are the one identifier - matched only
        // when they agree, exactly as the producer derives the key.
        (key === symbol &&
          new RegExp(`add_node\\s*\\(\\s*${escaped(symbol)}\\s*[,)]`).test(span)),
    );

  if (isEntry) {
    const key = pipeline.entry_key!;
    const declaredEntry = spans.some(
      (span) =>
        new RegExp(`set_entry_point\\s*\\(\\s*(['"])${escaped(key)}\\1\\s*\\)`).test(span) ||
        new RegExp(`add_edge\\s*\\(\\s*START\\s*,\\s*(['"])${escaped(key)}\\1\\s*\\)`).test(span),
    );
    if (!declaredEntry) {
      return {
        verdict: "contradicted",
        finding: `no cited span in ${to.path} declares "${key}" as the topology's entry point`,
      };
    }
    if (!registered(key, simpleName(to.name))) {
      return {
        verdict: "contradicted",
        finding: `no cited span registers the node "${key}" as ${simpleName(to.name)}`,
      };
    }
    if (!declaresDef(simpleName(to.name))) {
      return {
        verdict: "contradicted",
        finding: `${to.path} declares no def ${simpleName(to.name)} for the node "${key}"`,
      };
    }
    return {
      verdict: "confirmed",
      finding: `${to.path} declares "${key}" as its entry, registered as ${simpleName(to.name)}`,
    };
  }

  const fromKey = pipeline.from_key!;
  const toKey = pipeline.to_key!;
  const drawn = spans.some((span) =>
    new RegExp(
      `add_edge\\s*\\(\\s*(['"])${escaped(fromKey)}\\1\\s*,\\s*(['"])${escaped(toKey)}\\2\\s*\\)`,
    ).test(span),
  );
  if (!drawn) {
    return {
      verdict: "contradicted",
      finding: `no cited span in ${to.path} declares an edge from "${fromKey}" to "${toKey}"`,
    };
  }
  for (const [key, symbol] of [
    [fromKey, simpleName(claim.from.name)],
    [toKey, simpleName(to.name)],
  ] as const) {
    if (!registered(key, symbol)) {
      return {
        verdict: "contradicted",
        finding: `no cited span registers the node "${key}" as ${symbol}`,
      };
    }
    if (!declaresDef(symbol)) {
      return {
        verdict: "contradicted",
        finding: `${to.path} declares no def ${symbol} for the node "${key}"`,
      };
    }
  }
  return {
    verdict: "confirmed",
    finding: `${to.path} declares the edge "${fromKey}" -> "${toKey}" between two registered node defs`,
  };
};

const PY_VERBS = "get|post|put|patch|delete|head|options";

/**
 * The endpoint a FastAPI handler declares, composed with the prefix the subject's
 * own wiring gives it - re-derived from the CITED SPANS and nothing else.
 *
 * The decorator is required to sit immediately above the `def` it names, which is
 * what the language means by decorating it. The prefix is composed from the other
 * spans the claim cites, and each is identified by what it IS rather than by the
 * claim saying which is which: an `APIRouter(...)` span is the construction and an
 * `include_router(...)` span is the mount. A `prefix=` that is not one string
 * literal reads as no endpoint at all, which quarantines the Flow rather than
 * admitting a route composed from a guess.
 */
/**
 * The `local -> imported simple name` map one file's `from ... import` statements
 * declare, so an aliased router (`from routes import router as r`) is compared by
 * the name the producer resolved it to (`router`), not by the call-site alias.
 * The producer resolves the same alias through the file's own bindings, so the two
 * sides agree on which router a mount names.
 */
const pyImportAliases = (source: string): Map<string, string> => {
  const out = new Map<string, string>();
  const masked = maskedPython(source);
  for (const match of masked.matchAll(/^[ \t]*from[ \t]+[.\w]+[ \t]+import[ \t]+/gm)) {
    const after = match.index + match[0].length;
    const list = pyImportList(masked, after);
    for (const piece of list
      .replace(/[()\\]/g, "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)) {
      const parts = /^([\w.]+)(?:[ \t]+as[ \t]+(\w+))?$/.exec(piece);
      if (!parts) continue;
      out.set(parts[2] ?? parts[1]!, simpleName(parts[1]!));
    }
  }
  return out;
};

const pythonRouteEndpoint = (
  ctx: ProbeContext,
  claim: FlowClaim,
  texts: Map<string, string[]>,
  ref: SymbolRef,
): { method: string; path: string } | null => {
  const spans = (texts.get(ref.path) ?? []).map(pythonWithoutComments);
  const name = simpleName(ref.name);
  let declared: { method: string; path: string; router: string } | null = null;
  for (const span of spans) {
    const decorator = new RegExp(
      `@\\s*(\\w+)\\s*\\.\\s*(${PY_VERBS})\\s*\\(\\s*(['"])([^'"\\n]*)\\3[\\s\\S]*?\\)\\s*(?:@[^\\n]*\\s*)*(?:async[ \\t]+)?def[ \\t]+${escaped(name)}[ \\t]*\\(`,
    ).exec(span);
    if (!decorator) continue;
    if (declared !== null) return null;
    // The decorator names the router variable the route is written on; the prefix
    // is only composed from spans that name THAT SAME router, so a module holding
    // two routers cannot lend one's prefix to the other's routes.
    declared = { method: decorator[2]!.toUpperCase(), path: decorator[4]!, router: decorator[1]! };
  }
  if (declared === null) return null;
  const router = declared.router;

  // The `prefix=` literal on a span: "" for none, or null when one is written but
  // is not a single string literal - which quarantines the route, exactly as the
  // producer cuts it `dynamic_route_prefix:` rather than composing a guess.
  const prefixOf = (span: string): string | null => {
    const literal = /(?:^|[(,\s])prefix\s*=\s*(['"])([^'"\n]*)\1/.exec(span);
    if (literal !== null) return literal[2]!;
    return /(?:^|[(,\s])prefix\s*=/.test(span) ? null : "";
  };

  let mount = "";
  let construction = "";
  for (const [mountPath, raw] of texts) {
    // A bare-identifier router argument may be an alias, so it is resolved through
    // the mounting file's own imports before the comparison - the same alias the
    // producer resolved through the file's bindings.
    const aliases = pyImportAliases(ctx.read(mountPath) ?? "");
    for (const span of raw.map(pythonWithoutComments)) {
      // The construction assigns `APIRouter(...)` to the router's own name; the
      // mount passes that same name - bare `router`, an alias, or `<module>.router`
      // - to `include_router`. A span naming a different router contributes nothing,
      // which is how the gate re-derives the identity the producer resolved.
      if (new RegExp(`\\b${escaped(router)}\\s*=\\s*APIRouter\\s*\\(`).test(span)) {
        const literal = prefixOf(span);
        if (literal === null) return null;
        construction = literal;
      }
      const mounted = /\binclude_router\s*\(\s*([\w.]+)/.exec(span);
      if (mounted !== null) {
        const token = mounted[1]!;
        const resolved = token.includes(".")
          ? token.split(".").pop()!
          : aliases.get(token) ?? token;
        if (resolved === router) {
          const literal = prefixOf(span);
          if (literal === null) return null;
          mount = literal;
        }
      }
    }
  }
  return { method: declared.method, path: normalizedPath(`${mount}${construction}/${declared.path}`) };
};

export const resolveFlowClaim = (
  ctx: ProbeContext,
  link: FlowLink | undefined,
  claim: FlowClaim,
): FlowClaimResolution => {
  const checked = checkedEvidence(ctx, claim.evidence);
  if (checked.problem) return { verdict: "unresolved", finding: checked.problem };
  const compatible = MATCHER_RELATIONS[claim.matcher];
  if (!compatible) {
    return { verdict: "unresolved", finding: `unknown Flow matcher ${String(claim.matcher)}` };
  }
  if (link && !compatible.has(link.relation)) {
    return {
      verdict: "contradicted",
      finding: `matcher ${claim.matcher} cannot establish relation ${link.relation}`,
    };
  }
  switch (claim.matcher) {
    case "direct_call":
      return claim.from.path.endsWith(".py")
        ? resolvePyDirectCall(ctx, claim, checked.texts!)
        : resolveDirectCall(ctx, claim, checked.texts!);
    case "spring_route":
      return resolveSpringRoute(ctx, claim, checked.texts!);
    case "data_access":
      if (!link || (link.relation !== "read" && link.relation !== "write")) {
        return { verdict: "contradicted", finding: "data_access requires a typed read or write link" };
      }
      return claim.from.path.endsWith(".py")
        ? resolvePyDataAccess(ctx, claim, checked.texts!, link.relation)
        : resolveDataAccess(ctx, claim, checked.texts!, link.relation);
    case "closed_dispatch":
      // The Java resolver names its own refusals for a claim missing a target or a
      // declared set, and a fixture asserts each of those sentences; the Python
      // one is reached only when both are present.
      if (!claim.from.path.endsWith(".py") || !claim.to || !claim.dispatch) {
        return resolveClosedDispatch(ctx, claim, checked.texts!);
      }
      return resolvePyClosedDispatch(ctx, claim, checked.texts!);
    case "data_lineage":
      if (!link || link.relation !== "read") {
        return { verdict: "contradicted", finding: "data_lineage requires a typed read link" };
      }
      return resolveDataLineage(ctx, claim, checked.texts!);
    case "scheduled_trigger":
      return resolveContainerTrigger(claim, checked.texts!, "scheduled");
    case "message_listener":
      return resolveContainerTrigger(claim, checked.texts!, "message");
    case "process_launch":
      if (!link || link.relation !== "transport") {
        return { verdict: "contradicted", finding: "process_launch requires a typed transport link" };
      }
      return resolveProcessLaunch(ctx, claim, checked.texts!);
    case "declared_pipeline":
      return resolveDeclaredPipeline(ctx, claim, checked.texts!);
    case "reachability":
      return resolveReachability(ctx, claim);
  }
};

const evidenceProblem = (ctx: ProbeContext, owner: string, evidence: Evidence): string | null => {
  if (evidence.kind === "issue") return `${owner} cites an issue rather than observed behaviour`;
  if (evidence.kind === "command") {
    return evidence.cmd.trim() === "" || evidence.output_excerpt.trim() === ""
      ? `${owner} carries an empty command citation`
      : null;
  }
  const checked = checkedEvidence(ctx, [evidence]);
  return checked.problem ? `${owner}: ${checked.problem}` : null;
};

const stepNamesSymbol = (flow: FlowNode, stepId: string, ref: SymbolRef): boolean => {
  const step = flow.steps.find((candidate) => candidate.id === stepId);
  if (!step) return false;
  const rendered = `${step.node} ${step.detail ?? ""}`.toLowerCase();
  const names = [ref.name, ref.owner ?? ""].flatMap((name) => {
    const simple = simpleName(name);
    return [simple, ...simple.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")];
  });
  return names.some((name) => name.length >= 4 && rendered.includes(name.toLowerCase()));
};

const quarantined = (
  candidate: Candidate,
  finding: string,
  verdict: "unresolved" | "overturned" = "unresolved",
) => ({
  probe_id: candidate.probe_id,
  node: { ...candidate.node, confidence: "absent" as const },
  verdict,
  finding: `Flow ${candidate.node.id} quarantined atomically: ${finding}`,
});

export const gateFlowCandidate = (ctx: ProbeContext, candidate: Candidate) => {
  const flow = candidate.node as FlowNode;
  if (flow.confidence === "absent") {
    // The producer already established it could not establish the chain. The
    // gate refuses to promote it either way, and carries the producer's own
    // reason so the absent cut says which failure this was rather than being
    // flattened into one generic refusal (#6).
    return quarantined(
      candidate,
      candidate.absent_reason === undefined
        ? "the producer proposed it as absent; no partial chain may be promoted"
        : `the producer proposed it as absent (${candidate.absent_reason}); no partial chain may be promoted`,
    );
  }
  if ((candidate.claims?.length ?? 0) > 0) {
    return quarantined(candidate, "Flow relationships must use atomic flow_claims, not generic existence claims");
  }

  const topology = flowTopologyProblems(flow, true);
  if (topology.length > 0) return quarantined(candidate, topology[0]!);

  for (const step of flow.steps) {
    const problem = step.evidence ? evidenceProblem(ctx, `step ${step.id}`, step.evidence) : null;
    if (problem) return quarantined(candidate, problem);
  }
  for (const link of flow.links!) {
    for (const evidence of Array.isArray(link.evidence) ? link.evidence : []) {
      const problem = evidenceProblem(ctx, `link ${link.id}`, evidence);
      if (problem) return quarantined(candidate, problem);
    }
  }

  const claims = candidate.flow_claims ?? [];
  if (
    flow.caption !== undefined &&
    ABSENCE_SHAPED.test(flow.caption) &&
    !claims.some((claim) => claim.link_id === undefined && claim.expect === "absent")
  ) {
    return quarantined(
      candidate,
      "the caption makes a negative claim but carries no closed expect:absent Flow claim",
    );
  }
  const byLink = new Map<string, FlowClaim[]>();
  for (const claim of claims) {
    if (claim.link_id === undefined) continue;
    byLink.set(claim.link_id, [...(byLink.get(claim.link_id) ?? []), claim]);
  }
  const knownLinks = new Set(flow.links!.map((l) => l.id));
  const danglingClaim = claims.find((c) => c.link_id !== undefined && !knownLinks.has(c.link_id));
  if (danglingClaim?.link_id) {
    return quarantined(candidate, `claim names missing link ${danglingClaim.link_id}`);
  }

  for (const link of flow.links!) {
    const linkClaims = byLink.get(link.id) ?? [];
    if (linkClaims.length === 0) {
      return quarantined(candidate, `link ${link.id} has no atomic claim`);
    }
    if (!linkEvidenceMatchesClaims(link, linkClaims)) {
      return quarantined(
        candidate,
        `link ${link.id}'s file evidence differs from the evidence the gate was asked to resolve`,
      );
    }
    if (linkClaims.some((claim) => claim.matcher === "data_lineage")) {
      const problem = lineageLabelProblem(ctx, link, linkClaims);
      if (problem) return quarantined(candidate, `link ${link.id}: ${problem}`, "overturned");
    }
    for (const claim of linkClaims) {
      if (claim.expect !== "present") {
        return quarantined(candidate, `link ${link.id} is rendered but its claim expects it to be absent`);
      }
      if (!claim.to) {
        return quarantined(candidate, `link ${link.id} has no target symbol to resolve`);
      }
      const [sourceStep, targetStep] = REVERSED.has(claim.matcher)
        ? [link.to, link.from]
        : [link.from, link.to];
      if (!stepNamesSymbol(flow, sourceStep, claim.from) || !stepNamesSymbol(flow, targetStep, claim.to)) {
        return quarantined(
          candidate,
          `link ${link.id}'s source symbols do not agree with the rendered endpoint steps`,
          "overturned",
        );
      }
      const result = resolveFlowClaim(ctx, link, claim);
      if (result.verdict !== "confirmed") {
        return quarantined(
          candidate,
          `link ${link.id}: ${result.finding}`,
          result.verdict === "contradicted" ? "overturned" : "unresolved",
        );
      }
    }
  }

  for (const claim of claims.filter((c) => c.link_id === undefined)) {
    const result = resolveFlowClaim(ctx, undefined, claim);
    if (result.verdict !== "confirmed") {
      return quarantined(
        candidate,
        `caption claim (${claim.matcher}): ${result.finding}`,
        result.verdict === "contradicted" ? "overturned" : "unresolved",
      );
    }
  }

  return {
    probe_id: candidate.probe_id,
    node: { ...flow, confidence: "verified" as const },
    verdict: "confirmed" as const,
    finding: `Flow ${flow.id}: ${flow.links!.length} links independently resolved; the complete chain is verified`,
  };
};
