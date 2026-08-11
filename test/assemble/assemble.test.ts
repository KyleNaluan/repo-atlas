/**
 * The assemble stage.
 *
 * Two properties carry most of the weight here. The stage may not add a claim -
 * every field it writes has to be traceable to an earlier stage's output, so the
 * tests check the copies rather than the shapes. And the record is written for
 * every subject, not only thin ones, because reporting provenance conditionally
 * leaks the output tier #6 rejected.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assemble, absentCutsOf, AssembleError } from "../../src/assemble/assemble.js";
import { validateAtlas } from "../../src/schema/validate.js";
import { SCHEMA_VERSION } from "../../src/schema/types.js";
import type { Atlas, AtlasNode, Shape, Synopsis } from "../../src/schema/types.js";
import type { Harvest } from "../../src/harvest/types.js";
import type { GatedCandidate } from "../../src/gate/gate.js";
import type { RankResult } from "../../src/rank/rank.js";

const reference = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/swe-prep.atlas.json", import.meta.url)), "utf8"),
) as Atlas;

const SHA = "086c99998ba6eec1353988cd88989cbe836fe6a0";

const harvestFor = (over: Partial<Harvest> = {}): Harvest =>
  ({
    harvest_version: "1.0.0",
    subject: {
      owner: "KyleNaluan",
      repo: "swe-prep",
      url: "https://github.com/KyleNaluan/swe-prep",
      branch: "main",
      sha: SHA,
      read_on: "2026-08-10",
      visibility: "public",
    },
    issues: [],
    scale: { files: 3, lines: 40, commits: 47, first_commit: null, last_commit: null, days: null },
    density: {
      closed_issues_with_resolution_comment: { value: 9, of: 9 },
      comment_to_body_ratio: { value: 3.4, note: "resolution comments run long" },
      source_files_citing_issues: { value: 0, of: 3 },
      adr_directory: { value: false, note: "no docs/adr directory" },
    },
    sources: [
      {
        source: "GitHub issue resolution comments",
        what_existed: "9 closed decision issues",
        fetched: "in full via gh api",
        admissible_as: "attested",
      },
    ],
    private_split: { declared: false, readable_at_harvest: false },
    memory_files: [],
    ...over,
  }) as Harvest;

const node = (over: Partial<AtlasNode> & Pick<AtlasNode, "type" | "id">): AtlasNode => {
  const base = { title: "t", evidence: [], confidence: "verified" as const, interview_value: 4 };
  switch (over.type) {
    case "mechanism":
      return { ...base, what: "w", why_interesting: "y", enforcement: "test-level", gotchas: [], ...over } as AtlasNode;
    case "decision":
      return {
        ...base,
        question: "q",
        decision: "d",
        why: "w",
        rejected: [],
        status: "decided_and_built",
        implemented_by: [],
        soundbite: "s",
        ...over,
      } as AtlasNode;
    case "fact":
      return { ...base, label: "l", value: "v", ...over } as AtlasNode;
    default:
      return { ...base, kind: "tradeoff", statement: "s", why_it_matters: "w", how_to_say_it: "h", ...over } as AtlasNode;
  }
};

const gatedFor = (nodes: AtlasNode[], verdict: GatedCandidate["verdict"] = "confirmed"): GatedCandidate[] =>
  nodes.map((n) => ({ probe_id: "p", node: n, verdict, finding: "the tree holds it" }));

const rankedFor = (nodes: AtlasNode[], over: Partial<RankResult> = {}): RankResult => ({
  nodes,
  deletions: [],
  profile: "interview",
  rubric_version: "v1",
  budgets: { mechanisms: 5, interview_value_floor: 3 },
  ...over,
});

const PROSE: { synopsis: Synopsis; shape: Shape } = {
  synopsis: { statement: "A thing that does a thing.", evidence: [{ kind: "file", path: "README.md", sha: SHA }] },
  shape: { tree: "root/\n  src/", evidence: [{ kind: "file", path: ".", sha: SHA }] },
};

const build = (nodes: AtlasNode[], over: Partial<Parameters<typeof assemble>[0]> = {}): Atlas =>
  assemble({
    harvest: harvestFor(),
    gated: gatedFor(nodes),
    ranked: rankedFor(nodes),
    ...PROSE,
    generatedAt: "2026-08-11T00:00:00Z",
    ...over,
  });

/* ------------------------------------------------- the contract */

