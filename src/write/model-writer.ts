/**
 * The model behind the write stage.
 *
 * Isolated from the seam for the reason the scorer's is: the credential-free
 * path - assembling from a pinned written set - must never load the model SDK.
 *
 * The no-tools guarantee is `model/ask.ts`'s, not this file's. The writer is
 * handed one record and may not go looking for more: a writer that could read
 * the tree would ground a decision in code the record never mentions, and the
 * whole point of emitting candidates is that the tree check happens separately,
 * afterwards, by machinery the model does not participate in.
 */
import { askModel } from "../model/ask.js";
import type {
  ProseRequest,
  RecordToRead,
  Writer,
  WrittenDecision,
  WrittenProse,
} from "./write.js";

export class WriterError extends Error {}

const DECISION_SHAPE = `{
  "admissible": <true|false>,
  "because": "<one line, required when admissible is false>",
  "title": "<short noun phrase>",
  "question": "<what was argued>",
  "decision": "<what was settled>",
  "why": "<the reasoning the record gives>",
  "rejected": [{"alternative": "<what lost>", "why_it_lost": "<the record's reason>"}],
  "rejected_absent_from_record": <true when the record names no alternative>,
  "status": "decided" | "superseded",
  "soundbite": "<one plain sentence answering this decision's own question>",
  "implementation_claim": {
    "description": "<what a reader should find, in words>",
    "expect": "present" | "absent",
    "paths": ["<path a reader would look in>"],
    "pattern": {"regex": "<a distinctive string>", "include": "<optional path filter>"}
  }
}`;

const decisionPrompt = (record: RecordToRead, prompt: string): string => `${prompt}

--- RETURN ONLY THIS JSON, no prose and no code fence ---
${DECISION_SHAPE}

"status" is "decided" or "superseded" only. Whether a thing was built is never
yours to state: it travels solely on "implementation_claim.expect" and is settled
against the tree afterwards, by machinery that does not consult you.

Omit "implementation_claim" entirely when the record supports neither presence
nor absence. Omit any field you cannot ground in the record below.

--- THE ISSUE ---
#${record.issue.number}: ${record.issue.title}
state: ${record.issue.state}

${record.issue.body}
--- END ISSUE ---

--- THE RESOLUTION COMMENT (this is the record) ---
${record.comment.body}
--- END COMMENT ---`;

const prosePrompt = (request: ProseRequest, prompt: string): string => `${prompt}

You are writing the product sentence and the annotated tree.

--- RETURN ONLY THIS JSON, no prose and no code fence ---
{
  "admissible": <true|false>,
  "because": "<one line, required when admissible is false>",
  "statement": "<what this repository is and what it is for, in its README's terms>",
  "tree": "<the listing with short notes on what each part is for>"
}

The tree is plain text using box-drawing characters, one entry per line, notes
aligned after the path. Include only directories and files present in the listing
below.

--- README ---
${request.readme.slice(0, 20_000)}
--- END README ---

--- PATHS AT THE PINNED SHA ---
${request.paths.slice(0, 600).join("\n")}
--- END PATHS ---

--- DECISIONS THAT SURVIVED ---
${request.decisions.map((d) => `${d.title}: ${d.decision}`).join("\n") || "(none)"}
--- END DECISIONS ---`;

/** Pull the JSON object out of a reply, tolerating a stray fence or preamble. */
export const parseWritten = <T>(text: string): T => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new WriterError(`the writer returned no JSON object: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch (cause) {
    throw new WriterError(`the writer returned unparseable JSON: ${String(cause)}`);
  }
};

export const askViaSdk = (prompt: string) => askModel(prompt, "writer");

export interface ModelWriterOptions {
  /** Overridable so a test can drive the writer without the SDK. */
  ask?: (prompt: string) => Promise<string>;
  /** Records which model answered, for the pinned file's provenance. */
  onModel?: (model: string | undefined) => void;
}

/**
 * A reading that cannot be read is not a decision.
 *
 * An unparseable reply becomes `admissible: false` rather than a throw, for the
 * same reason the audit's judge treats an unreadable verdict as no finding: the
 * subject is not at fault for the model's output, and the honest record is that
 * this comment produced nothing usable. The reason is carried through, so the
 * artifact says which record it could not read rather than losing it silently.
 */
const readDecision = (text: string): WrittenDecision => {
  try {
    const parsed = parseWritten<WrittenDecision>(text);
    if (typeof parsed.admissible !== "boolean") {
      return { admissible: false, because: "the writer did not say whether this record is admissible" };
    }
    return parsed;
  } catch (cause) {
    return { admissible: false, because: `the writer's reply could not be read: ${String(cause)}` };
  }
};

export const modelWriter = (options: ModelWriterOptions = {}): Writer => {
  const ask =
    options.ask ??
    (async (p: string) => {
      const reply = await askViaSdk(p);
      options.onModel?.(reply.model);
      return reply.text;
    });

  return {
    // One call per record: extraction is not comparative, and a writer shown two
    // records at once can borrow a rationale from the wrong one.
    decision: async (record, prompt) => readDecision(await ask(decisionPrompt(record, prompt))),
    prose: async (request, prompt) => {
      // ask() stays OUTSIDE the try, matching the decision path: an AskError from
      // the SDK seam (a tool-use reply, no result) must propagate loudly rather
      // than be reported as prose that could not be read, which would mask the
      // exact regression the empty-allowlist fix exists to surface. Only a parse
      // failure becomes admissible:false.
      const text = await ask(prosePrompt(request, prompt));
      try {
        const parsed = parseWritten<WrittenProse>(text);
        if (typeof parsed.admissible !== "boolean") {
          return { admissible: false, because: "the writer did not say whether the prose is admissible" };
        }
        return parsed;
      } catch (cause) {
        return { admissible: false, because: `the writer's reply could not be read: ${String(cause)}` };
      }
    },
  };
};
