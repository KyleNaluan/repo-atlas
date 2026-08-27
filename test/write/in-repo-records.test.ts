/**
 * The second decision source through the whole write seam and the gate (#55).
 *
 * The acceptance question this file answers is #55's own: a subject with ZERO
 * `## Resolution` issue comments and real in-repo decision records must produce
 * decision nodes carrying evidence citations. That is the state
 * futures-trading-bot (0 of 16), color-grade-plugin (0 of 13) and
 * data-science-agent (0 of 39) are in today, and the state that produced an
 * atlas with no decision trail at all.
 *
 * Everything downstream of `toCandidate` is deliberately unchanged, so these
 * tests assert the JOIN rather than re-testing the gate: that a file-sourced
 * record produces the same candidate shape, carries the same `attested`
 * ceiling, hands the gate the same claims, and cites a span the tree can
 * resolve.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  candidatesFrom,
  toCandidate,
  writePromptText,
  WRITE_PROMPT_VERSION,
  promptDigest,
  type WrittenDecision,
  type WrittenFile,
} from "../../src/write/write.js";
import { discoverDecisionRecords } from "../../src/harvest/records.js";
import { treeContext } from "../../src/probes/registry.js";
import { gate } from "../../src/gate/gate.js";
import type { DecisionNode, FileEvidence } from "../../src/schema/types.js";
import type { Harvest, HarvestedDecisionRecord } from "../../src/harvest/types.js";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const subject = (files: Record<string, string>): { path: string; sha: string } => {
  const path = mkdtempSync(join(tmpdir(), "repo-atlas-inrepo-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), body, "utf8");
  }
  git(path, ["init", "--quiet", "--initial-branch=main"]);
  git(path, ["config", "user.email", "inrepo@test.invalid"]);
  git(path, ["config", "user.name", "in-repo test"]);
  git(path, ["config", "commit.gpgsign", "false"]);
  git(path, ["add", "-A"]);
  git(path, ["commit", "--quiet", "-m", "subject"]);
  return { path, sha: git(path, ["rev-parse", "HEAD"]).trim() };
};

/**
 * A subject in exactly the state #55 was opened about: an issue tracker that
 * settles nothing, and decisions recorded in the tree.
 *
 * The ADR is color-grade-plugin's real shape and the claim it carries is the
 * one that ADR would carry - a type name the tree either declares or does not.
 */
const ADR = `# 0001. Pixel access via render-to-file behind a FrameSource abstraction

Date: 2026-07-12
Status: Accepted

## Context

CEP/ExtendScript has no direct frame-buffer API.

## Decision

All pixel consumers read from a single \`FrameSource\` interface.

## Consequences

The project stays a pure CEP build for v1.
`;

const MEMORY = `# Project agent memory

## Toolchain

\`\`\`bash
# not a heading
npm test
\`\`\`

## Locked decisions (issue #9)

Sizing lives in the risk layer, because a strategy that sizes itself cannot be
gated.
`;

const harvestOf = (sha: string, records: HarvestedDecisionRecord[]): Harvest =>
  ({
    subject: { sha },
    // The state that matters: the tracker settles nothing.
    issues: [],
    decision_records: records,
  }) as unknown as Harvest;

const written = (decisions: WrittenFile["decisions"], sha: string): WrittenFile => ({
  prompt_version: WRITE_PROMPT_VERSION,
  prompt_sha256: promptDigest(writePromptText()),
  subject_sha: sha,
  decisions,
  prose: { admissible: false, because: "not under test" },
});

const ADMISSIBLE: WrittenDecision = {
  admissible: true,
  title: "Pixel access behind a FrameSource abstraction",
  question: "How does the panel get frame pixels?",
  decision: "All consumers read from one FrameSource interface.",
  why: "CEP has no frame-buffer API and a native backend is ten times the surface.",
  rejected: [{ alternative: "A native AEGP plugin", why_it_lost: "per-platform binaries" }],
  status: "decided",
  soundbite: "Pixels come through one interface, so the backend can be swapped.",
  implementation_claim: {
    description: "the FrameSource interface",
    expect: "present",
    pattern: { regex: "interface FrameSource" },
  },
};

/* ---------------------------------------------- the acceptance case */

