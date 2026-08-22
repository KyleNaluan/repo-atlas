/**
 * The narrow TypeScript/TSX HTTP-call adapter (#35, accepted design 5.1 and 5.2).
 *
 * This is the one cross-language seam the parity-first scope (#38) needs: the
 * hand-made reference story starts in the editor, and until a real caller exists
 * the Spring route can only be claimed at caption level - which is exactly what
 * PR 4 recorded as a deferral, because "a transport link needs a real caller".
 *
 * Two things make it narrow on purpose:
 *
 * - There is no vendored TypeScript grammar, and the accepted design refuses a
 *   multi-toolchain overreach (#5, report 4). So this reads TS/TSX LEXICALLY -
 *   comments, strings and template substitutions are masked before any structural
 *   scan - and it refuses everything it cannot pin exactly. A path built from a
 *   variable, a concatenation, or an options object it cannot read is a NAMED
 *   absence, never a guess (#6).
 * - A call is an HTTP call only when the subject's own wiring says so: `fetch`
 *   itself, or a function this subject declares that forwards its first parameter
 *   into `fetch`'s URL and adds no literal path text of its own. That is the same
 *   shape as closed-set dispatch - the set is closed by the tree, not by a name
 *   the adapter recognises - and it is why `apiFetch` can be followed while an
 *   arbitrary helper called `get` cannot.
 *
 * The producer resolves no further than the gate can independently re-resolve.
 * The gate re-derives the endpoint from the CITED SPAN alone, with its own
 * scanner (`src/gate/flow.ts`), so this module shares only the two DEFINITIONS
 * both sides must agree on - `normalizedRoute`, and what the absence of an
 * options object means - and never its resolution.
 */
import { isSourceFile } from "../../harvest/tree.js";
import type { ProbeContext } from "../types.js";
import type { HttpVerb } from "./entries.js";
import { normalizedRoute } from "./route.js";

