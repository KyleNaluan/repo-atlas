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
  const pushIn = (source: string, re: RegExp, what: string) => {
    for (const m of source.matchAll(re)) problems.push({ what, snippet: m[0].slice(0, 120) });
  };
  pushIn(artifact, /\ssrc\s*=\s*["'][^"']*["']/gi, "src attribute");
  pushIn(artifact, /<link[^>]*\brel\s*=\s*["']?stylesheet[^>]*>/gi, "external stylesheet");
  // `@import` and a non-data `url(...)` only cause a fetch inside a stylesheet, so
  // scope them to <style> content. S1 is a static tripwire for things the browser
  // would fetch on load; the authoritative gate for the real property is the
  // audit's S2 browser request-count check, which S1 complements rather than
  // replaces. Applied document-wide these two strings also match a subject repo's
  // own source quoted (escaped, inert) inside <pre>/<code> - e.g. CSS or config in
  // a code_excerpt - and would fail-close a legitimate render. Kept fail-closed
  // here: a real @import or non-data url() in a <style> block still refuses.
  const styleContent = [...artifact.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1] ?? "")
    .join("\n");
  pushIn(styleContent, /@import\b[^;]*/gi, "@import");
  pushIn(styleContent, /url\(\s*(?!['"]?data:)[^)]*\)/gi, "non-data url()");
  pushIn(
    artifact,
    /\s(?:xlink:)?href\s*=\s*["'](?!#|https?:\/\/)[a-z]+:[^"']*["']/gi,
    "non-anchor external href",
  );
  pushIn(artifact, /<!DOCTYPE\s+svg[^>]*>/gi, "SVG DTD reference");
  pushIn(artifact, /w3\.org\/Graphics/gi, "w3.org DTD URL");
  return problems;
};

/** Outbound anchors: reported, never a failure. */
export const countOutboundAnchors = (artifact: string): number =>
  [...artifact.matchAll(/<a\s[^>]*href="https?:\/\/[^"]+"/gi)].length;
