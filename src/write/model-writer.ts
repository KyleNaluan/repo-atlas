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
import { askModel, firstJsonObject } from "../model/ask.js";
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

/**
 * The record itself, delimited.
 *
 * The source-specific framing lives HERE and not in `prompts/write-v1.md`,
 * deliberately (#55). The prompt asset states the judgement rules - what makes a
 * record admissible, what a claim must name, why an invented alternative is the
 * worst possible output - and every one of those rules is about a decision
 * record rather than about where it was found, so they read identically for both
 * sources. The envelope is what presents one particular record, which is what it
 * has always done for the issue path.
 *
 * The practical consequence is the reason to state this: the asset is digested
 * into every pinned written set (`assertWriteFresh`), so rewording it to say
 * "or a file" would invalidate three committed fixtures that no credential-free
 * run can regenerate, in exchange for no change in what the model is asked to
 * judge.
 */
const recordBody = (record: RecordToRead): string =>
  record.kind === "file"
    ? `--- WHERE THIS RECORD LIVES ---
${record.record.path} lines ${record.record.line_start}-${record.record.line_end}, at the pinned commit
admitted because ${FAMILY_REASON[record.record.family]}
--- END LOCATION ---

--- THE DECISION RECORD (this is the record) ---
${record.record.body}
--- END RECORD ---`
    : `--- THE ISSUE ---
#${record.issue.number}: ${record.issue.title}
state: ${record.issue.state}

${record.issue.body}
--- END ISSUE ---

--- THE RESOLUTION COMMENT (this is the record) ---
${record.comment.body}
--- END COMMENT ---`;

/**
 * What the subject did to declare this span a decision record.
 *
 * Told to the writer because it bears directly on admissibility: a heading that
 * merely contains the word "decision" is a weaker declaration than a file filed
 * under `docs/adr/`, and the writer is the stage that decides whether the span
 * settles anything. Stating the declaration is not the same as vouching for it.
 */
const FAMILY_REASON: Record<string, string> = {
  adr_directory: "it is a file in the subject's decision-record directory",
  named_file: "the file's own name declares it a decision record",
  memory_section:
    "it is a section of a project-memory file under a heading naming a decision - a weaker declaration than a filed ADR, so judge admissibility on what the section actually settles",
  document_section:
    "it is a section of a committed document under a heading naming a decision - a weaker declaration than a filed ADR, so judge admissibility on what the section actually settles",
};

const decisionPrompt = (record: RecordToRead, prompt: string): string => `${prompt}

--- RETURN ONLY THIS JSON, no prose and no code fence ---
${DECISION_SHAPE}

"status" is "decided" or "superseded" only. Whether a thing was built is never
yours to state: it travels solely on "implementation_claim.expect" and is settled
against the tree afterwards, by machinery that does not consult you.

Omit "implementation_claim" entirely when the record supports neither presence
nor absence. Omit any field you cannot ground in the record below.

${recordBody(record)}`;

/**
 * One source chunk handed to the model.
 *
 * This is not a content cap. Oversized inputs are read through ALL of their
 * chunks below, then the final prose call receives the grounded digests. The
 * old implementation sliced at 20 KB and instructed the writer to decline;
 * that made repository size, rather than available evidence, decide whether an
 * atlas could exist.
 */
export const README_CHUNK_LIMIT = 12_000;
export const PROSE_PATH_LIMIT = 600;

const chunksOf = (text: string, limit: number): string[] => {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += limit) chunks.push(text.slice(at, at + limit));
  return chunks;
};

const readmeChunkPrompt = (chunk: string, index: number, count: number): string => `You are reading
one complete chunk of a repository README. Extract only facts this chunk states
about what the repository is, whom it serves, its major parts, and how those
parts relate. Do not fill gaps from general knowledge. A later call will combine
your digest with every other chunk.

--- RETURN ONLY THIS JSON, no prose and no code fence ---
{"summary":"<concise factual digest of this chunk>"}

--- README CHUNK ${index + 1} OF ${count} ---
${chunk}
--- END CHUNK ---`;

const pathChunkPrompt = (paths: string[], index: number, count: number): string => `You are reading
one complete chunk of a repository's path listing. Select the paths that best
expose this chunk's structure. Every returned path MUST be copied exactly from
the listing. Notes may infer only what the path name and placement establish. A
later call will combine these landmarks with landmarks from every other chunk.

--- RETURN ONLY THIS JSON, no prose and no code fence ---
{"landmarks":[{"path":"<exact listed path>","note":"<short structural note>"}]}

--- PATH CHUNK ${index + 1} OF ${count} ---
${paths.join("\n")}
--- END CHUNK ---`;

