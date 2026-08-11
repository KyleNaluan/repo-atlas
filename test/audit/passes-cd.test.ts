/**
 * Passes C and D.
 *
 * The load-bearing test here is the last block: #21 asks that the ship/no-ship
 * decision be PROVABLY unaffected by the model's verdicts, and that is exactly
 * the kind of claim that rots into a comment unless something checks it. So it
 * is checked by construction - across every combination of verdicts, including
 * a judge that refuses everything and a judge that throws.
 *
 * Nothing here needs a model or a network: pass C is handed a cache, pass D is
 * handed a judge.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  issueCitations,
  resolutionSource,
  resolveIssueCitations,
} from "../../src/audit/checks/issue-resolution.js";
import { runPassC } from "../../src/audit/pass-c.js";
import { cacheFor, cachedIssue } from "./issue-cache.js";
import {
  absenceWitness,
  citationOf,
  isAbsenceShaped,
  proseOf,
  proseSupport,
  type Judge,
} from "../../src/audit/checks/model.js";
import { runPassD } from "../../src/audit/pass-d.js";
import { GATES } from "../../src/audit/register.js";
import type { AuditContext, CheckResult } from "../../src/audit/types.js";
import type { Atlas, AtlasNode, EdgeNode } from "../../src/schema/types.js";
import type { HarvestedIssue } from "../../src/harvest/types.js";

const atlas = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/swe-prep.atlas.json", import.meta.url)), "utf8"),
) as Atlas;

const ctx = { artifact: "", atlas, clone: "." } as AuditContext;

/** Every issue the reference graph cites, as the harvest cache would hold it. */
const fullCache = (): HarvestedIssue[] => cacheFor(atlas);

/* ------------------------------------------------------- pass C */

describe("pass C resolves issue citations, cache first", () => {
  it("passes when the cache holds every cited issue and comment", async () => {
    const { result } = await resolveIssueCitations(ctx, { cached: fullCache() });
    expect(result.outcome).toBe("passed");
    expect(result.count).toBe(issueCitations(atlas).length);
  });

  it("never reaches the network when the cache is complete", async () => {
    // The cache-first property itself, checked rather than asserted in a comment.
    let fetches = 0;
    const { fromCache, fetched } = await resolveIssueCitations(ctx, {
      cached: fullCache(),
      fetch: async () => {
        fetches += 1;
        return undefined;
      },
    });
    expect(fetches).toBe(0);
    expect(fetched).toBe(0);
    expect(fromCache).toBeGreaterThan(0);
  });

  it("reports the split, so an operator can see cache-first holding", async () => {
    const { fromCache, fetched } = await resolveIssueCitations(ctx, { cached: fullCache() });
    expect(resolutionSource(fromCache, fetched)).toMatch(/served from the harvest cache, 0 fetched/);
    expect(resolutionSource(1, 0)).toContain("1 issue served");
  });

  it("fetches only the issue the cache is missing", async () => {
    const partial = fullCache().slice(1);
    const missing = fullCache()[0]!;
    const asked: number[] = [];
    const { result, fetched } = await resolveIssueCitations(ctx, {
      cached: partial,
      fetch: async (n) => {
        asked.push(n);
        return n === missing.number ? missing : undefined;
      },
    });
    expect(asked).toEqual([missing.number]);
    expect(fetched).toBe(1);
    expect(result.outcome).toBe("passed");
  });

  it("reports not run, not failed, when there is no harvest to resolve against", async () => {
    // The distinction it must not guess at: an EMPTY cache with no way to fetch
    // knows nothing about whether these issues exist, so reporting fifteen false
    // citations from it would be the audit blaming the artifact for its own
    // missing state. A cache that DOES hold issues is in a position to know, and
    // the next test is the gate failure that follows from that.
    const { result } = await resolveIssueCitations(ctx, { cached: [] });
    expect(result.outcome).toBe("not_run");
    expect(result.reason).toMatch(/run harvest for this subject first/);
    expect(result.findings).toBeUndefined();
  });

  it("fails when a cited issue does not resolve against a cache that would know", async () => {
    const { result } = await resolveIssueCitations(ctx, { cached: fullCache().slice(1) });
    expect(result.outcome).toBe("failed");
    expect(result.findings?.[0]).toMatch(/does not resolve/);
  });

  it("fails when the issue resolves but the CITED COMMENT does not", async () => {
    // The distinction the whole check exists for: an audit that cannot tell one
    // comment from another cannot verify the decision trail cites the resolution
    // rather than a later note.
    const wrongComments = fullCache().map((i) => cachedIssue(i.number, [999_999]));
    const { result } = await resolveIssueCitations(ctx, { cached: wrongComments });
    expect(result.outcome).toBe("failed");
    expect(result.findings?.[0]).toMatch(/comment \d+ does not/);
    // And it names what the issue does carry, because the likely cause is a
    // citation pointing at the wrong comment on the right issue.
    expect(result.findings?.[0]).toContain("999999");
  });

  it("counts the problems, not the twenty it shows, when it truncates", async () => {
    // A cap on the enumeration is fine; a cap that makes the count agree with the
    // shortened list would report 20 unresolved citations when there were 25.
    const many = {
      ...ctx,
      atlas: {
        ...atlas,
        nodes: [],
        shape: { ...atlas.shape, evidence: [] },
        synopsis: {
          ...atlas.synopsis,
          evidence: Array.from({ length: 25 }, (_, i) => ({ kind: "issue" as const, number: i + 1 })),
        },
      },
    } as AuditContext;
    // A populated cache, so the check is in a position to say these do not exist.
    const { result } = await resolveIssueCitations(many, { cached: [cachedIssue(1, [])] });
    expect(result.findings).toHaveLength(20);
    expect(result.count).toBe(24);
  });

  it("is not applicable when the graph cites no issues", async () => {
    const noIssues = {
      ...ctx,
      atlas: { ...atlas, nodes: [], synopsis: { ...atlas.synopsis, evidence: [] }, shape: { ...atlas.shape, evidence: [] } },
    } as AuditContext;
    const { result } = await resolveIssueCitations(noIssues, { cached: [] });
    expect(result.outcome).toBe("not_applicable");
    expect(result.reason).toBeTruthy();
  });

  it("attributes its own failure to L3, not to the pass before it", async () => {
    // Sharing pass B's boundary would have reported this as "pass B could not
    // run" - a true-shaped sentence about the wrong pass - and dropped L3.
    const checks = (
      await runPassC(ctx, {
        cached: [],
        fetch: async () => {
          throw new Error("github is unreachable");
        },
      })
    ).checks;
    expect(checks.map((c) => c.id)).toEqual(["L3"]);
    expect(checks[0]!.aborted).toBe(true);
    expect(checks[0]!.findings?.[0]).toContain("github is unreachable");
  });
});