describe("a subject with no resolution comments and records in its tree", () => {
  const { path, sha } = subject({
    "README.md": "# panel\n\nA colour-grading panel.\n",
    "docs/adr/0001-frame-source-abstraction.md": ADR,
    "src/host/frameSource.ts": "export interface FrameSource {\n  getFrame(t: number): Float32Array;\n}\n",
  });
  const records = discoverDecisionRecords(path, sha);
  const harvest = harvestOf(sha, records);

  it("produces a decision node where the issue source produced none", () => {
    expect(harvest.issues).toHaveLength(0);
    const file = written([{ source: "record", record_id: records[0]!.id, written: ADMISSIBLE }], sha);
    const candidates = candidatesFrom(file, { issues: [], records }, writePromptText(), sha);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.node.type).toBe("decision");
    expect((candidates[0]!.node as DecisionNode).why).toContain("CEP has no frame-buffer API");
  });

  it("cites the span it was read from, at the pinned SHA", () => {
    const file = written([{ source: "record", record_id: records[0]!.id, written: ADMISSIBLE }], sha);
    const [candidate] = candidatesFrom(file, { issues: [], records }, writePromptText(), sha);
    const [evidence] = candidate!.node.evidence as FileEvidence[];
    expect(evidence).toMatchObject({
      kind: "file",
      path: "docs/adr/0001-frame-source-abstraction.md",
      line_start: 1,
      sha,
    });
    // The citation is a range a reader can open, which is what audit L1 and L2
    // resolve against the tree. An issue citation resolves only against the
    // harvest cache, so this source is the better-evidenced of the two.
    expect(evidence!.line_end).toBeGreaterThan(evidence!.line_start!);
  });

  it("admits the decision as attested, never as verified", () => {
    // #55's D3: the source moved, the epistemics did not. A record is testimony
    // about a decision on exactly the terms a resolution comment is.
    const file = written([{ source: "record", record_id: records[0]!.id, written: ADMISSIBLE }], sha);
    const [candidate] = candidatesFrom(file, { issues: [], records }, writePromptText(), sha);
    expect(candidate!.node.confidence).toBe("attested");
  });

  it("leaves the build claim for the gate, which settles it against the tree", () => {
    // The record says a FrameSource interface exists. The write stage may not
    // assert that, and does not: `implemented_by` is empty until the gate finds
    // it. This is #4's guarantee holding through the new source - nothing here
    // lets a committed document establish a fact about the code.
    const file = written([{ source: "record", record_id: records[0]!.id, written: ADMISSIBLE }], sha);
    const [candidate] = candidatesFrom(file, { issues: [], records }, writePromptText(), sha);
    expect((candidate!.node as DecisionNode).status).toBe("decided");
    expect((candidate!.node as DecisionNode).implemented_by).toEqual([]);

    const [gated] = gate(treeContext(harvest, path), [candidate!]);
    expect(gated!.verdict).toBe("confirmed");
    const node = gated!.node as DecisionNode;
    expect(node.status).toBe("decided_and_built");
    expect(node.implemented_by.map((e) => (e as FileEvidence).path)).toEqual(["src/host/frameSource.ts"]);
  });

  it("has the gate overturn a record the tree contradicts, exactly as for an issue", () => {
    const absent = subject({
      "README.md": "# panel\n",
      "docs/adr/0001-frame-source-abstraction.md": ADR,
    });
    const found = discoverDecisionRecords(absent.path, absent.sha);
    const file = written(
      [{ source: "record", record_id: found[0]!.id, written: ADMISSIBLE }],
      absent.sha,
    );
    const [candidate] = candidatesFrom(file, { issues: [], records: found }, writePromptText(), absent.sha);
    const [gated] = gate(treeContext(harvestOf(absent.sha, found), absent.path), [candidate!]);
    // A stated decision is not evidence of implementation (#7 point 7). The tree
    // has no FrameSource, so the claim does not confirm.
    expect(gated!.verdict).not.toBe("confirmed");
  });
});

/* ---------------------------------------------- cut, not dropped */

describe("a record that settles nothing", () => {
  const { path, sha } = subject({ "AGENTS.md": MEMORY });
  const records = discoverDecisionRecords(path, sha);

  it("is emitted as an absent cut carrying the reason, never dropped", () => {
    // #6: a decision-shaped record that did not survive is a different statement
    // from a subject with no decision trail, and silence collapses the two. The
    // matcher over-admits on purpose and the writer is what deletes.
    const file = written(
      [
        {
          source: "record",
          record_id: records[0]!.id,
          written: { admissible: false, because: "a component description, not a decision" },
        },
      ],
      sha,
    );
    const [candidate] = candidatesFrom(file, { issues: [], records }, writePromptText(), sha);
    expect(candidate!.node.confidence).toBe("absent");
    // Still cited, so the cut names a span a reader can go and check.
    expect(candidate!.node.evidence[0]!.kind).toBe("file");
  });

  it("falls back to the heading for a title the writer did not name", () => {
    const file = written([{ source: "record", record_id: records[0]!.id, written: { admissible: false } }], sha);
    const [candidate] = candidatesFrom(file, { issues: [], records }, writePromptText(), sha);
    expect(candidate!.node.title).toBe("Locked decisions (issue #9)");
  });
});

/* ---------------------------------------------- dedup across the two sources */

