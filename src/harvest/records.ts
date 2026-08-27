/**
 * The second decision source (#55): decision records committed to the tree.
 *
 * The first source - a `## Resolution` comment on an issue - is empty on three
 * of the four subjects this engine is meant to run on. Measured 2026-08-27:
 * 0 of 16 on futures-trading-bot, 0 of 13 on color-grade-plugin, 0 of 39 on
 * data-science-agent, against ~10 of 50 on swe-prep and 12 of 27 here. Those
 * three subjects are not decision-poor; they record decisions in the tree.
 *
 * THE ADMISSION RULE, and it is the whole module. A span of markdown is a
 * decision record only where the SUBJECT'S OWN DECLARATION says so - a
 * decision-record directory, a filename that names the file one, or a heading
 * whose text names a decision. Never because the prose reads decision-shaped.
 *
 * `RESOLUTION_HEADING`'s docstring already states the principle for the first
 * source: "deliberately a pattern match on the record's own convention rather
 * than a judgement about content". #28 is what the alternative costs - a probe
 * that matched policy vocabulary against any raw line minted a `verified`
 * mechanism out of a YAML comment. A heading is the subject writing "what
 * follows is a decision"; a paragraph containing the word is not.
 *
 * THE VOCABULARY DELIBERATELY OVER-ADMITS. futures-trading-bot's
 * `### Decision Log (implemented; ...)` matches and is a component description,
 * not a decision. That is correct: mechanics propose, judgement deletes (#2,
 * #5). The writer already owns exactly this call - `admissible: false` when a
 * record settles nothing - and an inadmissible record becomes an absent cut
 * carrying its reason, so the artifact still reports that a decision-shaped
 * record existed and did not survive. Tightening the matcher until it is never
 * wrong would move acceptance into a regex, making it a second authority over
 * what survives and making its refusals silent (#6).
 *
 * WHAT THIS DOES NOT DO. Nothing here establishes a fact about the code. A
 * record is testimony about a decision, exactly as an issue comment is, and
 * whether the decision was built is settled afterwards by the gate against the
 * tree. #4's guarantee that project-memory text never evidences a code claim is
 * preserved by construction: the write stage leaves `implemented_by` empty and
 * only `settleBuild` fills it, from paths the gate itself located.
 */
import { fileAt, isMemoryFile, treeFiles, ADR_DIRECTORIES } from "./tree.js";
import type { HarvestedDecisionRecord } from "./types.js";

/** Committed markdown. The record families read markdown and nothing else. */
const MARKDOWN = /\.(md|markdown)$/i;

/**
 * A filename that declares its file a decision record.
 *
 * Word-wise rather than substring, so `adr-editor-ui.md`,
 * `0023-adr-two-phase-loop.md` and the `*-decision.md` shape all qualify while
 * `readme.md` and `address-book.md` do not. Naming a file is as much a
 * declaration as filing it under `docs/adr/`, which is why family 2 reaches a
 * decision report wherever the subject chose to put it.
 */
export const DECISION_FILENAME = /(^|[^a-z0-9])(adrs?|decisions?)([^a-z0-9]|$)/i;

/**
 * A heading whose text names a decision record.
 *
 * Contains-a-word rather than starts-with, because the measured shapes qualify
 * the noun rather than lead with it: `## Design decisions` (swe-prep),
 * `## Locked decisions` (futures-trading-bot's PRD), `## Implementation
 * Decisions` (color-grade-plugin, data-science-agent), `## Decision`
 * (the ADR standard).
 *
 * The vocabulary is what was measured on the corpus plus the ADR standard's own
 * `Decision`, and nothing speculative. `Architecture` was considered and
 * rejected: it names a subject, not a record type, so `## Architecture` - a
 * near-universal heading for a structural description - would admit broadly on
 * every subject for no measured decision content.
 *
 * A `/` is excluded from the word boundary, which is not incidental. Measured on
 * color-grade-plugin, `## Resolved in grilling session (...) - see docs/adr/ and
 * CONTEXT.md` matched on the `adr` inside a PATH. A heading that points AT the
 * decision directory is a cross-reference, not a declaration that what follows is
 * a record, and admitting it would be the matcher reading prose after all.
 */
export const DECISION_HEADING_TEXT = /(^|[^a-z0-9/])(adrs?|decisions?|resolution)([^a-z0-9/]|$)/i;

/** Which declaration admitted a record. Reported per record, never collapsed. */
export type RecordFamily =
  | "adr_directory"
  | "named_file"
  | "memory_section"
  | "document_section";

const underAdrDirectory = (path: string): boolean =>
  ADR_DIRECTORIES.some((dir) => path.startsWith(`${dir}/`));

const basename = (path: string): string => path.split("/").pop() ?? "";

/**
 * A file admitted WHOLE, and the family that admitted it.
 *
 * A whole-file record is never also scanned for sections: an ADR's own
 * `## Decision` heading is part of the record, not a second one. A memory file
 * is never admitted whole either - it is a mixed document, and only its
 * decision-headed sections are records.
 */
export const wholeFileFamily = (path: string): RecordFamily | null => {
  if (!MARKDOWN.test(path) || isMemoryFile(path)) return null;
  if (underAdrDirectory(path)) return "adr_directory";
  if (DECISION_FILENAME.test(basename(path))) return "named_file";
  return null;
};

interface Heading {
  /** 1-based line number of the heading itself. */
  line: number;
  depth: number;
  text: string;
}

/**
 * The headings of a markdown document, with fenced code masked first.
 *
 * A `#` comment inside a fenced block is not a heading, and every memory file in
 * the corpus carries fenced blocks. Reading them as headings would cut a record
 * short at a shell comment, which is a silent truncation of the record's own
 * text - the failure mode #4 spent its whole resolution on.
 */