describe("what assemble produces is a valid atlas", () => {
  it("satisfies the generated schema", () => {
    const atlas = build([node({ type: "mechanism", id: "m-1" })]);
    expect(() => validateAtlas(atlas)).not.toThrow();
    expect(atlas.schema_version).toBe(SCHEMA_VERSION);
  });

  it("assembles the same bytes from the same inputs", () => {
    // Determinism is the reason generated_at is injected rather than read from
    // the clock: a stage that cannot reproduce its own output cannot be pinned.
    const nodes = [node({ type: "mechanism", id: "m-1" })];
    expect(JSON.stringify(build(nodes))).toBe(JSON.stringify(build(nodes)));
  });

  it("carries the subject through verbatim, pinned SHA included", () => {
    const atlas = build([node({ type: "fact", id: "f-1" })]);
    expect(atlas.subject).toEqual(harvestFor().subject);
    expect(atlas.subject.sha).toBe(SHA);
  });

  it("takes the profile and rubric version from the stage that ranked under them", () => {
    const atlas = build([node({ type: "fact", id: "f-1" })]);
    expect(atlas.profile).toBe("interview");
    expect(atlas.rubric_version).toBe("v1");
  });

  it("reports the audit as not run, never as anything softer", () => {
    // The audit rewrites this in place afterwards. Any other default would have
    // the document claim a verification nobody performed.
    expect(build([node({ type: "fact", id: "f-1" })]).record.audit).toEqual({ status: "not_run" });
  });
});

/* ------------------------------------------------- adds no claim */

describe("assemble restates and never adds", () => {
  it("copies harvest's sources and measurements rather than recomputing them", () => {
    const h = harvestFor();
    const atlas = build([node({ type: "fact", id: "f-1" })], { harvest: h });
    expect(atlas.record.sources).toEqual(h.sources);
    expect(atlas.record.density_signals["closed_issues_with_resolution_comment"]).toEqual({
      value: 9,
      of: 9,
    });
    expect(atlas.record.density_signals["adr_directory"]).toEqual({
      value: false,
      note: "no docs/adr directory",
    });
  });

  it("carries rank's deletion record and budgets verbatim", () => {
    const nodes = [node({ type: "mechanism", id: "m-1" })];
    const deletions = [{ id: "m-9", score: 2, reason: "below the floor", kind: "floor" as const }];
    const atlas = build(nodes, { ranked: rankedFor(nodes, { deletions }) });
    expect(atlas.record.deletions).toEqual(deletions);
    expect(atlas.record.budgets).toEqual({ mechanisms: 5, interview_value_floor: 3 });
  });

  it("refuses a ranked node the gate never saw", () => {
    // Nodes gated against one tree and ranked from another would produce a
    // document whose citations resolve at a SHA it does not name.
    const gatedNodes = [node({ type: "mechanism", id: "m-1" })];
    expect(() =>
      build(gatedNodes, { ranked: rankedFor([node({ type: "mechanism", id: "m-stray" })]) }),
    ).toThrow(AssembleError);
  });

  it("refuses to write a blank product sentence", () => {
    expect(() =>
      build([node({ type: "fact", id: "f-1" })], {
        synopsis: { statement: "   ", evidence: [] },
      }),
    ).toThrow(/asserts nothing and admits nothing/);
  });
});

/* ------------------------------------------------- the record */

