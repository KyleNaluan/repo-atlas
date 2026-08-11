/**
 * The model behind pass D, kept behind one small function.
 *
 * Isolated here so the deterministic passes never import the model SDK - the
 * same separation the rank stage needed, for the same reason: a credential-free
 * path must stay credential-free.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Judge, JudgeRequest, Verdict } from "./checks/model.js";

const EXCERPT_LIMIT = 4000;

// Show the model at most EXCERPT_LIMIT characters of an evidence text, but never
// let a shortened excerpt read as the whole thing: a truncated span presented as
// complete would have the judge weigh prose against evidence it was not actually
// shown. When it truncates, it says so and by how much.
const excerpt = (text: string): string =>
  text.length <= EXCERPT_LIMIT
    ? text
    : `${text.slice(0, EXCERPT_LIMIT)}\n[... truncated; ${text.length - EXCERPT_LIMIT} more characters not shown]`;

const prompt = (request: JudgeRequest, question: string): string => `${question}

Return ONLY a JSON object, no prose and no code fence:
{"supported": <true|false>, "note": "<one short line>"}

If supported is false, "note" must name the specific sentence and what the
evidence does not show. If true, "note" is one line saying what the evidence
establishes.

--- NODE PROSE ---
${JSON.stringify(request.node, null, 1)}
--- END NODE ---

--- ITS OWN CITED EVIDENCE ---
${request.evidence.map((e) => `[${e.citation}]\n${excerpt(e.text)}`).join("\n\n") || "(none resolved)"}
--- END EVIDENCE ---`;

export const sdkJudge: Judge = async (request, question): Promise<Verdict> => {
  // No tools: the judge weighs the node against the evidence it was handed and
  // may not go looking for more, or it would be grading a different claim.
  const run = query({ prompt: prompt(request, question), options: { maxTurns: 1, allowedTools: [] } });
  for await (const message of run) {
    if (message.type === "result" && "result" in message && typeof message.result === "string") {
      const text = message.result;
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end <= start) {
        // A verdict that cannot be read is not a finding against the artifact.
        return { supported: true, note: "the judge returned no readable verdict" };
      }
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Verdict>;
        return {
          supported: parsed.supported !== false,
          note: typeof parsed.note === "string" ? parsed.note : "no note given",
        };
      } catch {
        return { supported: true, note: "the judge returned unparseable JSON" };
      }
    }
  }
  return { supported: true, note: "the judge produced no result" };
};