export const headingsIn = (text: string): Heading[] => {
  const out: Heading[] = [];
  let fence: string | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (opener !== null && (opener[1] ?? "").startsWith(fence)) fence = null;
      continue;
    }
    if (opener !== null) {
      fence = opener[1] ?? "";
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      out.push({ line: i + 1, depth: (heading[1] ?? "").length, text: (heading[2] ?? "").trim() });
    }
  }
  return out;
};

/**
 * The decision-headed sections of one document.
 *
 * A section runs from its heading to the line before the next heading of the
 * same or shallower depth, so a decision block keeps its own sub-headings and
 * stops where the document says it stops. A nested decision heading inside an
 * already-admitted section is not minted a second time: the outer record
 * already carries those bytes, and two records over one span would let the
 * artifact state one decision twice.
 */
export const decisionSections = (
  text: string,
): { line_start: number; line_end: number; heading: string }[] => {
  const headings = headingsIn(text);
  const total = text.split("\n").length;
  const out: { line_start: number; line_end: number; heading: string }[] = [];
  let coveredThrough = 0;
  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i]!;
    if (h.line <= coveredThrough) continue;
    if (!DECISION_HEADING_TEXT.test(h.text)) continue;
    const next = headings.slice(i + 1).find((c) => c.depth <= h.depth);
    const end = next === undefined ? total : next.line - 1;
    out.push({ line_start: h.line, line_end: Math.max(h.line, end), heading: h.text });
    coveredThrough = end;
  }
  return out;
};

/**
 * Issue numbers this record cites in its heading or opening line (#55's D4).
 *
 * Scoped to the first line deliberately. A record that names the issue it came
 * from does so where it identifies itself; a `#12` twelve paragraphs down is a
 * cross-reference, and treating it as the record's identity would merge two
 * decisions that merely mention one another.
 */
export const citedIssues = (record: { heading: string | null; body: string }): number[] => {
  const first = record.body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const scope = `${record.heading ?? ""}\n${first}`;
  const found = new Set<number>();
  for (const m of scope.matchAll(ISSUE_REFERENCE)) found.add(Number(m[1]));
  for (const m of scope.matchAll(/\bissues?\s+#?([1-9]\d{0,4})\b/gi)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
};

/**
 * A `#123` reference to an issue on the subject's own tracker.
 *
 * No leading zero and at most five digits, which is what rules out the two
 * things that otherwise read as issue numbers: an ADR's own `0001` ordinal, and
 * a six-digit hex colour. GitHub issue numbers are neither, so the narrower
 * pattern loses nothing real and stops a merge onto an issue nobody cited.
 */
const ISSUE_REFERENCE = /(?:^|[^\w#])#([1-9]\d{0,4})\b/g;

/**
 * A stable id for a record, from where it was read rather than from its prose.
 *
 * Used verbatim as the rendered element id, so it is reduced to the id
 * alphabet here rather than at the renderer, and it carries the start line
 * because a document can hold several sections and they must not collide.
 */
export const recordId = (path: string, lineStart: number): string =>
  `d-file-${path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-L${lineStart}`;

const sliceLines = (text: string, start: number, end: number): string =>
  text.split("\n").slice(start - 1, end).join("\n");

/**
 * Every in-repo decision record in the tree at the pinned SHA, in path order so
 * a run is reproducible.
 *
 * Uncapped, exactly as the issue source is. A cap would silently drop records,
 * and the write command prints the count before it spends a model call on them.
 */
export const discoverDecisionRecords = (
  repo: string,
  sha: string,
  paths?: string[],
): HarvestedDecisionRecord[] => {
  const tree = paths ?? treeFiles(repo, sha);
  const out: HarvestedDecisionRecord[] = [];

  for (const path of tree) {
    if (!MARKDOWN.test(path)) continue;
    const text = fileAt(repo, sha, path);
    if (text === null || text.trim().length === 0) continue;

    const whole = wholeFileFamily(path);
    if (whole !== null) {
      const lines = text.split("\n");
      const end = lines[lines.length - 1] === "" ? Math.max(1, lines.length - 1) : lines.length;
      const heading = headingsIn(text)[0]?.text ?? null;
      out.push(record(whole, path, 1, end, heading, text));
      continue;
    }

    const family: RecordFamily = isMemoryFile(path) ? "memory_section" : "document_section";
    for (const section of decisionSections(text)) {
      out.push(
        record(
          family,
          path,
          section.line_start,
          section.line_end,
          section.heading,
          sliceLines(text, section.line_start, section.line_end),
        ),
      );
    }
  }

  return out.sort((a, b) => a.path.localeCompare(b.path) || a.line_start - b.line_start);
};

const record = (
  family: RecordFamily,
  path: string,
  line_start: number,
  line_end: number,
  heading: string | null,
  body: string,
): HarvestedDecisionRecord => ({
  id: recordId(path, line_start),
  family,
  path,
  line_start,
  line_end,
  heading,
  body,
  bytes: Buffer.byteLength(body, "utf8"),
  cites_issues: citedIssues({ heading, body }),
});

/** What harvest reports about this source, per family, for the record's source table. */
export const recordsSummary = (records: HarvestedDecisionRecord[]): string => {
  const by = (f: RecordFamily) => records.filter((r) => r.family === f).length;
  const parts = [
    [by("adr_directory"), "under a decision-record directory"],
    [by("named_file"), "in a file whose name declares it one"],
    [by("memory_section"), "as a decision-headed section of a project-memory file"],
    [by("document_section"), "as a decision-headed section of another document"],
  ] as const;
  const named = parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
  return named.length === 0 ? "no in-repo decision record declared itself" : named.join(", ");
};
