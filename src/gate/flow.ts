/**
 * Flow-specific existence gate (#35, accepted design section 6.1).
 *
 * A Flow is one atomic behavioural claim. The producer may propose a complete
 * graph and one claim per arrow; this module rereads the pinned tree and either
 * verifies the whole graph or quarantines the whole graph as `absent`. It never
 * returns a shortened path and never turns extractor uncertainty into a subject
 * divergence.
 */
import { isSourceFile } from "../harvest/tree.js";
import { normalizedRoute } from "../probes/flow/route.js";
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
  reachability: new Set(),
};

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

const linkEvidenceMatchesClaim = (link: FlowLink, claim: FlowClaim): boolean => {
  const proposed = new Set(claim.evidence.map(evidenceKey));
  const rendered = (Array.isArray(link.evidence) ? link.evidence : []).filter(
    (e): e is FileEvidence => e.kind === "file",
  );
  return rendered.length === proposed.size && rendered.every((e) => proposed.has(evidenceKey(e)));
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
  // not a declared name the file binds.
  if (writtenOn !== undefined) {
    const constructed = new RegExp(
      `\\bnew\\s+(?:[\\w$]+\\s*\\.\\s*)*${escaped(simpleName(writtenOn))}\\s*(?:<[^;{}()]*>)?\\s*\\([^()]{0,200}\\)\\s*\\.\\s*${escaped(name)}\\s*\\(`,
      "g",
    );
    for (const span of callSpans) {
      for (const match of span.matchAll(constructed)) {
        const callOpen = match.index + match[0].length - 1;
        if (to.arity === undefined || argumentCounts(span, callOpen).has(to.arity)) return true;
      }
    }
  }
  const occurrence = new RegExp(
    `(?:(?<receiver>[A-Za-z_$][\\w$]*)\\s*(?<call>\\([^()]{0,200}\\))?\\s*\\.\\s*)?\\b${escaped(name)}\\s*\\(`,
    "g",
  );
  for (const span of callSpans) {
    for (const match of span.matchAll(occurrence)) {
      const receiver = match.groups?.["receiver"];
      const chained = match.groups?.["call"] !== undefined;
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
      // The pattern ends at the call's own `(`, so its position is exact. Finding
      // it by searching for the method name would land inside a receiver that
      // merely starts with it - `graderFor(x).grade(...)` counting `graderFor`'s
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

const clientEstablishes = (
  spans: string[],
  protocol: NonNullable<SymbolRef["protocol"]>,
): boolean => {
  const wantedPath = normalizedPath(protocol.path);
  for (const span of spans) {
    const paths = [...span.matchAll(/["'`]((?:\/|https?:\/\/)[^"'`]*)["'`]/g)].map((m) => {
      const raw = m[1] ?? "";
      try {
        return normalizedPath(raw.startsWith("http") ? new URL(raw).pathname : raw);
      } catch {
        return normalizedPath(raw);
      }
    });
    if (!paths.includes(wantedPath)) continue;
    const explicit = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i.exec(span)?.[1];
    if ((explicit ?? "GET").toUpperCase() === protocol.method) return true;
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
  const fromMatches = claim.from.path.endsWith(".java")
    ? endpointEquals(springEndpoint(fromSource, claim.from), claim.from.protocol)
    : clientEstablishes(texts.get(claim.from.path) ?? [], claim.from.protocol);
  const toMatches = endpointEquals(springEndpoint(toSource, to), to.protocol);
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
const implementationsInTree = (ctx: ProbeContext, base: string): { path: string; name: string }[] => {
  const found: { path: string; name: string }[] = [];
  const named = new Set<string>([simpleName(base)]);
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
  switch (dispatch.via) {
    case "sole_implementation":
      return memberCount === 1
        ? null
        : `${baseName} is claimed to have a sole implementation but the tree holds ${memberCount}`;
    case "sealed_guard": {
      const missing = dispatch.labels.filter(
        (label) => !new RegExp(`instanceof\\s+${escaped(label).replace(/\\\./g, "\\.")}\\b`).test(toSource),
      );
      return missing.length === 0
        ? null
        : `${dispatch.base.path}'s implementation no longer guards on ${missing.join(", ")}`;
    }
    case "keyed_registry": {
      const missing = dispatch.labels.filter(
        (label) => !new RegExp(`\\breturn\\s*\\(?\\s*${escaped(label)}\\s*\\)?\\s*;`).test(toSource),
      );
      return missing.length === 0 ? null : `the implementation no longer returns the key ${missing.join(", ")}`;
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

const STEREOTYPE = /@(?:Component|Service|Repository|Controller|RestController|Configuration)\b/;

const READ_METHOD = /^(?:find|get|read|load|select|exists|count|query|fetch|lookup|search)/i;
const WRITE_METHOD = /^(?:save|write|insert|update|delete|remove|persist|store|upsert|merge)/i;

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
  const conventionMatches = relation === "read" ? READ_METHOD.test(method) : WRITE_METHOD.test(method);
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

export const resolveFlowClaim = (
  ctx: ProbeContext,
  link: FlowLink | undefined,
  claim: FlowClaim,
): FlowClaimResolution => {
  const checked = checkedEvidence(ctx, claim.evidence);
  if (checked.problem) return { verdict: "unresolved", finding: checked.problem };
  if (link && !linkEvidenceMatchesClaim(link, claim)) {
    return {
      verdict: "unresolved",
      finding: "the link's file evidence differs from the evidence the gate was asked to resolve",
    };
  }
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
      return resolveDirectCall(ctx, claim, checked.texts!);
    case "spring_route":
      return resolveSpringRoute(ctx, claim, checked.texts!);
    case "data_access":
      if (!link || (link.relation !== "read" && link.relation !== "write")) {
        return { verdict: "contradicted", finding: "data_access requires a typed read or write link" };
      }
      return resolveDataAccess(ctx, claim, checked.texts!, link.relation);
    case "closed_dispatch":
      return resolveClosedDispatch(ctx, claim, checked.texts!);
    case "reachability":
      // A closed negative reachability proof arrives with the shared-state
      // fan-out in PR 7. Accepting a lexical approximation here would pre-authorize
      // exactly the negative claims that phase has to prove.
      return {
        verdict: "unresolved",
        finding: `matcher ${claim.matcher} has no closed-set resolver in this phase and therefore fails closed`,
      };
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
    if (linkClaims.length !== 1) {
      return quarantined(
        candidate,
        `link ${link.id} has ${linkClaims.length} atomic claims; exactly one is required`,
      );
    }
    const claim = linkClaims[0]!;
    if (claim.expect !== "present") {
      return quarantined(candidate, `link ${link.id} is rendered but its claim expects it to be absent`);
    }
    if (!claim.to) {
      return quarantined(candidate, `link ${link.id} has no target symbol to resolve`);
    }
    if (!stepNamesSymbol(flow, link.from, claim.from) || !stepNamesSymbol(flow, link.to, claim.to)) {
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
