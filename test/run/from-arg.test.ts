/**
 * `--from` is validated against the pipeline before any work begins.
 *
 * An unrecognised value used to reach `plan()`, where `PIPELINE.indexOf(from)`
 * returned -1 and forced every stage - silently re-harvesting over the network
 * and re-paying for the model instead of reporting the typo. `isStageName` is the
 * guard the command applies to the raw string; the predicate lives in the
 * model-free `run` module so this coverage needs no credential to run.
 */
import { describe, expect, it } from "vitest";
import { isStageName, PIPELINE } from "../../src/run/run.js";

describe("--from validation", () => {
  it("accepts every real stage name", () => {
    for (const stage of PIPELINE) expect(isStageName(stage)).toBe(true);
  });

  it("rejects a typo, so the command reports it rather than forcing a full re-run", () => {
    expect(isStageName("renderr")).toBe(false);
    expect(isStageName("")).toBe(false);
    expect(isStageName("HARVEST")).toBe(false);
  });
});
