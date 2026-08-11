/**
 * The single link authority.
 *
 * The SHA-pin assertion is the point of this file. An artifact whose whole claim
 * is "pinned at this commit" cannot contain a link to a different one, and the
 * prototype trusted its input. #7's section 7 puts the guard here; #8's L5
 * asserts the same property again from outside, on the rendered file, because
 * this guard protects against a bad Evidence object and L5 protects against a
 * renderer change that stops calling this function.
 */
import { describe, expect, it } from "vitest";
import {
  renderEvidence,
  shortPath,
  UnpinnedEvidenceError,
  commitUrl,
} from "../../src/render/links.js";
import type { Subject } from "../../src/schema/types.js";

const SHA = "086c99998ba6eec1353988cd88989cbe836fe6a0";

const subject: Subject = {
  owner: "KyleNaluan",
  repo: "swe-prep",
  url: "https://github.com/KyleNaluan/swe-prep",
  branch: "main",
  sha: SHA,
  read_on: "2026-08-10",
  visibility: "public",
};

describe("file evidence", () => {
  it("pins path and line range into the URL fragment", () => {
    const r = renderEvidence(
      { kind: "file", path: "backend/src/main/java/Grader.java", line_start: 23, line_end: 27, sha: SHA },
      subject,
    );
    expect(r.href).toBe(`${subject.url}/blob/${SHA}/backend/src/main/java/Grader.java#L23-L27`);
    expect(r.label).toBe("java/Grader.java:23-27");
  });

  it("collapses a one-line range", () => {
    const r = renderEvidence({ kind: "file", path: "a/b.java", line_start: 9, line_end: 9, sha: SHA }, subject);
    expect(r.href).toContain("#L9");
    expect(r.href).not.toContain("-L9");
  });

  it("refuses evidence pinned to a different commit", () => {
    expect(() =>
      renderEvidence({ kind: "file", path: "pom.xml", sha: "deadbeef".repeat(5) }, subject),
    ).toThrow(UnpinnedEvidenceError);
  });

  it("names both SHAs in the failure, so the mismatch is obvious", () => {
    try {
      renderEvidence({ kind: "file", path: "pom.xml", sha: "0".repeat(40) }, subject);
      throw new Error("expected a failure");
    } catch (e) {
      expect((e as Error).message).toContain("0".repeat(40));
      expect((e as Error).message).toContain(SHA);
    }
  });
});

describe("issue evidence", () => {
  it("links a comment distinctly from its issue body", () => {
    const body = renderEvidence({ kind: "issue", number: 2 }, subject);
    const comment = renderEvidence({ kind: "issue", number: 2, comment_id: 5181222288 }, subject);
    expect(body.href).toBe(`${subject.url}/issues/2`);
    expect(comment.href).toBe(`${subject.url}/issues/2#issuecomment-5181222288`);
    expect(body.key).not.toBe(comment.key);
  });

  it("gives two comments on one issue two different keys", () => {
    const a = renderEvidence({ kind: "issue", number: 2, comment_id: 5181222288 }, subject);
    const b = renderEvidence({ kind: "issue", number: 2, comment_id: 5243059657 }, subject);
    expect(a.key).not.toBe(b.key);
  });
});

describe("command evidence", () => {
  it("has no href, because there is nothing on GitHub to point at", () => {
    const r = renderEvidence(
      { kind: "command", cmd: "./test.sh", output_excerpt: "Tests run: 466" },
      subject,
    );
    expect(r.href).toBeNull();
    expect(r.output).toBe("Tests run: 466");
  });
});

describe("path labels", () => {
  it("keeps the last two segments", () => {
    expect(shortPath("a/b/c/d.java")).toBe("c/d.java");
    expect(shortPath("pom.xml")).toBe("pom.xml");
  });
});

describe("subject links", () => {
  it("points at the pinned commit, not the branch", () => {
    expect(commitUrl(subject)).toContain(SHA);
  });
});
