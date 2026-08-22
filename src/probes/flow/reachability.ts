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
