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
import { issueStore } from "../../src/audit/issue-store.js";
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
import { evidenceResolver } from "../../src/audit/checks/evidence.js";
import { GitError } from "../../src/audit/git.js";
import { runLaterPasses } from "../../src/audit/run.js";
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
    const { result } = await resolveIssueCitations(ctx, issueStore(fullCache()));
    expect(result.outcome).toBe("passed");
    expect(result.count).toBe(issueCitations(atlas).length);
  });

  it("never reaches the network when the cache is complete", async () => {
    // The cache-first property itself, checked rather than asserted in a comment.
    let fetches = 0;
    const { fromCache, fetched } = await resolveIssueCitations(
      ctx,
      issueStore(fullCache(), async () => {
        fetches += 1;
        return undefined;
      }),
    );
    expect(fetches).toBe(0);
    expect(fetched).toBe(0);
    expect(fromCache).toBeGreaterThan(0);
  });

  it("reports the split, so an operator can see cache-first holding", async () => {
    const { fromCache, fetched } = await resolveIssueCitations(ctx, issueStore(fullCache()));
    expect(resolutionSource(fromCache, fetched)).toMatch(/served from the harvest cache, 0 fetched/);
    expect(resolutionSource(1, 0)).toContain("1 issue served");
  });

  it("fetches only the issue the cache is missing", async () => {
    const partial = fullCache().slice(1);
    const missing = fullCache()[0]!;
    const asked: number[] = [];
    const { result, fetched } = await resolveIssueCitations(
      ctx,
      issueStore(partial, async (n) => {
        asked.push(n);
        return n === missing.number ? missing : undefined;
      }),
    );
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
    const { result } = await resolveIssueCitations(ctx, issueStore([]));
    expect(result.outcome).toBe("not_run");
    expect(result.reason).toMatch(/run harvest for this subject first/);
    expect(result.findings).toBeUndefined();
  });

  it("fails when a cited issue does not resolve against a cache that would know", async () => {
    const { result } = await resolveIssueCitations(ctx, issueStore(fullCache().slice(1)));
    expect(result.outcome).toBe("failed");
    expect(result.findings?.[0]).toMatch(/does not resolve/);
  });

  it("fails when the issue resolves but the CITED COMMENT does not", async () => {
    // The distinction the whole check exists for: an audit that cannot tell one
    // comment from another cannot verify the decision trail cites the resolution
    // rather than a later note.
    const wrongComments = fullCache().map((i) => cachedIssue(i.number, [999_999]));
    const { result } = await resolveIssueCitations(ctx, issueStore(wrongComments));
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
    const { result } = await resolveIssueCitations(many, issueStore([cachedIssue(1, [])]));
    expect(result.findings).toHaveLength(20);
    expect(result.count).toBe(24);
  });

  it("finds an issue citation carried in a decision's implemented_by", async () => {
    // issueCitations walks nodeEvidence, the one definition of a node's evidence,
    // so a decision whose resolution comment is cited via implemented_by is
    // checked by pass C exactly like one cited in base evidence.
    const decision: AtlasNode = {
      type: "decision",
      id: "d-issue-implemented",
      title: "t",
      question: "q",
      decision: "d",
      why: "w",
      rejected: [],
      status: "decided_and_built",
      implemented_by: [{ kind: "issue", number: 42, comment_id: 7 }],
      soundbite: "s",
      evidence: [],
      confidence: "attested",
      interview_value: 5,
    };
    const withDecision = {
      ...ctx,
      atlas: {
        ...atlas,
        nodes: [decision],
        synopsis: { ...atlas.synopsis, evidence: [] },
        shape: { ...atlas.shape, evidence: [] },
      },
    } as AuditContext;
    const cited = issueCitations(withDecision.atlas);
    expect(cited).toEqual([{ owner: "d-issue-implemented", e: { kind: "issue", number: 42, comment_id: 7 } }]);
    const { result } = await resolveIssueCitations(withDecision, issueStore([cachedIssue(42, [7])]));
    expect(result.outcome).toBe("passed");
    expect(result.count).toBe(1);
  });

  it("is not applicable when the graph cites no issues", async () => {
    const noIssues = {
      ...ctx,
      atlas: { ...atlas, nodes: [], synopsis: { ...atlas.synopsis, evidence: [] }, shape: { ...atlas.shape, evidence: [] } },
    } as AuditContext;
    const { result } = await resolveIssueCitations(noIssues, issueStore([]));
    expect(result.outcome).toBe("not_applicable");
    expect(result.reason).toBeTruthy();
  });

  it("attributes its own failure to L3, not to the pass before it", async () => {
    // Sharing pass B's boundary would have reported this as "pass B could not
    // run" - a true-shaped sentence about the wrong pass - and dropped L3.
    const checks = (
      await runPassC(
        ctx,
        issueStore([], async () => {
          throw new Error("github is unreachable");
        }),
      )
    ).checks;
    expect(checks.map((c) => c.id)).toEqual(["L3"]);
    expect(checks[0]!.aborted).toBe(true);
    expect(checks[0]!.findings?.[0]).toContain("github is unreachable");
  });
});