const VERBS: readonly HttpVerb[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * The verb a client call declares when its options object names none.
 *
 * This is a DEFINITION shared with the gate rather than a default either side
 * invented: `fetch` with no `method` is a GET, by specification. A subject whose
 * wrapper defaulted to something else would be resolved by neither side, because
 * both refuse an options argument they cannot read.
 */
export const IMPLIED_VERB: HttpVerb = "GET";

export interface ClientCallSite {
  /** Subject-relative path of the calling module. */
  path: string;
  /** The identifier the source calls: `fetch`, or a wrapper the subject closes. */
  callee: string;
  /** The enclosing named function the call sits in - the action a user triggers. */
  action: { name: string; line_start: number; line_end: number };
  /** The call site itself, which is what the transport link cites. */
  call: { line_start: number; line_end: number };
  protocol: { method: HttpVerb; path: string };
  /** The wrapper declaration that closes `callee`, absent when it is `fetch`. */
  wrapper?: { path: string; name: string; line_start: number; line_end: number };
}

export type ClientCallGapKind = "dynamic_path" | "generated_path" | "dynamic_request_init";

export interface ClientCallGap {
  kind: ClientCallGapKind;
  path: string;
  callee: string;
  line_start: number;
  line_end: number;
  action: string;
  detail: string;
}

export interface ClientIndex {
  calls: ClientCallSite[];
  gaps: ClientCallGap[];
  /** Every file the scan read, so "ran and found nothing" can say what it read. */
  paths: string[];
  /** Wrapper functions the subject's own wiring closed as HTTP clients. */
  wrappers: { path: string; name: string; line_start: number; line_end: number }[];
}

/* --------------------------------------------------------------- lexing */

interface Literal {
  start: number;
  /** Exclusive, one past the closing delimiter. */
  end: number;
  kind: "string" | "template";
}

interface Masked {
  /** The source with comment and literal CONTENT replaced by spaces, length preserved. */
  text: string;
  /** Every top-level string/template literal, by exact source range. */
  literals: Literal[];
}

const IDENT_CHAR = /[\w$]/;

/**
 * Source with everything that is not code blanked out, and every literal's span.
 *
 * Structural scanning (parens, braces, call sites) runs over `text`, so a brace
 * inside a comment or a quote inside a string can never move a boundary; content
 * is always sliced from the ORIGINAL source at a span this pass recorded. A
 * template substitution returns to code, because `${attemptId}` is code and the
 * path around it is not.
 *
 * Regular-expression literals are recognised so a `/` inside one cannot open a
 * comment or a string. The test is the standard one - a `/` in a position where a
 * value may begin - and it fails closed: an unrecognised regex would blank the
 * rest of a line, which loses a call site rather than inventing one.
 */
export const mask = (source: string): Masked => {
  const out = source.split("");
  const literals: Literal[] = [];
  type Frame = { kind: "template"; start: number } | { kind: "sub" } | { kind: "brace" };
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  const blank = (from: number, to: number): void => {
    for (let n = from; n < to && n < out.length; n += 1) if (out[n] !== "\n") out[n] = " ";
  };
  const valuePosition = (at: number): boolean => {
    for (let n = at - 1; n >= 0; n -= 1) {
      const ch = source[n]!;
      if (/\s/.test(ch)) continue;
      return "(,=:[!&|?{};+-*%~^<>".includes(ch);
    }
    return true;
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    const frame = top();

    if (frame?.kind === "template") {
      if (ch === "\\") { blank(i, i + 2); i += 2; continue; }
      if (ch === "$" && next === "{") { stack.push({ kind: "sub" }); i += 2; continue; }
      if (ch === "`") {
        stack.pop();
        literals.push({ start: frame.start, end: i + 1, kind: "template" });
        i += 1;
        continue;
      }
      blank(i, i + 1);
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end < 0 ? source.length : end + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === "/" && valuePosition(i)) {
      let n = i + 1;
      let inClass = false;
      let closed = false;
      for (; n < source.length; n += 1) {
        const c = source[n]!;
        if (c === "\\") { n += 1; continue; }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { closed = true; break; }
      }
      if (closed) { blank(i, n + 1); i = n + 1; continue; }
    }
    if (ch === "'" || ch === '"') {
      let n = i + 1;
      for (; n < source.length; n += 1) {
        const c = source[n]!;
        if (c === "\\") { n += 1; continue; }
        if (c === ch || c === "\n") break;
      }
      blank(i + 1, n);
      literals.push({ start: i, end: Math.min(n + 1, source.length), kind: "string" });
      i = n + 1;
      continue;
    }
    if (ch === "`") { stack.push({ kind: "template", start: i }); i += 1; continue; }
    if (ch === "{") { stack.push({ kind: "brace" }); i += 1; continue; }
    if (ch === "}") { if (top()?.kind === "brace" || top()?.kind === "sub") stack.pop(); i += 1; continue; }
    i += 1;
  }
  return { text: out.join(""), literals };
};

/** The index of the bracket matching the one at `open`, or -1. */
const matching = (masked: string, open: number): number => {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[masked[open]!]!;
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i]!;
    if (ch === masked[open]) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Top-level argument ranges inside a call's parentheses. */
const argumentRanges = (masked: string, open: number, close: number): { start: number; end: number }[] => {
  const out: { start: number; end: number }[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const ch = masked[i]!;
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push({ start, end: i });
      start = i + 1;
    }
  }
  if (masked.slice(start, close).trim().length > 0) out.push({ start, end: close });
  return out;
};

const trimmedRange = (source: string, range: { start: number; end: number }): { start: number; end: number } => {
  let { start, end } = range;
  while (start < end && /\s/.test(source[start]!)) start += 1;
  while (end > start && /\s/.test(source[end - 1]!)) end -= 1;
  return { start, end };
};

const lineOf = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

/* ------------------------------------------------------- what a call means */

