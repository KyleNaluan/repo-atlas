/**
 * The harvest contract.
 *
 * Most of this is hermetic: a synthetic git repository for the tree half, and
 * hand-built issue shapes for the completeness half. The exception is the
 * tripwire at the bottom, which is network-dependent by design (#4) - a fixture
 * pinned to a real comment's exact byte length and SHA-256, so that if the
 * fetch path ever starts truncating again, something fails rather than everyone
 * getting a slightly shorter decision record.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cacheKey,
  cacheKeyString,
  hasResolutionComment,
  harvestIssue,
  IncompleteHarvestError,
  isIssue,
} from "../../src/harvest/issues.js";
import {
  fileIssueCache,
  memoryIssueCache,
  resolveComment,
  resolveIssue,
} from "../../src/harvest/cache.js";
import {
  countSourceFilesCitingIssues,
  detectPrivateSplit,
  findAdrDirectory,
  indexMemoryFiles,
  isSourceFile,
  measureScale,
  ShallowCloneError,
  subjectRemote,
} from "../../src/harvest/tree.js";
import { listComments } from "../../src/harvest/gh.js";
import type { HarvestedIssue } from "../../src/harvest/types.js";

/* ------------------------------------------------------------ fixtures */

const buildRepo = (files: Record<string, string>): { path: string; sha: string } => {
  const path = mkdtempSync(join(tmpdir(), "repo-atlas-harvest-"));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), contents, "utf8");
  }
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "harvest@test.invalid"]);
  git(["config", "user.name", "harvest test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "subject"]);
  return { path, sha: git(["rev-parse", "HEAD"]).trim() };
};

const issue = (over: Partial<HarvestedIssue> = {}): HarvestedIssue => ({
  number: 2,
  title: "Runtime foundation",
  body: "## Question\n\nWhat is the engine?",
  state: "closed",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
  author: "KyleNaluan",
  labels: [],
  comment_count: 1,
  comments: [
    {
      id: 5181222288,
      body: "## Resolution: code-first TypeScript CLI\n\n**Decision:** ...",
      created_at: "2026-08-02T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
      author: "KyleNaluan",
      bytes: 60,
    },
  ],
  ...over,
});

/* ------------------------------------------------- completeness */

const ghIssue = (comments: number) => ({
  number: 2,
  title: "t",
  body: "b",
  state: "closed" as const,
  comments,
  updated_at: "2026-08-02T00:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
  user: { login: "u" },
  labels: [],
});

const stubComments = (n: number) => async () =>
  Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    body: `comment ${i}`,
    created_at: "2026-08-02T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    user: { login: "u" },
  }));

describe("harvest completeness is verified, not assumed", () => {
  it("accepts a fetch that returns as many comments as GitHub reports", async () => {
    const result = await harvestIssue("o/r", ghIssue(3), stubComments(3));
    expect(result.comments).toHaveLength(3);
    expect(result.comment_count).toBe(3);
  });

  it("REJECTS a fetch that returns fewer, which is what truncation looks like", async () => {
    // The gate watched failing. A truncating fetch path returns well-formed JSON
    // containing less than it should, and every later stage would take that for
    // the whole record - so this must throw rather than warn.
    await expect(harvestIssue("o/r", ghIssue(9), stubComments(1))).rejects.toThrow(
      IncompleteHarvestError,
    );
    await expect(harvestIssue("o/r", ghIssue(9), stubComments(1))).rejects.toThrow(
      /reports 9 comments.*returned 1/s,
    );
  });

  it("rejects a fetch that returns MORE than reported, which is also a mismatch", async () => {
    await expect(harvestIssue("o/r", ghIssue(1), stubComments(2))).rejects.toThrow(
      IncompleteHarvestError,
    );
  });

  it("records each comment's byte length, which the tripwire pins", async () => {
    const result = await harvestIssue("o/r", ghIssue(1), stubComments(1));
    expect(result.comments[0]!.bytes).toBe(Buffer.byteLength("comment 0", "utf8"));
  });

  it("excludes pull requests, which are not decision records", () => {
    expect(isIssue({ pull_request: {} } as never)).toBe(false);
    expect(isIssue({} as never)).toBe(true);
  });
});

