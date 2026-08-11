/**
 * A predicate repeated across queries.
 *
 * The judgement encoded: when the same WHERE clause appears in five queries,
 * that predicate is an invariant, and it is being enforced in SQL rather than
 * in a caller's discipline. The boundary is in the query, not in whoever
 * remembers to apply it - and a reader who only sees one query cannot tell.
 *
 * Grep-class, deliberately. #5 refuses to force a text question through a parse
 * tree, and "which predicate string recurs" is a text question.
 */
import type { Candidate, Probe } from "../types.js";

const PREDICATE = /\bwhere\s+([a-z_][\w.]*\s*(?:=|<>|!=|IN|LIKE)\s*(?:'[^']*'|:[\w]+|\?|[\w.]+))/gi;

const SQL_BEARING = /\.(java|sql|kt|ts|py)$/i;

export const repeatedSqlPredicates: Probe = {
  id: "repeated-sql-predicates",
  finds: "a predicate repeated across queries, enforcing an invariant in SQL",
  toolchain: "any",
  run: (ctx) => {
    const seen = new Map<string, { path: string; line: number }[]>();

    for (const path of ctx.paths.filter((p) => SQL_BEARING.test(p))) {
      const source = ctx.read(path);
      if (source === null || !/\bwhere\b/i.test(source)) continue;
      for (const [index, line] of source.split("\n").entries()) {
        PREDICATE.lastIndex = 0;
        for (const m of line.matchAll(PREDICATE)) {
          const predicate = (m[1] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const list = seen.get(predicate) ?? [];
          list.push({ path, line: index + 1 });
          seen.set(predicate, list);
        }
      }
    }

    const out: Candidate[] = [];
    for (const [predicate, sites] of seen) {
      // Twice is a coincidence; three times is an invariant someone is keeping.
      if (sites.length < 3) continue;
      out.push({
        probe_id: "repeated-sql-predicates",
        node: {
          type: "mechanism",
          id: `m-sql-predicate-${predicate.replace(/\W+/g, "-").slice(0, 40)}`,
          title: `"${predicate}" is repeated across ${sites.length} queries`,
          what: `The same predicate appears in ${sites.length} queries across ${new Set(sites.map((s) => s.path)).size} files.`,
          why_interesting:
            "A predicate repeated across queries is an invariant enforced in SQL rather than in a caller's discipline. The boundary is in the query, and a reader who sees only one query cannot tell it is there.",
          enforcement: "query-level",
          gotchas: [],
          evidence: sites.slice(0, 4).map((s) => ({
            kind: "file" as const,
            path: s.path,
            line_start: s.line,
            line_end: s.line,
            sha: ctx.sha,
          })),
          confidence: "verified",
          interview_value: 0,
          probe_id: "repeated-sql-predicates",
        },
      });
    }
    return out;
  },
};