/* ------------------------------------------------------- pass D */

const judgeAll = (supported: boolean): Judge => async () => ({ supported, note: "n" });
// A node whose evidence all resolves is judged; one whose evidence resolves to
// nothing is named but not weighed. These two isolate the two paths: resolveText
// so every node reaches the judge, resolveNothing so none does.
const resolveText = { resolve: () => "evidence text" };
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
    await absenceWitness(atlas.nodes, { judge, ...resolveText });
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
      ...resolveText,
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

  it("reports not run naming the git cause when evidence cannot be resolved", async () => {
    // Resolving evidence reads git, which can throw. That is a claim about the
    // audit's own clone, never about the model, so it must not be labelled as the
    // model becoming unreachable, must not crash out to the run's boundary, and
    // must never fail the artifact. The judge is not even reached.
    let judgeCalls = 0;
    const judge: Judge = async () => {
      judgeCalls += 1;
      return { supported: true, note: "n" };
    };
    const result = await proseSupport(atlas.nodes, {
      judge,
      resolve: () => {
        throw new GitError("git cat-file -p abc123:Foo.java could not run in /clone");
      },
    });
    expect(judgeCalls).toBe(0);
    expect(result.outcome).toBe("not_run");
    expect(result.aborted).toBeUndefined();
    expect(result.reason).toContain("could not be read from the local clone");
    expect(result.reason).toContain("git cat-file");
    // The honest cause, not the wrong one: a git failure is not a dead model.
    expect(result.reason).not.toMatch(/became unreachable|after judging/);
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

  it("resolves issue evidence to text from the harvest cache, comment id first", () => {
    // A decision node's support IS its cited resolution comment; the resolver must
    // hand that text to the judge, not drop it and invite a spurious overclaim.
    const cached = [cachedIssue(2, [7])];
    const resolve = evidenceResolver(ctx, issueStore(cached));
    // A comment id resolves to that comment's body; no comment id, the issue body.
    expect(resolve({ kind: "issue", number: 2, comment_id: 7 })).toBe("## Resolution: x");
    expect(resolve({ kind: "issue", number: 2 })).toBe("b");
    // A cache miss - issue or comment - resolves to nothing, for the guard to name.
    expect(resolve({ kind: "issue", number: 99 })).toBeUndefined();
    expect(resolve({ kind: "issue", number: 2, comment_id: 999 })).toBeUndefined();
    // Command evidence is its captured excerpt; the switch is exhaustive over kinds.
    expect(resolve({ kind: "command", cmd: "x", output_excerpt: "captured" })).toBe("captured");
  });

  it("names but does not judge a node whose evidence all fails to resolve", async () => {
    // A verdict against "(none resolved)" is meaningless in either direction, so
    // the node is named in the reason and left out of the count rather than
    // weighed against nothing - the same evidence-fidelity discipline as L2.
    const withEvidence = atlas.nodes.find((n) => n.evidence.length > 0)!;
    let judged = 0;
    const judge: Judge = async () => {
      judged += 1;
      return { supported: true, note: "n" };
    };
    const result = await proseSupport([withEvidence], { judge, ...resolveNothing });
    expect(judged).toBe(0);
    expect(result.outcome).toBe("passed");
    expect(result.count).toBe(0);
    expect(result.reason).toMatch(/named but not weighed/);
    expect(result.reason).toContain(withEvidence.id);
  });

  it("weighs a decision's implemented_by, not just its base evidence", async () => {
    // nodeEvidence is the one definition of a node's evidence: a decision whose
    // provenance lives entirely in implemented_by is evidenced by that, and its
    // prose must be judged against it - dropping it would read the support as an
    // overclaim, the same evidence-fidelity gap as the line-range and issue fixes.
    const decision: AtlasNode = {
      type: "decision",
      id: "d-only-implemented",
      title: "t",
      question: "q",
      decision: "d",
      why: "w",
      rejected: [],
      status: "decided_and_built",
      implemented_by: [{ kind: "file", path: "Foo.java", line_start: 1, line_end: 3, sha: "x" }],
      soundbite: "s",
      evidence: [],
      confidence: "attested",
      interview_value: 5,
    };
    // With the implemented_by file resolving, the node is judged and its evidence
    // reaches the model - not caught by the no-resolvable-evidence guard.
    let seen = -1;
    const judge: Judge = async (request) => {
      seen = request.evidence.length;
      return { supported: true, note: "n" };
    };
    const judged = await proseSupport([decision], { judge, ...resolveText });
    expect(seen).toBe(1);
    expect(judged.count).toBe(1);
    expect(judged.reason).toBeUndefined();

    // With nothing resolving, the same node is named but not weighed - it is NOT
    // treated as "genuinely no evidence", because implemented_by is evidence.
    let calls = 0;
    const counting: Judge = async () => {
      calls += 1;
      return { supported: true, note: "n" };
    };
    const withheld = await proseSupport([decision], { judge: counting, ...resolveNothing });
    expect(calls).toBe(0);
    expect(withheld.count).toBe(0);
    expect(withheld.reason).toMatch(/named but not weighed/);
    expect(withheld.reason).toContain("d-only-implemented");
  });

  it("still judges a node that genuinely cites no evidence", async () => {
    // "This node cites nothing" is itself something the model can weigh; only a
    // node whose citations FAILED to resolve is withheld, never one with none.
    const bare = { ...atlas.nodes[0]!, evidence: [] } as AtlasNode;
    let seen = -1;
    const judge: Judge = async (request) => {
      seen = request.evidence.length;
      return { supported: true, note: "n" };
    };
    const result = await proseSupport([bare], { judge, ...resolveNothing });
    expect(seen).toBe(0);
    expect(result.count).toBe(1);
    expect(result.reason).toBeUndefined();
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
      const checks = await runPassD(ctx, { judge: judgeAll(answer), ...resolveText });
      expect(checks.some(isGateFailure), `judge answering ${answer}`).toBe(false);
      expect(checks.every((c) => c.class === "warning")).toBe(true);
    }
  });

  it("produces no gate failure when the judge refuses every node", async () => {
    const checks = await runPassD(ctx, { judge: judgeAll(false), ...resolveText });
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
    const checks = await runPassD(ctx, { judge: throwing, ...resolveText });
    for (const c of checks) {
      expect(c.outcome).toBe("not_run");
      expect(c.aborted).toBeUndefined();
      expect(c.reason).toContain("model unavailable");
      expect(c.reason).toMatch(/never decides whether an artifact ships/);
    }
    expect(checks.some(isGateFailure)).toBe(false);
  });

  it("does not spend the model pass when pass C's L3 gate has already failed", async () => {
    // Pass D is the only expensive pass, so a doomed artifact must never reach it.
    // A cited issue that does not resolve against a cache that would know is an L3
    // gate failure - the artifact has already failed - and M1/M2 must then report
    // not_run with the honest reason, not warnings, and the judge must never run.
    let judgeCalls = 0;
    const judge: Judge = async () => {
      judgeCalls += 1;
      return { supported: true, note: "n" };
    };
    const { checks, passes } = await runLaterPasses(ctx, {
      issues: issueStore(fullCache().slice(1)),
      model: { judge, resolve: () => "evidence text" },
    });

    expect(judgeCalls).toBe(0);
    const l3 = checks.find((c) => c.id === "L3")!;
    expect(l3.outcome).toBe("failed");
    for (const id of ["M1", "M2"]) {
      const c = checks.find((x) => x.id === id)!;
      expect(c.outcome, id).toBe("not_run");
      expect(c.aborted, id).toBeUndefined();
      expect(c.reason, id).toMatch(/an earlier gate failed, so the model pass was not spent/);
    }
    expect(passes).toEqual(["C", "D"]);
  });

  it("spends the model pass when pass C's L3 gate passes", async () => {
    // The other direction, so the guard above is the block and not a dead path: a
    // clean L3 leaves pass D free to run and the judge is called.
    let judgeCalls = 0;
    const judge: Judge = async () => {
      judgeCalls += 1;
      return { supported: true, note: "n" };
    };
    const { checks } = await runLaterPasses(ctx, {
      issues: issueStore(fullCache()),
      model: { judge, resolve: () => "evidence text" },
    });

    expect(judgeCalls).toBeGreaterThan(0);
    expect(checks.find((c) => c.id === "L3")!.outcome).toBe("passed");
    for (const id of ["M1", "M2"]) {
      expect(checks.find((x) => x.id === id)!.outcome).toBe("passed");
    }
  });

  it("drops a partial sweep rather than enumerating it as the whole set", async () => {
    // A truncated warning list presented as complete is the same lie as silence.
    let calls = 0;
    const throwing: Judge = async () => {
      if ((calls += 1) > 2) throw new Error("gone");
      return { supported: false, note: "overclaims" };
    };
    const [m1] = await runPassD(ctx, { judge: throwing, ...resolveText });
    expect(m1!.findings).toBeUndefined();
    expect(m1!.reason).toMatch(/after judging 2 of \d+ nodes/);
  });
});

