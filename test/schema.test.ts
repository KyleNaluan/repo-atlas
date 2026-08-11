/**
 * The contract's own tests.
 *
 * Two things are being pinned here. First, that the generated schema actually
 * accepts real documents - the #7 prototype's 33-node recast of the hand-made
 * swe-prep overview, and its decision-poor variant. Second, and more important,
 * that validation FAILS CLOSED: #3 makes `atlas.json` a stable contract with a
 * separate consumer, and a validator that waves through a malformed document is
 * worse than no validator, because it launders the malformation as checked.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AtlasValidationError, loadAtlas, validateAtlas } from "../src/schema/validate.js";
import { SCHEMA_VERSION, admissible, isType, type Atlas } from "../src/schema/types.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const read = (name: string): Atlas =>
  JSON.parse(readFileSync(fixture(name), "utf8")) as Atlas;

/** Structured clone, so a mutation in one case cannot leak into another. */
const mutate = (name: string, f: (a: Atlas) => void): unknown => {
  const a = read(name);
  f(a);
  return a;
};

const problemsOf = (value: unknown): string[] => {
  try {
    validateAtlas(value, "<test>");
  } catch (e) {
    if (e instanceof AtlasValidationError) return e.problems;
    throw e;
  }
  throw new Error("expected validation to fail, but it passed");
};

describe("the generated schema accepts real documents", () => {
  it("validates the swe-prep recast (33 nodes, all six node types)", () => {
    const atlas = loadAtlas(fixture("swe-prep.atlas.json"));
    expect(atlas.subject.repo).toBe("swe-prep");
    expect(atlas.nodes).toHaveLength(33);
    const types = new Set(atlas.nodes.map((n) => n.type));
    expect([...types].sort()).toEqual([
      "boundary",
      "decision",
      "edge",
      "fact",
      "flow",
      "mechanism",
    ]);
  });

  it("validates the decision-poor variant, which is the degradation path's shape", () => {
    const atlas = loadAtlas(fixture("degraded.atlas.json"));
    expect(atlas.nodes.filter(isType("decision"))).toHaveLength(0);
    expect(atlas.record.section_presence["decisions"]).toBe("absent");
  });

  it("agrees with the version this build reads", () => {
    expect(read("swe-prep.atlas.json").schema_version.split(".")[0]).toBe(
      SCHEMA_VERSION.split(".")[0],
    );
  });
});

describe("validation fails closed", () => {
  it("refuses a non-object", () => {
    expect(problemsOf(["not", "an", "atlas"])).toEqual(["(root) must be an object"]);
    expect(problemsOf(null)).toEqual(["(root) must be an object"]);
  });

  it("refuses a document missing a required top-level block", () => {
    const problems = problemsOf(
      mutate("swe-prep.atlas.json", (a) => {
        delete (a as Partial<Atlas>).record;
      }),
    );
    expect(problems.join("\n")).toMatch(/record/);
  });

  it("refuses an unknown property rather than ignoring it", () => {
    const problems = problemsOf(
      mutate("swe-prep.atlas.json", (a) => {
        (a as unknown as Record<string, unknown>)["extrapolated_summary"] = "invented";
      }),
    );
    expect(problems.join("\n")).toContain("extrapolated_summary");
  });

  it("refuses a confidence level outside the three-level gate", () => {
    const problems = problemsOf(
      mutate("swe-prep.atlas.json", (a) => {
        (a.nodes[0] as { confidence: string }).confidence = "probably";
      }),
    );
    expect(problems.join("\n")).toMatch(/verified.*attested.*absent/s);
  });

  it("refuses an enforcement value outside the enum", () => {
    const problems = problemsOf(
      mutate("swe-prep.atlas.json", (a) => {
        const m = a.nodes.find(isType("mechanism"))!;
        (m as { enforcement: string }).enforcement = "vibes";
      }),
    );
    expect(problems.join("\n")).toMatch(/type-level|query-level|test-level|convention/);
  });

  it("refuses a Decision with no rejected[] entry and no explicit-absence flag", () => {
    // #3: rejected[] uses explicit-absence semantics - a Decision needs either a
    // populated rejected[] or the flag. Dropping the field entirely must fail.
    const problems = problemsOf(
      mutate("swe-prep.atlas.json", (a) => {
        const d = a.nodes.find(isType("decision"))!;
        delete (d as Partial<typeof d>).rejected;
      }),
    );
    expect(problems.join("\n")).toMatch(/rejected/);
  });

  it("refuses evidence that is not one of the three admissible kinds", () => {
    const problems = problemsOf(
      mutate("swe-prep.atlas.json", (a) => {
        a.nodes[0]!.evidence = [
          { kind: "vibe", claim: "it felt true" } as never,
        ];
      }),
    );
    expect(problems.length).toBeGreaterThan(0);
  });

  it("refuses a future major, rather than best-effort reading it", () => {
    const problems = problemsOf(
      mutate("swe-prep.atlas.json", (a) => {
        a.schema_version = "2.0.0";
      }),
    );
    expect(problems.join("\n")).toContain("major 2");
    expect(problems.join("\n")).toContain("Refusing");
  });

  it("accepts an additive minor within the major, per the additive-only rule", () => {
    expect(() =>
      validateAtlas(
        mutate("swe-prep.atlas.json", (a) => {
          a.schema_version = "1.7.3";
        }),
        "<test>",
      ),
    ).not.toThrow();
  });

  it("reports every problem at once, not the first one", () => {
    const problems = problemsOf(
      mutate("swe-prep.atlas.json", (a) => {
        (a.nodes[0] as { confidence: string }).confidence = "probably";
        (a.nodes[1] as unknown as { interview_value: string }).interview_value = "high";
      }),
    );
    expect(problems.length).toBeGreaterThan(1);
  });

  it("names the source in the message, so a pipeline failure says which file", () => {
    try {
      loadAtlas(fixture("does-not-exist.json"));
      throw new Error("expected a failure");
    } catch (e) {
      expect(e).toBeInstanceOf(AtlasValidationError);
      expect((e as AtlasValidationError).message).toContain("does-not-exist.json");
    }
  });
});

describe("the render gate is one function, applied to whole documents", () => {
  it("cuts absent-confidence nodes and keeps the other two levels", () => {
    expect(admissible({ confidence: "verified" } as never)).toBe(true);
    expect(admissible({ confidence: "attested" } as never)).toBe(true);
    expect(admissible({ confidence: "absent" } as never)).toBe(false);
  });
});
