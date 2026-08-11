/**
 * Pure folds over the node graph.
 *
 * #7: sections that re-index earlier nodes (the Q&A table, the source index) are
 * GENERATED from the same graph, never re-derived. That constraint lives here:
 * every function takes nodes and returns a view of those same nodes. Nothing in
 * this file may introduce a claim, a link or an answer that is not already a
 * field on some node - which is why each row carries the provenance of the field
 * it came from, so the renderer can stamp it and the audit can look it back up.
 *
 * Nothing here applies a budget. #7 moved deletion to the rank stage: the
 * renderer renders everything it is handed, or it becomes a second authority
 * over what survives.
 */
import type { Atlas, AtlasNode, Evidence, Subject } from "../schema/types.js";
import { from, type Provenance } from "./html.js";
import { renderEvidence, type RenderedEvidence } from "./links.js";

/** The one-line answer a node offers, taken from the node's own fields. */
export const shortAnswer = (n: AtlasNode): { text: string; prov: Provenance } => {
  switch (n.type) {
    case "decision":
      return { text: n.soundbite, prov: from(n.id, "soundbite") };
    case "mechanism":
      return { text: n.why_interesting, prov: from(n.id, "why_interesting") };
    case "boundary":
      return { text: n.enforced_by, prov: from(n.id, "enforced_by") };
    case "edge":
      return { text: n.how_to_say_it, prov: from(n.id, "how_to_say_it") };
    case "fact":
      return { text: `${n.value} ${n.label}`, prov: from(n.id, "value") };
    case "flow":
      return { text: n.caption ?? n.title, prov: from(n.id, n.caption ? "caption" : "title") };
  }
};

/** Where in the rendered page a node lives. Anchors are the node ids. */
export const anchorOf = (n: AtlasNode): string => `#${n.id}`;

export interface QaRow {
  question: string;
  /** Provenance of the question text: the node that declared it. */
  questionProv: Provenance;
  answer: string;
  /** Provenance of the answer: the bound answer, or the declaring node's own short answer. */
  answerProv: Provenance;
  /** Every node that declared this question - the "where it lives" column. */
  nodes: AtlasNode[];
}

/**
 * The interviewer-questions table.
 *
 * A question is declared ON the node that carries the evidence for its answer,
 * so this is a pure group-by. Two nodes declaring the same question produce one
 * row with two places the answer lives - the common case, since the strongest
 * answers pair a decision with the mechanism that enforces it.
 *
 * The answer is the explicitly bound one if any declaring node bound one;
 * otherwise the highest-value declaring node's own short answer. Nothing here
 * composes, paraphrases or invents an answer - which is exactly why #7 needed
 * the bound-answer form: a Decision's soundbite answers that decision's own
 * question, not every question the decision touches, and folding it in anyway
 * produced fluent wrong rows.
 */
export const qaIndex = (nodes: AtlasNode[]): QaRow[] => {
  const byQuestion = new Map<string, { node: AtlasNode; answer?: string; index: number }[]>();
  for (const n of nodes) {
    const questions = n.interviewer_questions ?? [];
    for (const [index, q] of questions.entries()) {
      const question = typeof q === "string" ? q : q.question;
      const entry =
        typeof q === "string" ? { node: n, index } : { node: n, answer: q.answer, index };
      const list = byQuestion.get(question) ?? [];
      list.push(entry);
      byQuestion.set(question, list);
    }
  }
  return [...byQuestion.entries()]
    .map(([question, entries]) => {
      const sorted = [...entries].sort(
        (a, b) => b.node.interview_value - a.node.interview_value || a.node.id.localeCompare(b.node.id),
      );
      const bound = sorted.find((e) => e.answer !== undefined);
      const first = sorted[0]!;
      const fallback = shortAnswer(first.node);
      return {
        question,
        questionProv: from(first.node.id, `interviewer_questions[${first.index}].question`),
        answer: bound?.answer ?? fallback.text,
        answerProv: bound
          ? from(bound.node.id, `interviewer_questions[${bound.index}].answer`)
          : fallback.prov,
        nodes: sorted.map((e) => e.node),
      };
    })
    .sort((a, b) => {
      const av = Math.max(...a.nodes.map((n) => n.interview_value));
      const bv = Math.max(...b.nodes.map((n) => n.interview_value));
      return bv - av || a.question.localeCompare(b.question);
    });
};

