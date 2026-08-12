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

const README_LIMIT = 20_000;
const PATHS_LIMIT = 600;

const prosePrompt = (request: ProseRequest, prompt: string): string => {
  const readmeDropped = Math.max(0, request.readme.length - README_LIMIT);
  const pathsDropped = Math.max(0, request.paths.length - PATHS_LIMIT);
  const readmeNote =
    readmeDropped > 0
      ? `\n[${readmeDropped} more README characters were withheld from you. You are seeing a truncated README; decline rather than describe a repository you were shown a fraction of.]`
      : "";
  const pathsNote =
    pathsDropped > 0
      ? `\n[${pathsDropped} more paths were withheld from you. You are seeing a truncated listing; decline rather than annotate a tree you were shown a fraction of.]`
      : "";
  return `${prompt}

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
${request.readme.slice(0, README_LIMIT)}${readmeNote}
--- END README ---

--- PATHS AT THE PINNED SHA ---
${request.paths.slice(0, PATHS_LIMIT).join("\n")}${pathsNote}
--- END PATHS ---

--- DECISIONS THAT SURVIVED ---
${request.decisions.map((d) => `${d.title}: ${d.decision}`).join("\n") || "(none)"}
--- END DECISIONS ---`;
};

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
 * ONLY THE MODEL MAY DECLARE A RECORD INADMISSIBLE.
 *
 * This reverses what this file said first, and the reason it changed is worth
 * keeping. The original rule was that an unreadable reply becomes
 * `admissible: false`, reasoning that the subject is not at fault for the model's
 * output. That reasoning is wrong at the join: `admissible: false` is not a
 * statement about the model, it is a permanent record that THIS RESOLUTION
 * COMMENT SETTLES NO DECISION, and it is carried into the artifact as a cut for
 * want of evidence.
 *
 * It was caught by exactly the failure it invites. A refresh run hit a session
 * limit, the service message came back where JSON was expected, and issue #10 -
 * the record that produces the reference subject's divergence finding - was
 * written into the pinned set as a decision-shaped comment that settles nothing.
 * A fixture attesting to an infrastructure failure is a fixture attesting to
 * nothing, and it would have read as a real measurement forever.
 *
 * So the only route to `admissible: false` is the model saying so in a
 * well-formed verdict. Anything else - no JSON, unparseable JSON, a reply
 * missing the field - means the model did not answer the question, which is a
 * failure of the run and never a finding about the subject. The run is cheap to
 * repeat; a silently wrong pinned record is not.
 */
const readDecision = (text: string): WrittenDecision => {
  const parsed = parseWritten<WrittenDecision>(text);
  if (typeof parsed.admissible !== "boolean") {
    throw new WriterError(
      `the writer returned no admissibility verdict, so this record was not read: ${text.slice(0, 200)}`,
    );
  }
  return parsed;
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
      // Same rule as the decision path: the only route to `admissible: false` is a
      // well-formed verdict saying so, which is a claim about the subject - that
      // the README and listing could not support a product sentence. Anything else
      // - no JSON, unparseable JSON, a reply missing the field - throws WriterError
      // and fails the run, because a reply that is not a verdict is the model
      // missing the question, never a subject with no describable shape.
      const text = await ask(prosePrompt(request, prompt));
      const parsed = parseWritten<WrittenProse>(text);
      if (typeof parsed.admissible !== "boolean") {
        throw new WriterError(
          `the writer returned no admissibility verdict for the prose: ${text.slice(0, 200)}`,
        );
      }
      return parsed;
    },
  };
};
