/**
 * `sliceLines` extracts the cited span of a blob. The line range is the part of
 * a file citation that pins the claim, so the model pass must weigh prose against
 * that span - not the file's head, which a long-file citation past the judge's
 * truncation limit would never contain.
 */
import { describe, expect, it } from "vitest";
import { sliceLines } from "../../src/audit/git.js";

const blob = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

describe("sliceLines returns the 1-based inclusive cited span", () => {
  it("returns exactly the range start..end", () => {
    expect(sliceLines(blob, 3, 5)).toBe("line 3\nline 4\nline 5");
  });

  it("returns a single line when no end is given", () => {
    expect(sliceLines(blob, 4)).toBe("line 4");
  });

  it("returns the first line for start 1", () => {
    expect(sliceLines(blob, 1, 1)).toBe("line 1");
  });

  it("shows the cited tail of a file, not its head", () => {
    // The exact defect: a citation deep in a file must resolve to that region,
    // never to the file's beginning.
    expect(sliceLines(blob, 9, 10)).toBe("line 9\nline 10");
    expect(sliceLines(blob, 9, 10)).not.toContain("line 1\n");
  });
});