describe("the provenance record is written for every subject", () => {
  it("names every section, including the ones nothing reached", () => {
    // A section that reports nothing must still appear saying so; deriving the
    // list from surviving nodes would make an absent section vanish from the
    // table that exists to name it.
    const atlas = build([node({ type: "mechanism", id: "m-1" })]);
    expect(Object.keys(atlas.record.section_presence).sort()).toEqual(
      ["decisions", "edges", "facts", "flows", "mechanisms", "shape", "synopsis"].sort(),
    );
    expect(atlas.record.section_presence["mechanisms"]).toBe("present");
    expect(atlas.record.section_presence["flows"]).toBe("absent");
  });

  it("reports the decision section absent when no decision survived", () => {
    const atlas = build([node({ type: "mechanism", id: "m-1" })]);
    expect(atlas.record.section_presence["decisions"]).toBe("absent");
  });

  it("reports the decision section partial when the record yielded some and lost others", () => {
    // The one section carrying a third state (#6), because it is the only one
    // making a claim about a record rather than about the tree.
    const kept = node({ type: "decision", id: "d-1" });
    const lost = node({ type: "decision", id: "d-2" });
    const atlas = build([kept], {
      gated: [...gatedFor([kept]), ...gatedFor([lost], "unresolved")],
    });
    expect(atlas.record.section_presence["decisions"]).toBe("partial");
  });

  it("reports the decision section present when nothing decision-shaped was lost", () => {
    const kept = node({ type: "decision", id: "d-1" });
    expect(build([kept]).record.section_presence["decisions"]).toBe("present");
  });

  it("counts the ledger off what shipped and what evidence lost", () => {
    const verified = node({ type: "mechanism", id: "m-1", confidence: "verified" });
    const attested = node({ type: "mechanism", id: "m-2", confidence: "attested" });
    const lost = node({ type: "edge", id: "e-1" });
    const atlas = build([verified, attested], {
      gated: [...gatedFor([verified, attested]), ...gatedFor([lost], "overturned")],
    });
    expect(atlas.record.confidence_ledger).toEqual({ verified: 1, attested: 1, absent_cut: 1 });
  });

  it("does not count a budget deletion as an evidence failure", () => {
    // A node cut to fit a section budget was evidenced. Folding it into the
    // evidence ledger would report the artifact as less verified than it is.
    const nodes = [node({ type: "mechanism", id: "m-1" })];
    const atlas = build(nodes, {
      ranked: rankedFor(nodes, {
        deletions: [{ id: "m-9", score: 4, reason: "cut to fit", kind: "budget", section: "mechanisms" }],
      }),
    });
    expect(atlas.record.confidence_ledger.absent_cut).toBe(0);
    expect(atlas.record.deletions).toHaveLength(1);
  });

  it("withholds the claim text of an absent cut, reporting only type and reason", () => {
    // #7's absent-cut-disclosure ruling: printing the claim would reintroduce,
    // in the provenance section, the unevidenced assertion the cut removed.
    const lost = node({ type: "edge", id: "e-1", statement: "SOMETHING UNPROVEN" } as never);
    const cuts = absentCutsOf(gatedFor([lost], "unresolved"));
    expect(cuts).toHaveLength(1);
    expect(JSON.stringify(cuts)).not.toContain("SOMETHING UNPROVEN");
    expect(cuts[0]!.candidate_type).toBe("edge");
    expect(cuts[0]!.reason).toBeTruthy();
  });

  it("records a declared private split, and omits the block when there is none", () => {
    const split = {
      declared: true,
      repo: "KyleNaluan/swe-prep-content",
      readable_at_harvest: false,
      note: "read only the public side",
    };
    const withSplit = build([node({ type: "fact", id: "f-1" })], {
      harvest: harvestFor({ private_split: split }),
    });
    expect(withSplit.record.private_source).toEqual(split);
    expect(build([node({ type: "fact", id: "f-1" })]).record.private_source).toBeUndefined();
  });
});

/* ------------------------------------------------- against the reference */

describe("the shape it produces matches the reference artifact's", () => {
  it("writes every record field the hand-made reference carries", () => {
    // The reference fixture is the #7 prototype's recast of the hand-made
    // overview. A field it carries and this stage never writes would be a hole
    // that only shows up as a thinner artifact at the far end of the pipeline.
    const atlas = build([node({ type: "mechanism", id: "m-1" })]);
    for (const key of Object.keys(reference.record)) {
      if (key === "private_source") continue; // conditional by design; covered above
      expect(atlas.record, key).toHaveProperty(key);
    }
  });

  it("computes a ledger the hand-made reference's own numbers disagree with", () => {
    // Pinned rather than accommodated, on the precedent #7's report set for the
    // fixture's floor discrepancy: the reference is hand-authored, its ledger
    // says 21 verified and 9 attested, and its own 33 nodes are 25 and 8. A
    // stage that reproduced the recorded numbers would be reproducing an error;
    // the ledger is a count of what is there, so assemble counts it.
    const byConfidence = (c: string) => reference.nodes.filter((n) => n.confidence === c).length;
    expect(byConfidence("verified")).toBe(25);
    expect(byConfidence("attested")).toBe(8);
    expect(reference.record.confidence_ledger.verified).toBe(21);
    expect(reference.record.confidence_ledger.attested).toBe(9);

    const atlas = build(reference.nodes, {
      gated: gatedFor(reference.nodes),
      ranked: rankedFor(reference.nodes),
    });
    expect(atlas.record.confidence_ledger).toEqual({ verified: 25, attested: 8, absent_cut: 0 });
  });

  it("names the same sections the reference does", () => {
    const atlas = build([node({ type: "mechanism", id: "m-1" })]);
    expect(Object.keys(atlas.record.section_presence).sort()).toEqual(
      Object.keys(reference.record.section_presence).sort(),
    );
  });
});
