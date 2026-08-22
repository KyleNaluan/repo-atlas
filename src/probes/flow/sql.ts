/**
 * What the subject's own SQL says, as one definition both the producer and the
 * gate read from (#35, PR 7) - the arrangement `route.ts` uses for "the same
 * route" and `manifests.ts` for "declared". The two derivations stay
 * independent: the producer applies these to method bodies it parsed, the gate
 * to spans it re-read from the blob.
 *
 * A durable read is one the SQL states, never one a method name suggests.
 * `cleanPassInstants` matches no read-verb convention and is the single most
 * load-bearing read on the reference subject; `countByAttempt` matches one and
 * is plumbing. What separates them is not the name, so the name is not read.
 */

const SELECT_SQL = /\bselect\b[\s\S]{0,4000}?\bfrom\b/i;
const MUTATE_SQL = /\b(?:insert\s+into|update\s+[\w."`]+\s+set|delete\s+from|merge\s+into)\b/i;

/** Whether this text reads durable storage and does not mutate it. */
export const readsDurably = (text: string): boolean =>
  SELECT_SQL.test(text) && !MUTATE_SQL.test(text);

/** Whether this text mutates durable storage. */
export const writesDurably = (text: string): boolean => MUTATE_SQL.test(text);

/**
 * The comparisons this text writes against a LITERAL - `outcome = 'PASSED'`.
 *
 * This is what a lineage arrow's label is allowed to carry beyond the read's own
 * name (report 5.5): a literal SQL predicate, never mechanically generated
 * prose. It is also the shape of the reference artifact's own insight - the
 * competence signal is filtered in SQL rather than in a caller - recovered from
 * the tree instead of narrated. A single-quoted multi-character literal cannot
 * be a Java char literal, so finding one is unambiguous evidence of SQL text.
 */
const LITERAL_PREDICATE =
  /\b([\w.]+)\s*(=|<>|!=|>=|<=|>|<|\bin\b)\s*(\((?:\s*'[^']{2,}'\s*,?)+\)|'[^']{2,}')/gi;

export const literalPredicates = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(LITERAL_PREDICATE)].map((match) =>
      `${match[1]} ${match[2]!.toLowerCase()} ${match[3]}`.replace(/\s+/g, " "),
    ),
  ),
];

/**
 * The verbs a storage method's NAME uses, kept here beside the SQL definitions
 * because they answer the same question from the other side, and because three
 * readers were keeping three copies of them (the tracer, the gate, and the
 * audit's E2). The copy E2 kept had drifted: it lacked `count` and `exists`, and
 * refused a rendered arrow citing `submissions.countsForAttempts(...)`.
 *
 * A name is a weaker signal than SQL and is used only where a reader has nothing
 * else - the tracer's convention path, and E2's coarse check that a rendered
 * `read` arrow cites something that reads at all. Two shapes, because they ask
 * different questions: does this NAME BEGIN with a read verb, and does this SPAN
 * OF SOURCE contain one anywhere.
 */
const READ_VERBS = [
  "find", "get", "read", "load", "select", "exists", "count", "query", "fetch", "lookup", "search",
];
const WRITE_VERBS = [
  "save", "write", "insert", "update", "delete", "remove", "persist", "store", "upsert", "merge",
];

/** Whether a method name begins with a read (or write) verb. */
export const readVerbName = (name: string): boolean =>
  new RegExp(`^(?:${READ_VERBS.join("|")})`, "i").test(name);
export const writeVerbName = (name: string): boolean =>
  new RegExp(`^(?:${WRITE_VERBS.join("|")})`, "i").test(name);

/** Whether a span of source names a read (or write) verb anywhere in it. */
export const READ_VERB = new RegExp(`\\b(?:${READ_VERBS.join("|")})\\w*`, "i");
export const WRITE_VERB = new RegExp(`\\b(?:${WRITE_VERBS.join("|")})\\w*`, "i");
