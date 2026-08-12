/**
 * The model-backed scorer: the one place judgement enters the pipeline.
 *
 * #2 puts `interview_value` behind a plain structured call - input the node
 * graph, output scores - and #9 makes the rubric the versioned prompt asset that
 * call is made under. Everything downstream stays deterministic: the same scores
 * always produce the same survivors and the same deletion record.
 *
 * Three things are deliberate.
 *
 * ONE CALL, not one per node. Ranking is comparative - "worth saying out loud"
 * only means anything against the rest of the set - so the model sees the whole
 * graph at once. Scoring node-by-node would also multiply a fixed per-call cost
 * across every node in the subject.
 *
 * NO TOOLS. The scorer is handed the graph and the rubric and nothing else. It
 * cannot read the tree, cannot fetch an issue, and so cannot introduce a claim
 * that did not come through harvest and the gate. Judgement here means ordering
 * what was established, never adding to it.
 *
 * SCORES ONLY. The model returns a number and a one-line reason per node. It
 * does not decide what survives: #9 gives deletion to the rank stage, and #8's
 * G2 audits the record that stage leaves. A scorer that could delete would be a
 * second authority over what ships.
 */
import { askModel, firstJsonObject } from "../model/ask.js";
import type { AtlasNode } from "../schema/types.js";
import type { ScoredNode } from "./rank.js";
import type { ScoreRequest } from "./scorer.js";

/**
 * What the model is shown of each node.
 *
 * Deliberately not the whole node: evidence entries, ids and provenance are not
 * what the rubric scores, and including them invites the model to reward a node
 * for having many citations - which the rubric explicitly says is not a score.
 */
const summarise = (node: AtlasNode): Record<string, unknown> => {
  const base = { id: node.id, type: node.type, title: node.title, confidence: node.confidence };
  switch (node.type) {
    case "decision":
      return {
        ...base,
        question: node.question,
        decision: node.decision,
        why: node.why,
        rejected: node.rejected.map((r) => `${r.alternative}: ${r.why_it_lost}`),
        rejected_absent_from_record: node.rejected_absent_from_record ?? false,
        status: node.status,
      };
    case "mechanism":
      return {
        ...base,
        what: node.what,
        why_interesting: node.why_interesting,
        enforcement: node.enforcement,
        gotchas: node.gotchas,
      };
    case "boundary":
      return {
        ...base,
        between: `${node.a} / ${node.b}`,
        enforced_by: node.enforced_by,
        what_breaks_without_it: node.what_breaks_without_it,
      };
    case "edge":
      return { ...base, kind: node.kind, statement: node.statement, why_it_matters: node.why_it_matters };
    case "fact":
      return { ...base, label: node.label, value: node.value };
    case "flow":
      return { ...base, caption: node.caption ?? "", steps: node.steps.length };
  }
};

const PROMPT = (rubric: string, nodes: unknown[]): string => `You are scoring nodes for a codebase
overview, under the rubric below. The rubric is the whole of your instruction: do
not apply judgement it does not describe.

Return ONLY a JSON object, no prose and no code fence, of the form:

{"scores":[{"id":"<node id>","score":<0-5 integer>,"because":"<one short line>"}]}

Rules you must follow:
- Score EVERY node you are given, exactly once. A node you are unsure about still
  gets a score; there is no abstaining.
- "because" is one short line naming the rubric reason, not a summary of the node.
- Score the set comparatively: these are competing for a reader's attention.

--- RUBRIC ---
${rubric}
--- END RUBRIC ---

--- NODES ---
${JSON.stringify(nodes, null, 1)}
--- END NODES ---`;

export class ScorerError extends Error {}

interface RawScore {
  id: string;
  score: number;
  because?: string;
}

