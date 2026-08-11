/**
 * The auto-escaping tagged template, and the provenance stamp.
 *
 * Two jobs, and the second is the one that matters.
 *
 * 1. Escaping. The subject repository's own prose ends up in this output and it
 *    contains angle brackets, ampersands and quotes constantly. Every
 *    interpolation is escaped unless it is already a `Safe` fragment.
 *
 * 2. Provenance. #8's check E1 asks that every prose passage in the artifact be
 *    attributable to a specific field of a specific graph element, or to the
 *    renderer's own declared chrome. That cannot be enforced after the fact: the
 *    audit prototype measured 39% of the artifact's words as unattributable from
 *    the DOM, concentrated exactly in the folded sections where re-derivation
 *    would hide, and no text-matching closes the gap because the renderer
 *    legitimately clamps, slices and composes. So the render stage stamps it:
 *    `prose(text, prov)` requires a provenance argument and emits a `data-ev`
 *    span, and `chrome` marks the renderer's own sentences with `data-chrome`.
 *    Text that is neither is a bug the audit can see.
 */

const SAFE = Symbol("safe");

export interface Safe {
  readonly [SAFE]: true;
  toString(): string;
}

const mk = (s: string): Safe => ({ [SAFE]: true, toString: () => s });

export const isSafe = (v: unknown): v is Safe =>
  typeof v === "object" && v !== null && SAFE in (v as object);

export const escape = (v: unknown): string =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Mark a string as already-safe HTML.
 *
 * #8 elevates #7's "keep this auditable" advice to contract: a second call site
 * is a hole in the provenance stamp, because raw HTML carries no `data-ev`. The
 * one permitted call site is the Graphviz SVG in `sections.ts`, and
 * `test/render/raw-lint.test.ts` fails the build if another appears. Syntax
 * highlighting deliberately does NOT use this - it goes through `codeToTokens`
 * and is re-emitted through this same escaping template.
 */
export const raw = (s: string): Safe => mk(s);

const flatten = (v: unknown): string => {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(flatten).join("");
  if (isSafe(v)) return v.toString();
  return escape(v);
};

const interpolate = (strings: TemplateStringsArray, values: unknown[]): string =>
  strings.reduce((acc, s, i) => acc + s + (i < values.length ? flatten(values[i]) : ""), "");

export const html = (strings: TemplateStringsArray, ...values: unknown[]): Safe =>
  mk(interpolate(strings, values));

/** Join an array of fragments with a safe separator. */
export const join = (parts: unknown[], sep = ""): Safe => mk(parts.map(flatten).join(sep));

/* ------------------------------------------------------ the provenance stamp */

/**
 * Where a passage of prose came from.
 *
 * `owner` is a node id, or `record` / `synopsis` / `shape` for the metadata
 * blocks that carry their own evidence. `field` is the field on it. The pair is
 * emitted verbatim so the audit can look the passage back up in `atlas.json`
 * rather than guessing at it from the text.
 */
export interface Provenance {
  owner: string;
  field: string;
}

export const from = (owner: string, field: string): Provenance => ({ owner, field });

export const provAttr = (p: Provenance): string => `${p.owner}:${p.field}`;

/**
 * Atlas prose is plain text plus exactly one declared inline construct:
 * a backtick code span.
 *
 * #7's report left this open ("v1 must decide whether atlas prose is plain text
 * or a declared subset, and validate it, rather than growing regexes"). One
 * construct is the whole subset, and it is validated rather than tolerated: an
 * unbalanced backtick is a render-time error, not a stray character rendered as
 * itself. Prose is written by the rank/write stage, not scraped, so a malformed
 * span is a pipeline bug and fail-closed is the same discipline the confidence
 * gate applies to evidence.
 */
export class ProseError extends Error {
  constructor(text: string, p: Provenance, why: string) {
    super(`${provAttr(p)}: ${why} in prose ${JSON.stringify(text.slice(0, 120))}`);
    this.name = "ProseError";
  }
}

const inlineCode = (text: string, p: Provenance): string => {
  const ticks = (text.match(/`/g) ?? []).length;
  if (ticks % 2 !== 0) throw new ProseError(text, p, "unbalanced backtick");
  return escape(text).replace(/`([^`]*)`/g, (_m, inner: string) => `<code>${inner}</code>`);
};

/**
 * Graph-derived prose, stamped with the field it came from.
 *
 * Every call site names an owner and a field. There is no unstamped overload on
 * purpose: the moment one exists, the check E1 protects becomes advisory.
 */
export const prose = (text: string, p: Provenance): Safe =>
  mk(`<span data-ev="${escape(provAttr(p))}">${inlineCode(text, p)}</span>`);

/** A stamped fragment for prose already assembled from other `Safe` pieces. */
export const proseFragment = (body: Safe, p: Provenance): Safe =>
  mk(`<span data-ev="${escape(provAttr(p))}">${body.toString()}</span>`);

/**
 * The renderer's own sentences: ledes, table headers, explanatory notes.
 *
 * These are the artifact's chrome, and #8 requires the renderer to declare them
 * rather than have the audit guess. The declaration is this stamp; the inventory
 * of what it may say is a golden file in render CI
 * (`test/golden/chrome-inventory.txt`), so a phrasing change is a visible diff -
 * which is what keeps #6's absence wording from rotting silently.
 */
export const chrome = (strings: TemplateStringsArray, ...values: unknown[]): Safe =>
  mk(`<span data-chrome>${interpolate(strings, values)}</span>`);