const prosePrompt = (
  request: ProseRequest,
  prompt: string,
  readme: string,
  paths: string,
  readmeWasDigested: boolean,
  pathsWereDigested: boolean,
): string => {
  const readmeLabel = readmeWasDigested ? "COMPLETE README DIGEST" : "README";
  const pathsLabel = pathsWereDigested ? "LANDMARKS FROM THE COMPLETE PATH LISTING" : "PATHS AT THE PINNED SHA";
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

${readmeWasDigested ? "Every README byte was read in bounded chunks; the factual chunk digests below cover the complete file.\n" : ""}
--- ${readmeLabel} ---
${readme}
--- END ${readmeLabel} ---

${pathsWereDigested ? "Every path was read in bounded chunks; the validated landmarks below were selected across the complete listing.\n" : ""}
--- ${pathsLabel} ---
${paths}
--- END ${pathsLabel} ---

--- DECISIONS THAT SURVIVED ---
${request.decisions.map((d) => `${d.title}: ${d.decision}`).join("\n") || "(none)"}
--- END DECISIONS ---`;
};

/** Pull the JSON object out of a reply, tolerating a stray fence or preamble. */
export const parseWritten = <T>(text: string): T => {
  const json = firstJsonObject(text);
  if (json === null) {
    throw new WriterError(`the writer returned no JSON object: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(json) as T;
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
      let readme = request.readme;
      let readmeWasDigested = false;
      if (readme.length > README_CHUNK_LIMIT) {
        const chunks = chunksOf(readme, README_CHUNK_LIMIT);
        const summaries: string[] = [];
        for (let i = 0; i < chunks.length; i += 1) {
          const reply = parseWritten<{ summary?: unknown }>(
            await ask(readmeChunkPrompt(chunks[i]!, i, chunks.length)),
          );
          if (typeof reply.summary !== "string" || reply.summary.trim().length === 0) {
            throw new WriterError(`the writer returned no grounded summary for README chunk ${i + 1}`);
          }
          summaries.push(`[chunk ${i + 1}/${chunks.length}] ${reply.summary.trim()}`);
        }
        readme = summaries.join("\n");
        readmeWasDigested = true;
      }

      let paths = request.paths.join("\n");
      let pathsWereDigested = false;
      let pathsShown = request.paths.length;
      if (request.paths.length > PROSE_PATH_LIMIT) {
        const chunks: string[][] = [];
        for (let at = 0; at < request.paths.length; at += PROSE_PATH_LIMIT) {
          chunks.push(request.paths.slice(at, at + PROSE_PATH_LIMIT));
        }
        const landmarks: string[] = [];
        const seen = new Set<string>();
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i]!;
          const allowed = new Set(chunk);
          const reply = parseWritten<{ landmarks?: unknown }>(
            await ask(pathChunkPrompt(chunk, i, chunks.length)),
          );
          if (!Array.isArray(reply.landmarks) || reply.landmarks.length === 0) {
            throw new WriterError(`the writer returned no landmarks for path chunk ${i + 1}`);
          }
          for (const item of reply.landmarks) {
            const value = item as { path?: unknown; note?: unknown };
            if (typeof value.path !== "string" || !allowed.has(value.path)) {
              throw new WriterError(`the writer invented a path while digesting path chunk ${i + 1}`);
            }
            if (seen.has(value.path)) continue;
            seen.add(value.path);
            landmarks.push(`${value.path}${typeof value.note === "string" && value.note.trim() ? ` — ${value.note.trim()}` : ""}`);
          }
        }
        paths = landmarks.join("\n");
        pathsShown = landmarks.length;
        pathsWereDigested = true;
      }

      // Same rule as the decision path: the only route to `admissible: false` is a
      // well-formed verdict saying so, which is a claim about the subject - that
      // the README and listing could not support a product sentence. Anything else
      // - no JSON, unparseable JSON, a reply missing the field - throws WriterError
      // and fails the run, because a reply that is not a verdict is the model
      // missing the question, never a subject with no describable shape.
      const text = await ask(
        prosePrompt(request, prompt, readme, paths, readmeWasDigested, pathsWereDigested),
      );
      const parsed = parseWritten<WrittenProse>(text);
      if (typeof parsed.admissible !== "boolean") {
        throw new WriterError(
          `the writer returned no admissibility verdict for the prose: ${text.slice(0, 200)}`,
        );
      }
      return { ...parsed, paths_shown: pathsShown };
    },
  };
};
