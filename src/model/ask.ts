/**
 * One structured, tool-free question to a model. The only place the SDK is called.
 *
 * Three stages ask a model something: the scorer orders a node graph (#9), the
 * audit's judge weighs a node against its own evidence (#8), and the writer reads
 * one decision record (#2). All three depend on the same property - THE MODEL
 * CANNOT GO LOOKING - and each had its own copy of the option that was supposed
 * to enforce it.
 *
 * The option was wrong in all three. `allowedTools: []` is a permission
 * allowlist: it governs what may execute, and leaves every built-in tool in the
 * model's context to be attempted. `tools: []` is what removes them. The symptom
 * that exposed it was a writer run ending with `stop_reason: "tool_use"` and no
 * result, because the model reached for a file read and `maxTurns: 1` stopped the
 * turn - but the silent version is worse than the loud one. A scorer that can
 * read the tree can score a node on evidence #9 deliberately withheld from its
 * prompt, and a judge that can read the tree is grading a different claim from
 * the one it was handed. Neither would have failed; both would have quietly
 * stopped being what their docblocks said they were.
 *
 * So it lives here once, and the three callers get it by construction rather
 * than by remembering.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

export class AskError extends Error {}

export interface Reply {
  text: string;
  /** The model the SDK reported, for the provenance a pinned output records. */
  model?: string;
}

/** The model(s) the SDK charged the run to, joined if it used more than one. */
const modelOf = (message: unknown): string | undefined => {
  const usage = (message as { modelUsage?: Record<string, unknown> }).modelUsage;
  if (usage === undefined || usage === null) return undefined;
  const names = Object.keys(usage);
  return names.length > 0 ? names.join(", ") : undefined;
};

/**
 * Ask once, with no tools and one turn.
 *
 * `tools: []` removes the built-ins from the model's context; `allowedTools: []`
 * stays as well, so that a tool arriving by some other route - an MCP server, a
 * setting this process inherits - is refused permission even if it is somehow
 * present. Two mechanisms because the first is the one that matters and the
 * second costs nothing.
 */
export const askModel = async (prompt: string, label: string): Promise<Reply> => {
  const run = query({
    prompt,
    options: { maxTurns: 1, tools: [], allowedTools: [] },
  });
  for await (const message of run) {
    if (message.type === "result") {
      if ("result" in message && typeof message.result === "string") {
        return { text: message.result, model: modelOf(message) };
      }
      // Named rather than dumped: the stop reason is the diagnostic, and a JSON
      // blob in an error message is how the tool-use failure above stayed
      // unreadable for as long as it did.
      const stop = (message as { stop_reason?: string }).stop_reason;
      throw new AskError(
        `the ${label} run ended without a result${stop === undefined ? "" : ` (stop_reason: ${stop})`}`,
      );
    }
  }
  throw new AskError(`the ${label} run produced no result message`);
};