/** Pull the JSON object out of a reply, tolerating a stray fence or preamble. */
export const parseScores = (text: string): RawScore[] => {
  const json = firstJsonObject(text);
  if (json === null) {
    throw new ScorerError(`the scorer returned no JSON object: ${text.slice(0, 200)}`);
  }
  let parsed: { scores?: RawScore[] };
  try {
    parsed = JSON.parse(json) as { scores?: RawScore[] };
  } catch (cause) {
    throw new ScorerError(`the scorer returned unparseable JSON: ${String(cause)}`);
  }
  if (!Array.isArray(parsed.scores)) {
    throw new ScorerError(`the scorer returned no "scores" array`);
  }
  return parsed.scores;
};

/** A scorer reply, and which model the SDK reported producing it. */
export interface ScorerReply {
  text: string;
  /** The model identity the SDK reported, or undefined if it reported none. */
  model?: string;
}

export interface ModelScorerOptions {
  /** Overridable so a test can drive the scorer without the SDK. */
  ask?: (prompt: string) => Promise<string>;
  /** Reported when a reply came back short and the graph is offered again. */
  onRetry?: (attempt: number, missing: string[]) => void;
}

/**
 * No tools: the scorer orders what was established and may not add to it.
 *
 * Enforced by `model/ask.ts` rather than here. The option this file used to pass
 * was an empty permission allowlist, which leaves the built-in tools in the
 * model's context, so a scorer deliberately shown no evidence (#9: evidence is a
 * gate, not a score) could have read the tree and scored on it. That would never
 * have failed; it would have quietly stopped being the scorer this docblock
 * describes.
 */
export const askViaSdk = (prompt: string): Promise<ScorerReply> => askModel(prompt, "scorer");

/**
 * How many times the whole graph is offered before giving up.
 *
 * A model asked for 32 scores in one reply sometimes returns 31, and the refusal
 * below is correct - an unscored node is not a zero. But refusing on the first
 * omission makes a whole pipeline run fail on a transient slip, so the same
 * question is asked again. It is asked WHOLE rather than as a follow-up for the
 * stragglers: #9 makes scoring comparative, and a second call scoring three
 * leftovers in isolation would not be ranking them against the set.
 */
const ATTEMPTS = 3;

export const modelScorer =
  (options: ModelScorerOptions = {}) =>
  async (request: ScoreRequest): Promise<ScoredNode[]> => {
    if (request.nodes.length === 0) return [];
    const ask = options.ask ?? (async (prompt: string) => (await askViaSdk(prompt)).text);
    const prompt = PROMPT(request.rubric, request.nodes.map(summarise));

    let byId = new Map<string, RawScore>();
    let missing: string[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      byId = new Map(parseScores(await ask(prompt)).map((r) => [r.id, r]));
      missing = request.nodes.filter((n) => !byId.has(n.id)).map((n) => n.id);
      if (missing.length === 0) break;
      options.onRetry?.(attempt, missing);
    }

    if (missing.length > 0) {
      // Not defaulted to zero: an unscored node is one nobody judged, and
      // treating it as a zero would delete it while the record said it was
      // weighed. The same rule the score-file loader enforces.
      throw new ScorerError(
        `the scorer returned no score for ${missing.length} node${missing.length === 1 ? "" : "s"} ` +
          `after ${ATTEMPTS} attempts: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`,
      );
    }

    // A present-but-non-numeric score is not a zero either: Math.round would turn
    // it into NaN, which survives every check above and is then cut at the floor
    // (NaN >= floor is false), deleting the node while the record says it was
    // weighed - the very failure the missing-check exists to refuse.
    const nonNumeric = request.nodes.filter((n) => !Number.isFinite(byId.get(n.id)!.score)).map((n) => n.id);
    if (nonNumeric.length > 0) {
      throw new ScorerError(
        `the scorer returned a non-numeric score for ${nonNumeric.length} node${nonNumeric.length === 1 ? "" : "s"}: ` +
          `${nonNumeric.slice(0, 5).join(", ")}${nonNumeric.length > 5 ? ", ..." : ""}`,
      );
    }

    return request.nodes.map((node) => {
      const r = byId.get(node.id)!;
      const score = Math.max(0, Math.min(5, Math.round(r.score)));
      return { node, score, ...(r.because === undefined ? {} : { because: r.because }) };
    });
  };