/* ------------------------------------------------------- pass D */

const judgeAll = (supported: boolean): Judge => async () => ({ supported, note: "n" });
const resolveNothing = { resolve: () => undefined };

describe("pass D judges each node alone", () => {
  it("hands the judge one node and only its own evidence", async () => {
    // A model shown the whole graph would grade a claim against the document's
    // general plausibility rather than against the citation supporting it.
    const seen: number[] = [];
    const judge: Judge = async (request) => {
      seen.push(request.evidence.length);
      expect(Array.isArray(request.evidence)).toBe(true);
      expect(request.node).toBeTruthy();
      return { supported: true, note: "n" };
    };
    await proseSupport(atlas.nodes.slice(0, 3), { judge, resolve: () => "evidence text" });
    expect(seen).toHaveLength(3);
  });

  it("runs the absence check only on absence-shaped nodes", async () => {
    let judged = 0;
    const judge: Judge = async () => {
      judged += 1;
      return { supported: true, note: "n" };
    };
    await absenceWitness(atlas.nodes, { judge, ...resolveNothing });
    const shaped = atlas.nodes.filter(isAbsenceShaped).length;
    expect(judged).toBe(shaped);
    expect(shaped).toBeGreaterThan(0);
    expect(shaped).toBeLessThan(atlas.nodes.length);
  });

  it("treats an unbuilt or coverage-gap edge as absence-shaped", () => {
    const edge = (kind: EdgeNode["kind"]): AtlasNode => ({
      type: "edge",
      kind,
      id: `e-${kind}`,
      title: "t",
      statement: "something happens",
      why_it_matters: "it matters",
      how_to_say_it: "say it",
      evidence: [],
      confidence: "verified",
      interview_value: 3,
    });
    expect(isAbsenceShaped(edge("unbuilt"))).toBe(true);
    expect(isAbsenceShaped(edge("coverage_gap"))).toBe(true);
    expect(isAbsenceShaped(edge("tradeoff"))).toBe(false);
  });

  it("enumerates every unsupported verdict in full, never a count", async () => {
    const result = await proseSupport(atlas.nodes.slice(0, 3), {
      judge: async (request) => ({ supported: false, note: `${request.node.id} overclaims` }),
      ...resolveNothing,
    });
    expect(result.outcome).toBe("failed");
    expect(result.findings).toHaveLength(3);
    for (const f of result.findings!) expect(f).toContain("overclaims");
  });

  it("reports not run, not failed, when no model is available", async () => {
    // An unreachable model must never decide whether an artifact ships, or
    // emission stops being reproducible - the reason this pass is advisory.
    const result = await proseSupport(atlas.nodes, resolveNothing);
    expect(result.outcome).toBe("not_run");
    expect(result.reason).toMatch(/never decides whether an artifact ships/);
  });

  it("describes each citation so a warning names where it came from", () => {
    expect(citationOf({ kind: "file", path: "a/B.java", line_start: 3, line_end: 9, sha: "x" })).toBe(
      "a/B.java:3-9",
    );
    expect(citationOf({ kind: "issue", number: 2, comment_id: 7 })).toBe("issue #2 comment 7");
    expect(citationOf({ kind: "command", cmd: "./test.sh", output_excerpt: "" })).toBe("$ ./test.sh");
  });

  it("weighs the fields a node actually asserts", () => {
    const decision = atlas.nodes.find((n) => n.type === "decision")!;
    const prose = proseOf(decision);
    expect(prose.length).toBeGreaterThan(2);
    expect(prose.join(" ")).not.toContain("http");
  });
});