const VERB_IN_OPTIONS = /(?:^|[{,\s])method\s*:\s*(['"`])\s*([A-Za-z]+)\s*\1/;
const VERB_KEY = /(?:^|[{,\s])method\s*:/;

export type EndpointReading =
  | { ok: true; protocol: { method: HttpVerb; path: string } }
  | { ok: false; kind: ClientCallGapKind; detail: string };

/**
 * The endpoint one client call declares, or the reason it declares none.
 *
 * Every refusal here is a refusal to guess. A path assembled at run time is not a
 * route this engine can match against a Spring mapping, and an options object it
 * cannot read is not a verb - so the call becomes a named cut rather than a
 * transport arrow drawn on a probable contract.
 */
export const endpointOfCall = (
  source: string,
  masked: Masked,
  open: number,
  close: number,
): EndpointReading => {
  const args = argumentRanges(masked.text, open, close);
  const first = args[0];
  if (!first) {
    return { ok: false, kind: "dynamic_path", detail: "the call passes no URL argument" };
  }
  const range = trimmedRange(source, first);
  const literal = masked.literals.find((l) => l.start === range.start && l.end === range.end);
  if (!literal) {
    const raw = source.slice(range.start, range.end).replace(/\s+/g, " ");
    const built = masked.literals.some((l) => l.start >= range.start && l.end <= range.end);
    return built
      ? {
          ok: false,
          kind: "generated_path",
          detail: `the URL is assembled from an expression (\`${raw}\`) rather than written as one literal`,
        }
      : {
          ok: false,
          kind: "dynamic_path",
          detail: `the URL comes from \`${raw}\`, which this adapter cannot resolve to one route`,
        };
  }
  const inner = source.slice(literal.start + 1, literal.end - 1);
  const path = normalizedRoute(inner);
  if (!path.startsWith("/")) {
    return { ok: false, kind: "dynamic_path", detail: `\`${inner}\` is not a subject-relative route` };
  }

  const second = args[1];
  if (!second) return { ok: true, protocol: { method: IMPLIED_VERB, path } };
  const optionsRange = trimmedRange(source, second);
  if (masked.text[optionsRange.start] !== "{" || matching(masked.text, optionsRange.start) !== optionsRange.end - 1) {
    return {
      ok: false,
      kind: "dynamic_request_init",
      detail: `the request options come from \`${source
        .slice(optionsRange.start, optionsRange.end)
        .replace(/\s+/g, " ")}\`, so the HTTP method is not written down`,
    };
  }
  const optionsSource = source.slice(optionsRange.start, optionsRange.end);
  const named = VERB_IN_OPTIONS.exec(optionsSource);
  if (!named) {
    if (VERB_KEY.test(masked.text.slice(optionsRange.start, optionsRange.end))) {
      return {
        ok: false,
        kind: "dynamic_request_init",
        detail: "the options object sets `method` to something other than a string literal",
      };
    }
    return { ok: true, protocol: { method: IMPLIED_VERB, path } };
  }
  const verb = named[2]!.toUpperCase() as HttpVerb;
  if (!VERBS.includes(verb)) {
    return { ok: false, kind: "dynamic_request_init", detail: `\`${named[2]}\` is not an HTTP method` };
  }
  return { ok: true, protocol: { method: verb, path } };
};

/* ------------------------------------------------ what counts as a client */

interface Declaration {
  name: string;
  /** The whole declaration, header included. */
  line_start: number;
  line_end: number;
  bodyStart: number;
  bodyEnd: number;
  headerStart: number;
  params: string[];
}

const DECLARATIONS = [
  /(?:^|[;{}\s])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|[;{}\s])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/g,
];

/** Every named function declaration with a block body, by source range. */
const declarationsIn = (source: string, masked: Masked): Declaration[] => {
  const out: Declaration[] = [];
  for (const pattern of DECLARATIONS) {
    const scan = new RegExp(pattern.source, "g");
    for (const match of masked.text.matchAll(scan)) {
      const open = masked.text.indexOf("(", match.index);
      const close = matching(masked.text, open);
      if (close < 0) continue;
      let at = close + 1;
      // Skip a return-type annotation and an arrow, then require a block body.
      while (at < masked.text.length && masked.text[at] !== "{" && masked.text[at] !== ";" && masked.text[at] !== "\n") at += 1;
      if (masked.text[at] !== "{") continue;
      const bodyEnd = matching(masked.text, at);
      if (bodyEnd < 0) continue;
      out.push({
        name: match[1]!,
        headerStart: match.index,
        line_start: lineOf(source, match.index),
        line_end: lineOf(source, bodyEnd),
        bodyStart: at,
        bodyEnd,
        params: argumentRanges(masked.text, open, close).map((r) => {
          const t = trimmedRange(source, r);
          return /^([A-Za-z_$][\w$]*)/.exec(source.slice(t.start, t.end))?.[1] ?? "";
        }),
      });
    }
  }
  return out.sort((a, b) => a.headerStart - b.headerStart);
};

/** Call sites of one identifier, as `(open, close)` paren ranges. */
const callsTo = (masked: string, name: string): { start: number; open: number; close: number }[] => {
  const out: { start: number; open: number; close: number }[] = [];
  const scan = new RegExp(`(^|[^\\w$.])${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\(`, "g");
  for (const match of masked.matchAll(scan)) {
    const open = masked.indexOf("(", match.index + match[0].length - 1);
    const close = matching(masked, open);
    if (close < 0) continue;
    out.push({ start: match.index + match[1]!.length, open, close });
  }
  return out;
};

/**
 * Whether one declaration forwards its first parameter into `fetch`'s URL.
 *
 * This is what closes the set of HTTP clients by the SUBJECT'S OWN WIRING rather
 * than by a list of names this adapter happens to know. `apiFetch(path, init)`
 * qualifies because its body hands `path` to `fetch` and adds no literal path
 * text of its own; a helper that prepends `/v2` to every call does not, because
 * then the call site's literal is no longer the route - and refusing is how a
 * wrong route stays undrawn.
 */
const forwardsToFetch = (source: string, masked: Masked, decl: Declaration): boolean => {
  const param = decl.params[0];
  if (!param) return false;
  const body = masked.text.slice(decl.bodyStart, decl.bodyEnd);
  for (const call of callsTo(body, "fetch")) {
    const open = decl.bodyStart + call.open;
    const close = decl.bodyStart + call.close;
    const args = argumentRanges(masked.text, open, close);
    const first = args[0];
    if (!first) continue;
    const range = trimmedRange(source, first);
    const url = source.slice(range.start, range.end);
    if (url === param) return true;
    // One indirection: `const url = `${BASE}${path}`` adds no literal path text.
    const local = /^([A-Za-z_$][\w$]*)$/.exec(url)?.[1];
    if (!local) continue;
    const assignment = new RegExp(`(?:const|let|var)\\s+${local}\\s*=\\s*`).exec(
      masked.text.slice(decl.bodyStart, open),
    );
    if (!assignment) continue;
    const at = decl.bodyStart + assignment.index + assignment[0].length;
    const literal = masked.literals.find((l) => l.start === at && l.kind === "template");
    if (!literal) continue;
    const inner = source.slice(literal.start + 1, literal.end - 1);
    const withoutSubstitutions = inner.replace(/\$\{[^}]*\}/g, "");
    if (withoutSubstitutions.trim().length > 0) continue;
    if (!new RegExp(`\\$\\{[^}]*\\b${param}\\b[^}]*\\}`).test(inner)) continue;
    return true;
  }
  return false;
};

const MODULE_EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/** The subject path a relative import specifier names, or null. */
const resolveImport = (from: string, specifier: string, paths: Set<string>): string | null => {
  if (!specifier.startsWith(".")) return null;
  const dir = from.slice(0, from.lastIndexOf("/"));
  const parts = `${dir}/${specifier}`.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const base = stack.join("/");
  for (const extension of ["", ...MODULE_EXTENSIONS]) {
    if (paths.has(`${base}${extension}`)) return `${base}${extension}`;
  }
  return null;
};

/** Names one module imports, mapped to the subject path they resolve to. */
const importedNames = (source: string, path: string, paths: Set<string>): Map<string, string> => {
  const out = new Map<string, string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveImport(path, match[2]!, paths);
    if (target === null) continue;
    for (const piece of match[1]!.split(",")) {
      const name = /([A-Za-z_$][\w$]*)\s*$/.exec(piece.trim())?.[1];
      if (name) out.set(name, target);
    }
  }
  return out;
};

/* ------------------------------------------------------------- the index */

const CACHE = new WeakMap<ProbeContext, ClientIndex>();

const TS_SOURCE = /\.(ts|tsx)$/;

/**
 * Every HTTP client call the subject writes down, and every one it does not.
 *
 * Both halves matter. The calls become transport arrows into the Spring routes
 * they name; the gaps become named `absent` cuts, because a submit button whose
 * URL this adapter cannot resolve is a story it failed to trace, and #6 forbids
 * reporting that by saying nothing.
 */
export const clientIndex = (ctx: ProbeContext): ClientIndex => {
  const cached = CACHE.get(ctx);
  if (cached) return cached;

  const paths = ctx.paths.filter((p) => TS_SOURCE.test(p) && isSourceFile(p));
  const known = new Set(ctx.paths);
  const sources = new Map<string, { source: string; masked: Masked; declarations: Declaration[] }>();
  for (const path of paths) {
    const source = ctx.read(path);
    if (source === null) continue;
    const masked = mask(source);
    sources.set(path, { source, masked, declarations: declarationsIn(source, masked) });
  }

  const wrappers: ClientIndex["wrappers"] = [];
  for (const [path, file] of sources) {
    for (const decl of file.declarations) {
      if (!forwardsToFetch(file.source, file.masked, decl)) continue;
      wrappers.push({ path, name: decl.name, line_start: decl.line_start, line_end: decl.line_end });
    }
  }

  const calls: ClientCallSite[] = [];
  const gaps: ClientCallGap[] = [];
  for (const [path, file] of sources) {
    const imports = importedNames(file.source, path, known);
    // A wrapper's own text is not a caller of itself. Its header names the same
    // identifier and its body hands an unresolvable parameter to `fetch`, and
    // reporting either as a story this adapter could not trace would invent two
    // absences out of the one declaration that made the tracing possible.
    const wrapperRanges = file.declarations
      .filter((d) => wrappers.some((w) => w.path === path && w.name === d.name))
      .map((d) => ({ start: d.headerStart, end: d.bodyEnd }));
    const callees = new Map<string, ClientIndex["wrappers"][number] | undefined>([["fetch", undefined]]);
    for (const wrapper of wrappers) {
      // A wrapper is callable here when this module imports it from the module
      // that declares it, or declares it itself. Matching by bare name would let
      // an unrelated `apiFetch` in another package inherit the closure.
      if (wrapper.path === path || imports.get(wrapper.name) === wrapper.path) {
        callees.set(wrapper.name, wrapper);
      }
    }
    for (const [callee, wrapper] of callees) {
      for (const call of callsTo(file.masked.text, callee)) {
        if (wrapperRanges.some((r) => call.start >= r.start && call.close <= r.end)) continue;
        const enclosing = file.declarations
          .filter((d) => d.bodyStart < call.open && d.bodyEnd > call.close)
          .sort((a, b) => b.bodyStart - a.bodyStart)[0];
        const action = enclosing
          ? { name: enclosing.name, line_start: enclosing.line_start, line_end: enclosing.line_end }
          : {
              name: path.slice(path.lastIndexOf("/") + 1).replace(TS_SOURCE, ""),
              line_start: lineOf(file.source, call.start),
              line_end: lineOf(file.source, call.close),
            };
        const reading = endpointOfCall(file.source, file.masked, call.open, call.close);
        const line_start = lineOf(file.source, call.start);
        const line_end = lineOf(file.source, call.close);
        if (!reading.ok) {
          gaps.push({
            kind: reading.kind,
            path,
            callee,
            line_start,
            line_end,
            action: action.name,
            detail: reading.detail,
          });
          continue;
        }
        calls.push({
          path,
          callee,
          action,
          call: { line_start, line_end },
          protocol: reading.protocol,
          ...(wrapper === undefined ? {} : { wrapper }),
        });
      }
    }
  }

  const index: ClientIndex = {
    calls: calls.sort((a, b) =>
      a.path === b.path ? a.call.line_start - b.call.line_start : a.path < b.path ? -1 : 1,
    ),
    gaps: gaps.sort((a, b) =>
      a.path === b.path ? a.line_start - b.line_start : a.path < b.path ? -1 : 1,
    ),
    paths,
    wrappers,
  };
  CACHE.set(ctx, index);
  return index;
};
