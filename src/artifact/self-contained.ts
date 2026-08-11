/**
 * The self-containment tripwire (#8's check S1).
 *
 * A regex grep for anything the browser would fetch on load. It is a tripwire,
 * not a parser, and it is deliberately kept even though the audit also loads the
 * file in a browser and asserts exactly one network request (S2): S1 catches a
 * reference in code that never executes, S2 catches a request S1's regexes do
 * not know how to spell. Neither subsumes the other and both are cheap.
 *
 * Outbound anchors are fine - `<a href="https://github.com/...">` is navigation
 * a reader chooses, not a request the page makes.
 */

export interface ExternalRef {
  what: string;
  snippet: string;
}

export const findExternalRefs = (artifact: string): ExternalRef[] => {
  const problems: ExternalRef[] = [];
  const push = (re: RegExp, what: string) => {
    for (const m of artifact.matchAll(re)) problems.push({ what, snippet: m[0].slice(0, 120) });
  };
  push(/\ssrc\s*=\s*["'][^"']*["']/gi, "src attribute");
  push(/<link[^>]*\brel\s*=\s*["']?stylesheet[^>]*>/gi, "external stylesheet");
  push(/@import\b[^;]*/gi, "@import");
  push(/url\(\s*(?!['"]?data:)[^)]*\)/gi, "non-data url()");
  push(
    /\s(?:xlink:)?href\s*=\s*["'](?!#|https?:\/\/)[a-z]+:[^"']*["']/gi,
    "non-anchor external href",
  );
  push(/<!DOCTYPE\s+svg[^>]*>/gi, "SVG DTD reference");
  push(/w3\.org\/Graphics/gi, "w3.org DTD URL");
  return problems;
};

/** Outbound anchors: reported, never a failure. */
export const countOutboundAnchors = (artifact: string): number =>
  [...artifact.matchAll(/<a\s[^>]*href="https?:\/\/[^"]+"/gi)].length;
