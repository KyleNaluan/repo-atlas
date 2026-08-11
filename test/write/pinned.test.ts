/**
 * The pinned written set, produced locally against the real subject.
 *
 * Same arrangement as the scorer's pinned scores (#9, and the captain's option
 * C): the model runs through an authenticated CLI, the output is committed, and
 * CI checks the deterministic machinery against it without a credential. What CI
 * cannot check is whether the model still reads these records the same way -
 * that is what a refresh measures, and the loader refuses a set whose prompt has
 * since changed so the measurement cannot go quietly stale.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertWriteFresh,
  candidatesFrom,
  decisionId,
  promptDigest,
  proseFrom,
  writePromptText,
  WRITE_PROMPT_VERSION,
  type WrittenFile,
} from "../../src/write/write.js";
import type { Atlas, DecisionNode } from "../../src/schema/types.js";
import type { HarvestedIssue } from "../../src/harvest/types.js";

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8")) as T;

const pinned = read<WrittenFile>("swe-prep.written.json");
const reference = read<Atlas>("swe-prep.atlas.json");

/** The issues the pinned set was read from, reconstructed well enough to load it. */
const issues: HarvestedIssue[] = pinned.decisions.map((d) => ({
  number: d.issue,
  title: `issue ${d.issue}`,
  body: "",
  state: "closed",
  created_at: "x",
  updated_at: "x",
  author: "u",
  labels: [],
  comment_count: 1,
  comments: [
    { id: d.comment_id, body: "## Resolution", created_at: "x", updated_at: "x", author: "u", bytes: 12 },
  ],
}));

describe("the pinned written set", () => {
  it("was produced under this prompt, by version and by digest", () => {
    expect(pinned.prompt_version).toBe(WRITE_PROMPT_VERSION);
    expect(pinned.prompt_sha256).toBe(promptDigest(writePromptText()));
    expect(() => assertWriteFresh(pinned, writePromptText(), pinned.subject_sha)).not.toThrow();
  });

  it("records which model read the records", () => {
    // Provenance on both halves, so a refresh that changes the reading shows
    // whether the prompt or the model moved.
    expect(pinned.model).toBeTruthy();
  });

  it("is pinned to the same SHA the reference artifact is", () => {
    expect(pinned.subject_sha).toBe(reference.subject.sha);
  });

  it("read every resolution-shaped record the subject carries", () => {
    // swe-prep has nine, which the harvest reports independently. A set that
    // silently read eight would still look complete on its own.
    expect(pinned.decisions).toHaveLength(9);
    expect(new Set(pinned.decisions.map((d) => d.issue)).size).toBe(9);
  });

  it("cites a distinct comment per record, never the issue alone", () => {
    // The comment id is what distinguishes a resolution from a later note (#4).
    for (const d of pinned.decisions) expect(d.comment_id, `issue ${d.issue}`).toBeGreaterThan(0);
    expect(new Set(pinned.decisions.map((d) => d.comment_id)).size).toBe(9);
  });
});

describe("what the pinned set yields", () => {
  const candidates = candidatesFrom(pinned, issues, writePromptText(), pinned.subject_sha);

  it("mints one decision candidate per record", () => {
    expect(candidates).toHaveLength(9);
    expect(candidates.map((c) => c.node.id)).toEqual(pinned.decisions.map((d) => decisionId(d.issue)));
  });

  it("cites the record each decision was read from", () => {
    for (const c of candidates) {
      expect(c.node.evidence).toHaveLength(1);
      expect(c.node.evidence[0]!.kind).toBe("issue");
    }
  });

  it("leaves every implemented_by empty for the gate to settle", () => {
    for (const c of candidates) expect((c.node as DecisionNode).implemented_by).toEqual([]);
  });

  it("names a rejected alternative on every record, which is the finding", () => {
    // Recorded rather than assumed. swe-prep's resolution comments carry an
    // explicit "Rejected:" section, so all nine name what lost - which is why it
    // is the parity subject. A subject where this drops is not a regression here.
    const named = pinned.decisions.filter((d) => (d.written.rejected ?? []).length > 0).length;
    expect(named).toBe(9);
    for (const c of candidates) {
      expect((c.node as DecisionNode).rejected_absent_from_record).toBeUndefined();
    }
  });

  it("sends eight of nine claims to the gate, and drops the unresolvable one", () => {
    // The number is the finding, so it moves visibly. Eight records say where to
    // look and get checked against the tree. The ninth (#4, the public/private
    // content split) claims something is ABSENT and names nothing to search for,
    // so nothing in the tree can settle it either way - the gate would demote it
    // rather than resolve it, and sending it anyway would be asking the gate to
    // confirm a claim nobody can check.
    const withClaims = candidates.filter((c) => c.claims !== undefined);
    expect(withClaims).toHaveLength(8);
    const dropped = candidates.filter((c) => c.claims === undefined);
    expect(dropped.map((c) => c.node.id)).toEqual([decisionId(4)]);
    const claim = pinned.decisions.find((d) => d.issue === 4)!.written.implementation_claim!;
    expect(claim.expect).toBe("absent");
    expect(claim.paths).toBeUndefined();
    expect(claim.pattern).toBeUndefined();
  });

  it("admits every decision as attested, never as verified", () => {
    for (const c of candidates) expect(c.node.confidence).toBe("attested");
  });

  it("yields a product sentence and an annotated tree with pinned evidence", () => {
    const prose = proseFrom(pinned.prose, pinned.subject_sha, "README.md");
    expect(prose).toBeDefined();
    expect(prose!.synopsis.statement.length).toBeGreaterThan(100);
    expect(prose!.shape.tree.split("\n").length).toBeGreaterThan(10);
    expect(prose!.synopsis.evidence[0]).toEqual({
      kind: "file",
      path: "README.md",
      sha: pinned.subject_sha,
    });
  });
});
