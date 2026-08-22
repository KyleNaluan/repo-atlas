/**
 * What it means, in this engine, for one file to NAME a type in code.
 *
 * This is the whole of what the closed negative reachability check shares
 * between the producer and the gate (#35, PR 7, report 5.5) - one definition,
 * two independent derivations, exactly as `normalizedRoute` is one definition of
 * "the same route" and `manifests.ts` one definition of "declared". The producer
 * drives its closure from the parse index; the gate drives its own from a blob
 * reread and its own declaration scan. Neither borrows the other's traversal.
 *
 * A negative claim is only worth as much as its over-approximation. So the
 * closure both sides compute is deliberately coarse: a file that names a type
 * anywhere in its CODE is treated as able to reach it, whether or not it calls
 * anything. What is excluded is exactly what cannot execute - comments, string
 * and character literals, text blocks - because a javadoc cross-reference is not
 * a call, and counting one would make every honest negative unprovable on a
 * well-documented subject.
 *
 * The residual unsoundness is reflection: a type named only inside a string
 * literal and loaded by name would be invisible here. That is stated rather than
 * papered over, and it is the same limit every static resolver in this producer
 * already runs under.
 */

/**
 * The source with everything that cannot execute blanked, LENGTH PRESERVED, so
 * an offset into the mask is an offset into the original.
 *
 * Java's lexical shapes, in the order the scanner has to decide them: a text
 * block (`"""`) before a plain string, because the plain-string rule would end
 * it at the second quote; a character literal, whose escape rules are the
 * string's; a line comment; a block comment. Nothing here parses Java - it only
 * has to know where code is NOT.
 */
export const maskedJava = (source: string): string => {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    const three = source.slice(i, i + 3);
    if (three === '"""') {
      const end = source.indexOf('"""', i + 3);
      const stop = end === -1 ? source.length : end + 3;
      blank(i + 3, stop - 3);
      i = stop;
      continue;
    }
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i]!;
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") j += 1;
        if (source[j] === "\n") break;
        j += 1;
      }
      const stop = Math.min(j + 1, source.length);
      blank(i + 1, stop - 1);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join("");
};

/**
 * The source with COMMENTS blanked and string literals left intact, length
 * preserved (#35, PR 8).
 *
 * The other half of the same idea, for a different question. `maskedJava` asks
 * "where is code", so it blanks strings too - and that is exactly wrong when the
 * thing being read IS a string the code declares: a `@Scheduled(cron = "0 0 9 *
 * * *")` masked that way reports an empty schedule, and the gate would refuse a
 * correct trigger. What must not be readable is a commented-out annotation, so
 * comments alone are blanked here.
 */
export const withoutComments = (source: string): string => {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (source.slice(i, i + 3) === '"""') {
      const end = source.indexOf('"""', i + 3);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i]!;
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") j += 1;
        if (source[j] === "\n") break;
        j += 1;
      }
      i = Math.min(j + 1, source.length);
      continue;
    }
    i += 1;
  }
  return out.join("");
};

export interface ParenList {
  /** The text between the parens, sliced from the ORIGINAL span. */
  inner: string;
  /** Each top-level, comma-separated element, sliced from the ORIGINAL span; empty for `()`. */
  elements: string[];
  /** Index of the matching close paren in the span. */
  end: number;
}

/**
 * Read a `(...)` list whose opening paren is at `open`, balancing brackets over a
 * length-preserving mask (#35, PR 8).
 *
 * This is the ONE definition of "read a parenthesised span structurally", shared
 * by the two annotation-args readers and the gate's method-parameter reader. Every
 * one of them balances the SAME `()`/`<>` nesting and splits top-level commas the
 * SAME way, so a parameter carrying a parenthesised annotation (`@Header(name =
 * "x")`), a generic comma (`Map<K, V>`), or a bracket inside a string literal
 * (`@Header("a)b")`, `@Header("x>y")`) cannot corrupt any one of them differently
 * from the others. The mask blanks string/char/comment CONTENTS while preserving
 * length, so an offset into the mask is an offset into `span`; every returned slice
 * comes from the ORIGINAL `span`, because a caller reads a declared type name or
 * an expression out of it that the mask would have blanked. `<>` counts toward
 * depth so a generic comma is not a top-level separator, and annotation argument
 * text carries no bare `<`/`>` outside a string, so counting it there is inert.
 *
 * Returns null when `open` is not a `(` in the mask or the list is unterminated -
 * failing closed, the same way every reader that calls it does.
 */
export const readParenList = (
  span: string,
  open: number,
  masked: string = maskedJava(span),
): ParenList | null => {
  if (masked[open] !== "(") return null;
  let depth = 0;
  const commas: number[] = [];
  for (let j = open; j < masked.length; j += 1) {
    const ch = masked[j];
    if (ch === "(" || ch === "<") depth += 1;
    else if (ch === ">") depth -= 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        const inner = span.slice(open + 1, j);
        const starts = [open + 1, ...commas.map((c) => c + 1)];
        const ends = [...commas, j];
        const elements = inner.trim() === "" ? [] : starts.map((s, k) => span.slice(s, ends[k]!));
        return { inner, elements, end: j };
      }
    } else if (ch === "," && depth === 1) commas.push(j);
  }
  return null;
};

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether masked source names `simple` as a whole identifier.
 *
 * Word-bounded, so `Learned` does not match `LearnedState`: a type this file
 * never writes is a type it cannot call, and matching a prefix would make the
 * closure grow by coincidence rather than by reference.
 */
export const mentions = (masked: string, simple: string): boolean =>
  new RegExp(`\\b${escaped(simple)}\\b`).test(masked);