/* --------------------------- E1: one issue store shared by passes C and D */

describe("passes C and D read the same issue store", () => {
  const issueOnlyDecision: AtlasNode = {
    type: "decision",
    id: "d-issue-only",
    title: "t",
    question: "q",
    decision: "d",
    why: "w",
    rejected: [],
    status: "decided_and_built",
    implemented_by: [{ kind: "issue", number: 77, comment_id: 5 }],
    soundbite: "s",
    evidence: [],
    confidence: "attested",
    interview_value: 5,
  };
  const graphOf = (node: AtlasNode): AuditContext =>
    ({
      ...ctx,
      atlas: {
        ...atlas,
        nodes: [node],
        synopsis: { ...atlas.synopsis, evidence: [] },
        shape: { ...atlas.shape, evidence: [] },
      },
    }) as AuditContext;

  it("lets pass D judge a node whose only evidence is an issue pass C had to fetch", async () => {
    // The cold-cache failure this closes: pass C fetches the missing issue and
    // passes L3, but a pass D resolver built from the disk snapshot never sees
    // that fetch and names the node "not weighed". One store per run, handed to
    // both, makes what C fetched visible to D by construction.
    const graph = graphOf(issueOnlyDecision);
    const fetched: number[] = [];
    const store = issueStore([], async (n) => {
      fetched.push(n);
      return n === 77 ? cachedIssue(77, [5]) : undefined;
    });

    let seenEvidence = -1;
    const judge: Judge = async (request) => {
      seenEvidence = request.evidence.length;
      return { supported: true, note: "n" };
    };

    const { checks } = await runLaterPasses(graph, {
      issues: store,
      model: { judge, resolve: evidenceResolver(graph, store) },
    });

    // Pass C reached the network exactly once, for the id the cold cache lacked.
    expect(fetched).toEqual([77]);
    expect(checks.find((c) => c.id === "L3")!.outcome).toBe("passed");

    // Pass D read the SAME store, so the fetched comment body reached the judge
    // and the node was judged - not named not weighed against a disk snapshot.
    const m1 = checks.find((c) => c.id === "M1")!;
    expect(seenEvidence).toBe(1);
    expect(m1.count).toBe(1);
    expect(m1.reason).toBeUndefined();
  });

  it("resolves a fetched issue once and memoizes it in the store", async () => {
    // The per-run memoization lives in the store, not in resolveIssueCitations'
    // local map, so a repeated citation of a fetched issue is asked once and its
    // resolved copy is the one pass D then reads.
    let fetches = 0;
    const store = issueStore([], async (n) => {
      fetches += 1;
      return n === 77 ? cachedIssue(77, [5]) : undefined;
    });
    await store.resolve(77);
    await store.resolve(77);
    expect(fetches).toBe(1);
    expect(store.fetched).toBe(1);
    expect(store.resolved().map((i) => i.number)).toEqual([77]);
  });
});