describe("one decision recorded in both places", () => {
  const { path, sha } = subject({ "AGENTS.md": MEMORY });
  const records = discoverDecisionRecords(path, sha);
  const record = records[0]!;
  const issues = [
    {
      number: 9,
      title: "Where does sizing live?",
      body: "",
      state: "closed",
      created_at: "x",
      updated_at: "x",
      author: "u",
      labels: [],
      comment_count: 1,
      comments: [
        {
          id: 501,
          body: "## Resolution: sizing lives in the risk layer",
          created_at: "x",
          updated_at: "x",
          author: "u",
          bytes: 45,
        },
      ],
    },
  ];

  it("names the issue it came from, which is what identifies the two as one", () => {
    // The identification is the subject's own - the record writes `issue #9` in
    // its heading. Nothing here compares prose for similarity.
    expect(record.cites_issues).toEqual([9]);
  });

  it("becomes a second citation on that node rather than a second node", () => {
    const file = written(
      [
        { issue: 9, comment_id: 501, written: ADMISSIBLE },
        { source: "record", record_id: record.id, deduped_into: "d-issue-9-c501" },
      ],
      sha,
    );
    const candidates = candidatesFrom(file, { issues, records }, writePromptText(), sha);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.node.id).toBe("d-issue-9-c501");
    const kinds = candidates[0]!.node.evidence.map((e) => e.kind);
    expect(kinds).toEqual(["issue", "file"]);
    expect(candidates[0]!.node.evidence[1]).toMatchObject({
      kind: "file",
      path: "AGENTS.md",
      line_start: record.line_start,
      sha,
    });
  });

  it("stands on its own when the issue's own comment was cut", () => {
    // The case that matters, and the reason dedup is keyed on an ADMISSIBLE
    // issue-sourced decision: a subject that stopped writing resolution comments
    // must still get its decision trail from the tree.
    const file = written(
      [
        { issue: 9, comment_id: 501, written: { admissible: false, because: "a closing note" } },
        { source: "record", record_id: record.id, written: ADMISSIBLE },
      ],
      sha,
    );
    const candidates = candidatesFrom(file, { issues, records }, writePromptText(), sha);
    expect(candidates.map((c) => c.node.id)).toEqual(["d-issue-9-c501", record.id]);
    expect(candidates[1]!.node.confidence).toBe("attested");
  });

  it("drops a merge whose target is not in this set rather than guessing", () => {
    const file = written(
      [{ source: "record", record_id: record.id, deduped_into: "d-issue-404-c1" }],
      sha,
    );
    expect(candidatesFrom(file, { issues, records }, writePromptText(), sha)).toEqual([]);
  });

  it("skips a pinned entry whose record is not in this harvest", () => {
    // The mirror of the issue-sourced case: an entry naming a span the harvest
    // does not carry would otherwise mint a decision citing nothing.
    const file = written([{ source: "record", record_id: "d-file-gone-L1", written: ADMISSIBLE }], sha);
    expect(candidatesFrom(file, { issues, records }, writePromptText(), sha)).toEqual([]);
  });
});

/* ---------------------------------------------- a subject with neither */

describe("a subject with neither source", () => {
  it("yields no decision candidates and pads nothing", () => {
    // The Java-WebSocket case (#10), now measured against both sources. The
    // honest answer stays zero, and #6's absence panel is what reports it.
    const { path, sha } = subject({
      "README.md": "# Java-WebSocket\n\nA barebones WebSocket implementation.\n",
      "src/Main.java": "class Main {}\n",
    });
    const records = discoverDecisionRecords(path, sha);
    expect(records).toEqual([]);
    const file = written([], sha);
    expect(candidatesFrom(file, { issues: [], records }, writePromptText(), sha)).toEqual([]);
  });
});

/* ---------------------------------------------- the two sources are one shape */

describe("the two sources produce one candidate shape", () => {
  const { path, sha } = subject({ "docs/adr/0001-a.md": ADR });
  const [record] = discoverDecisionRecords(path, sha);

  it("differs only in the citation the code stamps", () => {
    const fromFile = toCandidate({ kind: "file", record: record!, sha }, ADMISSIBLE);
    const fromIssue = toCandidate(
      {
        kind: "issue",
        issue: {
          number: 9,
          title: "t",
          body: "",
          state: "closed",
          created_at: "x",
          updated_at: "x",
          author: "u",
          labels: [],
          comment_count: 1,
          comments: [],
        },
        comment: { id: 1, body: "b", created_at: "x", updated_at: "x", author: "u", bytes: 1 },
      },
      ADMISSIBLE,
    );
    const { id: _a, evidence: fileEvidence, ...fileRest } = fromFile.node;
    const { id: _b, evidence: issueEvidence, ...issueRest } = fromIssue.node;
    expect(fileRest).toEqual(issueRest);
    expect(fileEvidence[0]!.kind).toBe("file");
    expect(issueEvidence[0]!.kind).toBe("issue");
    // Same claims to the gate, so nothing downstream can tell the two apart.
    expect(fromFile.claims).toEqual(fromIssue.claims);
  });
});