/* ------------------------------- the property #21 asks to be provable */

describe("the model can never decide whether an artifact ships", () => {
  const isGateFailure = (c: CheckResult) => c.class === "gate" && c.outcome === "failed";

  it("classifies both model checks as warnings, not gates", () => {
    expect(GATES.map((g) => g.id)).not.toContain("M1");
    expect(GATES.map((g) => g.id)).not.toContain("M2");
  });

  it("produces no gate failure however the judge answers", async () => {
    for (const answer of [true, false]) {
      const checks = await runPassD(ctx, { judge: judgeAll(answer), ...resolveNothing });
      expect(checks.some(isGateFailure), `judge answering ${answer}`).toBe(false);
      expect(checks.every((c) => c.class === "warning")).toBe(true);
    }
  });

  it("produces no gate failure when the judge refuses every node", async () => {
    const checks = await runPassD(ctx, { judge: judgeAll(false), ...resolveNothing });
    expect(checks.every((c) => c.outcome === "failed")).toBe(true);
    expect(checks.some(isGateFailure)).toBe(false);
  });

  it("produces no gate failure when there is no judge at all", async () => {
    const checks = await runPassD(ctx, resolveNothing);
    expect(checks.every((c) => c.outcome === "not_run")).toBe(true);
    expect(checks.some(isGateFailure)).toBe(false);
  });

  it("reports not run, never aborted, when the judge dies mid-sweep", async () => {
    // The back door this closes: the run fails on an ABORTED check, because a
    // deterministic check that could not run means the audit could not see the
    // artifact. A throwing judge that aborted - or that simply propagated, and
    // was caught by the run's boundary as a precondition failure - would let
    // model availability decide emission after all.
    let calls = 0;
    const throwing: Judge = async () => {
      calls += 1;
      if (calls > 2) throw new Error("model unavailable");
      return { supported: true, note: "n" };
    };
    const checks = await runPassD(ctx, { judge: throwing, ...resolveNothing });
    for (const c of checks) {
      expect(c.outcome).toBe("not_run");
      expect(c.aborted).toBeUndefined();
      expect(c.reason).toContain("model unavailable");
      expect(c.reason).toMatch(/never decides whether an artifact ships/);
    }
    expect(checks.some(isGateFailure)).toBe(false);
  });

  it("drops a partial sweep rather than enumerating it as the whole set", async () => {
    // A truncated warning list presented as complete is the same lie as silence.
    let calls = 0;
    const throwing: Judge = async () => {
      if ((calls += 1) > 2) throw new Error("gone");
      return { supported: false, note: "overclaims" };
    };
    const [m1] = await runPassD(ctx, { judge: throwing, ...resolveNothing });
    expect(m1!.findings).toBeUndefined();
    expect(m1!.reason).toMatch(/after judging 2 of \d+ nodes/);
  });
});
