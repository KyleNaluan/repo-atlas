/**
 * Build-time syntax highlighting (#7 point 3).
 *
 * Two things are deliberate here.
 *
 * Highlighting happens at build time and is inlined, so the artifact fetches no
 * grammar and runs no highlighter at read time - the same reason diagrams are
 * laid out at build time.
 *
 * And it goes through `codeToTokens`, not Shiki's HTML output. Shiki can emit
 * ready-made HTML, but inserting it would need a second `raw()` call site, and
 * #8 made the single-call-site rule a contract precisely because a second one is
 * a hole in the provenance stamp. Tokens carry colours, not markup, so the
 * highlighted block is re-emitted through the same auto-escaping template as
 * everything else and the hole never opens.
 */
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import { html, join, type Safe } from "./html.js";

/** One dark theme, matching `theme.ts`'s palette. */
const THEME = "github-dark-default";

/** Languages the v1 subjects need. An unknown language falls back to plain text. */
const LANGS: BundledLanguage[] = ["java", "typescript", "javascript", "sql", "xml", "bash", "json"];

const isSupported = (lang: string): lang is BundledLanguage =>
  (LANGS as string[]).includes(lang);

let highlighterPromise: Promise<Highlighter> | null = null;

const load = (): Promise<Highlighter> =>
  (highlighterPromise ??= createHighlighter({ themes: [THEME], langs: LANGS }));

/**
 * Highlight a code excerpt into escaped, inline-styled markup.
 *
 * Returns plain escaped text for a language outside the declared set: an
 * unhighlighted excerpt is a cosmetic loss, and guessing a grammar is not.
 */
export const highlight = async (code: string, language: string): Promise<Safe> => {
  const text = code.replace(/\n+$/, "");
  if (!isSupported(language)) return html`${text}`;
  const highlighter = await load();
  const { tokens } = highlighter.codeToTokens(text, { lang: language, theme: THEME });
  return join(
    tokens.map(
      (line) =>
        html`${join(
          line.map((token) =>
            token.color
              ? html`<span style="color:${token.color}">${token.content}</span>`
              : html`${token.content}`,
          ),
        )}`,
    ),
    "\n",
  );
};

/** Free the Shiki WASM instance. The CLI is short-lived; tests are not. */
export const disposeHighlighter = async (): Promise<void> => {
  if (!highlighterPromise) return;
  (await highlighterPromise).dispose();
  highlighterPromise = null;
};
