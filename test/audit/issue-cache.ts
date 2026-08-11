/**
 * A harvest cache that satisfies exactly the issue citations a graph makes.
 *
 * Shared so that pass C's own tests and the end-to-end suite build it the same
 * way: a helper that drifted between the two would let one of them pass against
 * a cache the other could not produce.
 */
import { issueCitations } from "../../src/audit/checks/issue-resolution.js";
import type { Atlas } from "../../src/schema/types.js";
import type { HarvestedIssue } from "../../src/harvest/types.js";

export const cachedIssue = (number: number, commentIds: number[]): HarvestedIssue => ({
  number,
  title: `issue ${number}`,
  body: "b",
  state: "closed",
  created_at: "x",
  updated_at: "x",
  author: "u",
  labels: [],
  comment_count: commentIds.length,
  comments: commentIds.map((id) => ({
    id,
    body: "## Resolution: x",
    created_at: "x",
    updated_at: "x",
    author: "u",
    bytes: 16,
  })),
});

export const cacheFor = (atlas: Atlas): HarvestedIssue[] => {
  const byNumber = new Map<number, Set<number>>();
  for (const { e } of issueCitations(atlas)) {
    const ids = byNumber.get(e.number) ?? new Set<number>();
    if (e.comment_id !== undefined) ids.add(e.comment_id);
    byNumber.set(e.number, ids);
  }
  return [...byNumber].map(([number, ids]) => cachedIssue(number, [...ids]));
};