export interface IndexedSource extends RenderedEvidence {
  citedBy: AtlasNode[];
}

/**
 * The source index: every evidence entry on every surviving node, deduped by its
 * own key, ordered by how often the document leans on it.
 *
 * A file cited five times ranks above one cited once, which turns the index into
 * a reading order rather than an alphabetical dump.
 */
export const sourceIndex = (
  nodes: AtlasNode[],
  extra: Evidence[],
  subject: Subject,
): Map<Evidence["kind"], IndexedSource[]> => {
  const seen = new Map<string, IndexedSource>();
  const add = (e: Evidence, owner: AtlasNode | null) => {
    const r = renderEvidence(e, subject);
    const existing = seen.get(r.key);
    if (existing) {
      if (owner && !existing.citedBy.includes(owner)) existing.citedBy.push(owner);
      // Prefer the most specific label (one with line numbers) for the index, and
      // carry its href so the rendered label and the link's line fragment always
      // describe the same range.
      if (r.label.length > existing.label.length) {
        existing.label = r.label;
        existing.href = r.href;
      }
      return;
    }
    seen.set(r.key, { ...r, citedBy: owner ? [owner] : [] });
  };
  for (const e of extra) add(e, null);
  for (const n of nodes) {
    for (const e of n.evidence) add(e, n);
    if (n.type === "decision") for (const e of n.implemented_by) add(e, n);
    if (n.type === "mechanism" && n.code_excerpt) add(n.code_excerpt.evidence, n);
    if (n.type === "flow") for (const s of n.steps) if (s.evidence) add(s.evidence, n);
  }
  const grouped = new Map<Evidence["kind"], IndexedSource[]>();
  for (const s of seen.values()) {
    const list = grouped.get(s.kind) ?? [];
    list.push(s);
    grouped.set(s.kind, list);
  }
  // Two comments on one issue are two different artifacts (#3), and the index is
  // the one place a reader compares citations side by side. Left alone they
  // render as two identical "issue #2 (resolution)" rows, which is precisely the
  // confusion #8's L3 says an audit must not have either: if the page cannot
  // tell comment 5181222288 from 5243059657, it cannot show that the decision
  // trail cites the resolution rather than a later note. Disambiguate only on a
  // real collision, so the common case stays readable.
  const issues = grouped.get("issue") ?? [];
  const perNumber = new Map<string, IndexedSource[]>();
  for (const s of issues) {
    const number = s.key.split(":")[1] ?? "";
    perNumber.set(number, [...(perNumber.get(number) ?? []), s]);
  }
  for (const [, list] of perNumber) {
    if (list.length < 2) continue;
    for (const s of list) {
      const commentId = s.key.split(":")[2];
      if (commentId && commentId !== "body") s.label = `${s.label} comment ${commentId}`;
    }
  }

  for (const list of grouped.values()) {
    list.sort((a, b) => b.citedBy.length - a.citedBy.length || a.label.localeCompare(b.label));
  }
  return grouped;
};

/** interview_value desc, then id, so output is byte-stable run to run. */
export const ranked = <T extends AtlasNode>(nodes: T[]): T[] =>
  [...nodes].sort((a, b) => b.interview_value - a.interview_value || a.id.localeCompare(b.id));

export const evidenceCount = (n: AtlasNode): number => {
  let count = n.evidence.length;
  if (n.type === "decision") count += n.implemented_by.length;
  if (n.type === "flow") count += n.steps.filter((s) => s.evidence).length;
  return count;
};

/** Total evidence entries across the whole document - the trust number. */
export const totalEvidence = (nodes: AtlasNode[], extra: Evidence[]): number =>
  extra.length + nodes.reduce((sum, n) => sum + evidenceCount(n), 0);

export const confidenceTally = (nodes: AtlasNode[]): Record<string, number> =>
  nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.confidence] = (acc[n.confidence] ?? 0) + 1;
    return acc;
  }, {});

export const allExtraEvidence = (atlas: Atlas): Evidence[] => [
  ...atlas.synopsis.evidence,
  ...atlas.shape.evidence,
];

/**
 * Deletions the rank stage made against one section, for the generated
 * "N further items were cut" line. The renderer reports the cut; it does not
 * make it (#7, #9).
 */
export const deletionsFor = (atlas: Atlas, section: string): Atlas["record"]["deletions"] =>
  atlas.record.deletions.filter((d) => d.section === section && d.kind === "budget");
