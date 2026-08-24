/**
 * One definition of "where Python code is NOT", shared by the producer and the
 * gate exactly as `reachability.ts` exports `maskedJava`/`withoutComments` once
 * and each side drives its own resolution off it (#35, #52). A framework import
 * scan and the gate's declaration scans ask the same lexical question - is this
 * token real code, or contents of a comment or string - so they must not answer
 * it two different ways. Nothing here parses Python; it only has to know where
 * code is not, which is what keeps a `from fastapi import ...` inside a docstring
 * from counting as an import, or an `add_edge` inside a string from counting as a
 * declared arrow.
 *
 * The mask is LENGTH PRESERVING, so an offset into the mask is an offset into the
 * original: a `#` inside a string is not a comment, and a triple-quoted body is
 * blanked between its own delimiters.
 */
const PY_STRING_OPEN = /^[rRbBuUfF]{0,3}("""|'''|"|')/;

const maskPython = (source: string, keepStrings: boolean): string => {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < source.length) {
    if (source[i] === "#") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    const opened = PY_STRING_OPEN.exec(source.slice(i, i + 7));
    if (opened) {
      const quote = opened[1]!;
      const bodyStart = i + opened[0].length;
      let j = bodyStart;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source.startsWith(quote, j)) break;
        if (quote.length === 1 && source[j] === "\n") break;
        j += 1;
      }
      const stop = Math.min(j + quote.length, source.length);
      if (!keepStrings) blank(bodyStart, j);
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join("");
};

/** Where code is: comments and string contents blanked. */
export const maskedPython = (source: string): string => maskPython(source, false);
/** Where a declared literal is: comments blanked, string contents kept. */
export const pythonWithoutComments = (source: string): string => maskPython(source, true);