/* --------------------------------------------------- the cache key */

describe("the cache key", () => {
  it("changes when a comment is edited, not only when the issue is", () => {
    // issue.updated_at does not move when a comment is edited. A cache keyed on
    // it alone would serve a resolution that no longer says what it says.
    const before = cacheKeyString(cacheKey("o/r", issue()));
    const edited = issue({
      comments: [{ ...issue().comments[0]!, updated_at: "2026-08-09T00:00:00Z" }],
    });
    expect(cacheKeyString(cacheKey("o/r", edited))).not.toBe(before);
  });

  it("changes when a comment is added", () => {
    const before = cacheKeyString(cacheKey("o/r", issue()));
    const added = issue({
      comment_count: 2,
      comments: [
        ...issue().comments,
        {
          id: 5243059657,
          body: "a later note",
          created_at: "2026-08-05T00:00:00Z",
          updated_at: "2026-08-05T00:00:00Z",
          author: "KyleNaluan",
          bytes: 12,
        },
      ],
    });
    expect(cacheKeyString(cacheKey("o/r", added))).not.toBe(before);
  });

  it("is stable for an unchanged issue, so the cache is worth having", () => {
    expect(cacheKeyString(cacheKey("o/r", issue()))).toBe(cacheKeyString(cacheKey("o/r", issue())));
  });

  it("resolves a specific comment, which is what the audit's L3 needs", () => {
    // An audit that cannot tell comment 5181222288 from 5243059657 cannot verify
    // that the decision trail cites the resolution rather than a later note.
    const both = issue({
      comment_count: 2,
      comments: [
        ...issue().comments,
        {
          id: 5243059657,
          body: "a later note",
          created_at: "x",
          updated_at: "x",
          author: "u",
          bytes: 12,
        },
      ],
    });
    expect(resolveComment([both], 2, 5181222288)?.body).toContain("Resolution");
    expect(resolveComment([both], 2, 5243059657)?.body).toBe("a later note");
    expect(resolveComment([both], 2, 999)).toBeUndefined();
    expect(resolveIssue([both], 2)?.number).toBe(2);
  });

  it("round-trips through the in-memory cache", () => {
    const cache = memoryIssueCache();
    cache.put("o/r", issue());
    expect(cache.get("o/r", issue())?.number).toBe(2);
    expect(cache.all("o/r")).toHaveLength(1);
  });

  it("keeps exactly one entry per issue when a comment is edited (in-memory)", () => {
    // A comment edit writes a new, comment-sensitive key. The audit's cache-first
    // lookup must never then see two versions of the same issue number.
    const cache = memoryIssueCache();
    cache.put("o/r", issue());
    const edited = issue({
      updated_at: "2026-08-09T00:00:00Z",
      comments: [
        { ...issue().comments[0]!, body: "## Resolution: revised", updated_at: "2026-08-09T00:00:00Z" },
      ],
    });
    cache.put("o/r", edited);
    const all = cache.all("o/r");
    expect(all).toHaveLength(1);
    expect(all[0]!.comments[0]!.body).toBe("## Resolution: revised");
  });

  it("keeps exactly one entry per issue when a comment is edited (on disk)", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-atlas-cache-"));
    const cache = fileIssueCache(root);
    cache.put("o/r", issue());
    const edited = issue({
      updated_at: "2026-08-09T00:00:00Z",
      comments: [
        { ...issue().comments[0]!, body: "## Resolution: revised", updated_at: "2026-08-09T00:00:00Z" },
      ],
    });
    cache.put("o/r", edited);

    // Only one file survives for the number, and it carries the current body.
    const all = cache.all("o/r");
    expect(all).toHaveLength(1);
    expect(all[0]!.comments[0]!.body).toBe("## Resolution: revised");
    // The audit resolves the specific comment through the cache; it must get the
    // CURRENT body, never the superseded one.
    expect(resolveComment(all, 2, 5181222288)?.body).toBe("## Resolution: revised");
  });

  it("keeps sibling repos whose names share a dash-prefix apart (on disk)", () => {
    // `owner__thing-` is a proper prefix of `owner__thing-v2-`, so a flat
    // dash-delimited filename would let owner/thing-v2's issue #2 leak into
    // owner/thing's cache-first lookup. A per-repo directory forbids it.
    const root = mkdtempSync(join(tmpdir(), "repo-atlas-cache-"));
    const cache = fileIssueCache(root);
    cache.put("owner/thing", issue({ comments: [{ ...issue().comments[0]!, body: "## Resolution: thing" }] }));
    cache.put("owner/thing-v2", issue({ comments: [{ ...issue().comments[0]!, body: "## Resolution: thing-v2" }] }));

    const thing = cache.all("owner/thing");
    expect(thing).toHaveLength(1);
    expect(resolveComment(thing, 2, 5181222288)?.body).toBe("## Resolution: thing");

    const v2 = cache.all("owner/thing-v2");
    expect(v2).toHaveLength(1);
    expect(resolveComment(v2, 2, 5181222288)?.body).toBe("## Resolution: thing-v2");

    // And get() must not hand back the sibling's entry either.
    expect(cache.get("owner/thing", issue())?.comments[0]!.body).toBe("## Resolution: thing");
  });

  it("keeps sibling repos whose names share a dash-prefix apart (in-memory)", () => {
    const cache = memoryIssueCache();
    cache.put("owner/thing", issue({ comments: [{ ...issue().comments[0]!, body: "## Resolution: thing" }] }));
    cache.put("owner/thing-v2", issue({ comments: [{ ...issue().comments[0]!, body: "## Resolution: thing-v2" }] }));

    expect(cache.all("owner/thing")).toHaveLength(1);
    expect(resolveComment(cache.all("owner/thing"), 2, 5181222288)?.body).toBe("## Resolution: thing");
    expect(resolveComment(cache.all("owner/thing-v2"), 2, 5181222288)?.body).toBe("## Resolution: thing-v2");
  });
});

/* ------------------------------------------------ the local tree */

describe("scale and density from the pinned tree", () => {
  const repo = buildRepo({
    "src/main/java/Grader.java": "class Grader {}\n// see #12 for why\n",
    "src/main/java/Runner.java": "class Runner {}\n",
    "src/test/java/GraderTest.java": "class GraderTest {}\n// #99\n",
    "docs/adr/0001-use-postgres.md": "# Use Postgres\n",
    "AGENTS.md": "project memory\n",
    "README.md": "A public engine. Content lives in KyleNaluan/thing-content.git, a PRIVATE repo.\n",
    ".gitignore": "content/\n",
  });

  it("counts source files and lines, excluding tests", () => {
    const scale = measureScale(repo.path, repo.sha);
    expect(scale.files).toBe(2);
    expect(scale.lines).toBe(3);
    expect(scale.commits).toBe(1);
  });

  it("classifies test paths out of the source count", () => {
    expect(isSourceFile("src/main/java/Grader.java")).toBe(true);
    expect(isSourceFile("src/test/java/GraderTest.java")).toBe(false);
    expect(isSourceFile("src/foo.test.ts")).toBe(false);
    expect(isSourceFile("README.md")).toBe(false);
  });

  it("counts source files citing an issue, over source files only", () => {
    const counted = countSourceFilesCitingIssues(repo.path, repo.sha);
    expect(counted).toEqual({ citing: 1, of: 2 });
  });

  it("counts only genuine issue citations, not colours, anchors, or bare strings", () => {
    const cited = buildRepo({
      "colour.ts": 'const bg = "#000000";\nconst fg = "#333";\nexport { bg, fg };\n',
      "anchor.ts": 'const link = <a href="#404">home</a>;\nexport { link };\n',
      "comment.ts": "export const g = () => {};\n// fixes #12, see the resolution\n",
      "string.ts": 'const label = "issue #2 is unrelated to this string";\nexport { label };\n',
    });
    const counted = countSourceFilesCitingIssues(cited.path, cited.sha);
    expect(counted).toEqual({ citing: 1, of: 4 });
  });

  it("auto-detects the subject repository, keeping interior dots and stripping .git", () => {
    const dotted = buildRepo({ "a.ts": "export {};\n" });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/owner/foo.github.io.git"],
      { cwd: dotted.path, stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(subjectRemote(dotted.path)).toBe("owner/foo.github.io");
  });

  it("returns null when the origin remote is not a GitHub URL", () => {
    const other = buildRepo({ "a.ts": "export {};\n" });
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/owner/repo.git"], {
      cwd: other.path,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(subjectRemote(other.path)).toBeNull();
  });

  it("counts multi-digit issue citations, which a colour-length rule silently dropped", () => {
    // #10 names `#190`, `#114`, `#222` and `#459` as the sharpest test of the
    // honest-degradation subject: bare citations with nothing in the record
    // explaining them. An exclusion keyed on digit-run length (3, 4, 6 or 8, the
    // hex-colour lengths) rejected every one of them, because the decimal test
    // above already runs first - so that branch could only ever reject real
    // citations. The cost is a rare `// palette #333` counted as a citation,
    // which is a far smaller error than reporting zero decision-trail citations
    // on the subject chosen to exercise them.
    const cited = buildRepo({
      "a.java": "class A {}\n// look at variable declaration why this line exists and #190\n",
      "b.java": "class B {}\n// see #114 and #1234\n",
      "c.java": "class C {}\n// see #26\n",
    });
    expect(countSourceFilesCitingIssues(cited.path, cited.sha)).toEqual({ citing: 3, of: 3 });
  });

  it("still excludes the shapes that are never citations", () => {
    const noise = buildRepo({
      "colour.ts": "export const c = '#1e1e1e';\n// swatch #1e1e1e\n",
      "anchor.ts": '// see <a href="#404">the anchor</a>\n',
      "string.ts": 'const s = "#2 in a string";\n',
    });
    expect(countSourceFilesCitingIssues(noise.path, noise.sha)).toEqual({ citing: 0, of: 3 });
  });

  it("finds an ADR directory when there is one", () => {
    expect(findAdrDirectory(repo.path, repo.sha)).toBe("docs/adr");
  });

  it("indexes project memory without reading it as evidence", () => {
    // #4: AGENTS.md-class files are indexed for navigation, never quoted. The
    // index carries a path and a size and deliberately not the content.
    const memory = indexMemoryFiles(repo.path, repo.sha);
    expect(memory).toEqual([{ path: "AGENTS.md", bytes: 15 }]);
    expect(JSON.stringify(memory)).not.toContain("project memory");
  });

  it("records a declared private split without reading the private side", () => {
    const split = detectPrivateSplit(repo.path, repo.sha, "KyleNaluan/thing");
    expect(split.declared).toBe(true);
    expect(split.repo).toBe("KyleNaluan/thing-content");
    // The URL's .git suffix is not part of the name the audit compares against.
    expect(split.repo).not.toMatch(/\.git$/);
    expect(split.readable_at_harvest).toBe(false);
  });

  it("reports no split when the subject declares none", () => {
    const plain = buildRepo({ "README.md": "Just a repository.\n", "a.ts": "export {};\n" });
    expect(detectPrivateSplit(plain.path, plain.sha, "o/r").declared).toBe(false);
  });

  it("does not treat a gitignored content directory as a declared split", () => {
    // A .gitignore entry says "do not commit this", not "a private source
    // exists". Recording declared:true for an ordinary repo that ignores a build
    // or content directory makes #8's P1 print a sentence about a private source
    // the engine never established. declared:false is the honest default.
    const ignored = buildRepo({
      "README.md": "Just a repository. Nothing private here.\n",
      ".gitignore": "content/\nnode_modules/\n",
      "a.ts": "export {};\n",
    });
    expect(detectPrivateSplit(ignored.path, ignored.sha, "o/r").declared).toBe(false);
  });

  it("counts a non-ASCII source filename in the file, line, and citation totals", () => {
    // git ls-tree quotes paths with non-ASCII bytes ("caf\303\251.ts"), and the
    // surrounding quotes defeat both the extension test and the cat-file lookup -
    // so an accented filename would silently drop out of every measured figure.
    // core.quotePath=false at the git invocation keeps the path verbatim.
    const accented = buildRepo({
      "café.ts": "export const x = 1;\n// see #12 for why\n",
      "naïve.java": "class Naive {}\n",
    });
    const scale = measureScale(accented.path, accented.sha);
    expect(scale.files).toBe(2);
    expect(scale.lines).toBe(3);
    expect(countSourceFilesCitingIssues(accented.path, accented.sha)).toEqual({
      citing: 1,
      of: 2,
    });
  });

  it("refuses to measure a shallow clone rather than reporting the slice it holds", () => {
    expect(new ShallowCloneError("/x").message).toMatch(/looks like an answer and is not one/);
  });
});

describe("resolution-shaped comments", () => {
  it("recognises the record's own convention", () => {
    expect(hasResolutionComment(issue())).toBe(true);
    expect(
      hasResolutionComment(issue({ comments: [{ ...issue().comments[0]!, body: "sounds good" }] })),
    ).toBe(false);
  });
});

/* ------------------------------------------------------- the tripwire */

/**
 * #4's byte-pinned tripwire, against the live API.
 *
 * The trap it guards is not hypothetical: a convenience CLI's issue view cut
 * every one of swe-prep's nine resolution comments to about 15% of its content,
 * and its own character accounting was wrong by 40 bytes, so nothing in its
 * output revealed the loss. This pins one real comment's exact byte length and
 * SHA-256. If the fetch path starts truncating, or the fixture is edited, this
 * FAILS rather than quietly agreeing with whatever came back.
 *
 * It needs network and a working `gh`. On a machine without them it skips - a
 * statement about the machine, not about the fetch path - and CI asserts `gh` is
 * authenticated so that skip cannot hide a regression there.
 */
const FIXTURE = {
  repo: "KyleNaluan/swe-prep",
  issue: 2,
  comment: 5181222288,
  bytes: 4134,
  sha256: "e0432823098a7eaba4ca0ded7b0d3464ae432857ef2e4e57e6ef50c63d17bbe7",
};

const ghAvailable = (): boolean => {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const describeNetwork = ghAvailable() ? describe : describe.skip;

describeNetwork("the truncation tripwire", () => {
  it("fetches a pinned comment at its exact byte length and digest", async () => {
    const comments = await listComments(FIXTURE.repo, FIXTURE.issue);
    const found = comments.find((c) => c.id === FIXTURE.comment);
    expect(found, `comment ${FIXTURE.comment} is gone from ${FIXTURE.repo}#${FIXTURE.issue}`).toBeDefined();

    const bytes = Buffer.byteLength(found!.body, "utf8");
    expect(
      bytes,
      `the fixture comment is ${bytes} bytes, pinned at ${FIXTURE.bytes}. Either the fetch path ` +
        `started truncating, or the comment was edited - both need a human, and neither may pass quietly.`,
    ).toBe(FIXTURE.bytes);
    expect(createHash("sha256").update(found!.body, "utf8").digest("hex")).toBe(FIXTURE.sha256);
  }, 60_000);

  it("returns every comment the issue reports having", async () => {
    const comments = await listComments(FIXTURE.repo, FIXTURE.issue);
    expect(comments.length).toBeGreaterThanOrEqual(2);
    // Two comments on one issue must arrive as two distinct artifacts.
    expect(new Set(comments.map((c) => c.id)).size).toBe(comments.length);
  }, 60_000);
});
