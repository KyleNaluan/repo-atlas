/**
 * The second decision source (#55), against the shapes the real subjects use.
 *
 * The fixtures below are not invented shapes. Each is cut from a repository this
 * engine is meant to run on, at the commit it was measured at on 2026-08-27:
 *
 *  - `docs/adr/0001-frame-source-abstraction.md` - color-grade-plugin's Nygard
 *    format, `## Context` / `## Decision` / `## Consequences`.
 *  - `docs/adr/0001-fixed-tool-calling-for-v1.md` - data-science-agent's, which
 *    is freeform prose under a title and carries NO `## Decision` heading at
 *    all. Both are admitted, and by the directory rather than by their interior,
 *    which is the point of family 1.
 *  - `AGENTS.md` - futures-trading-bot's, which has no ADR directory and records
 *    under headed sections, interleaved with fenced code and with sections that
 *    are not decisions.
 *  - `native/docs/adr-editor-ui.md` - a decision report sitting outside any
 *    decision directory, admitted on its own filename.
 *
 * The measured yields those shapes produce, for the record and for whoever
 * changes the matcher next: futures-trading-bot 2, color-grade-plugin 8,
 * data-science-agent 10, swe-prep 2 - against 0, 0, 0 and 9 from the issue
 * source.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  citedIssues,
  decisionSections,
  discoverDecisionRecords,
  headingsIn,
  recordId,
  recordsSummary,
  wholeFileFamily,
} from "../../src/harvest/records.js";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const subject = (files: Record<string, string>): { path: string; sha: string } => {
  const path = mkdtempSync(join(tmpdir(), "repo-atlas-records-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), body, "utf8");
  }
  git(path, ["init", "--quiet", "--initial-branch=main"]);
  git(path, ["config", "user.email", "records@test.invalid"]);
  git(path, ["config", "user.name", "records test"]);
  git(path, ["config", "commit.gpgsign", "false"]);
  git(path, ["add", "-A"]);
  git(path, ["commit", "--quiet", "-m", "subject"]);
  return { path, sha: git(path, ["rev-parse", "HEAD"]).trim() };
};

/* ---------------------------------------------- the real record shapes */

/** color-grade-plugin's ADR format: Nygard, with an explicit `## Decision`. */
const NYGARD_ADR = `# 0001. Pixel access via render-to-file behind a FrameSource abstraction

Date: 2026-07-12
Status: Accepted

## Context

The panel needs rendered frame pixels for auto-grade analysis and custom scopes.
CEP/ExtendScript has no direct frame-buffer API.

## Decision

- All pixel consumers read from a single \`FrameSource\` interface.
- The v1 backend is render-to-file: 16-bit TIFF through the render queue.

## Consequences

- The project stays a pure CEP build for v1: no native toolchain.
`;

/** data-science-agent's: a title and freeform prose, with no interior headings. */
const FREEFORM_ADR = `# Fixed tool-calling for V1 agent execution

V1's EDA scope is fully enumerable as a set of operations, so the agent calls
predefined Python tools with structured arguments rather than generating and
executing arbitrary code. This avoids needing a code sandbox and limits what the
LLM ever sees to schema plus tool outputs.
`;

/**
 * futures-trading-bot's AGENTS.md, trimmed but structurally faithful: a fenced
 * block whose comment line starts with `#`, sections that are not decisions, one
 * that is, and one that names the issue it came from.
 */
const MEMORY_FILE = `# CLAUDE.md - futures-bot

## What this project is

A deterministic futures trading bot.

## Toolchain

Run the suite with:

\`\`\`bash
# this is a comment, not a heading
uv run pytest
\`\`\`

## Architecture - non-negotiable

- The deterministic machine is the only thing that touches orders.

### Decision Log (implemented; see docs/PRD.md "Decision Log")

\`src/decision_log/\` is the append-only structured record every strategy emits to.

## Locked decisions (issue #9)

Sizing lives in the risk layer and nowhere else, because a strategy that sizes
itself cannot be gated.

## Maintaining this file

Keep it for knowledge useful to almost every future session.
`;

/* ---------------------------------------------- what declares a record */

describe("what the subject declares a decision record", () => {
  it("admits a file under a decision-record directory, whatever its interior", () => {
    // The two real ADR formats differ completely inside - one is Nygard with a
    // `## Decision`, the other is prose under a title - and the directory is
    // what admits both. A matcher keyed on the interior would have taken
    // color-grade-plugin's and silently dropped data-science-agent's three.
    expect(wholeFileFamily("docs/adr/0001-frame-source-abstraction.md")).toBe("adr_directory");
    expect(wholeFileFamily("docs/decisions/0002-a.md")).toBe("adr_directory");
  });

  it("admits a decision report on its own filename, wherever it sits", () => {
    expect(wholeFileFamily("native/docs/adr-editor-ui.md")).toBe("named_file");
    expect(wholeFileFamily("docs/issues/0023-adr-two-phase-loop.md")).toBe("named_file");
    expect(wholeFileFamily("data/scoring-decision.md")).toBe("named_file");
  });

  it("admits nothing on a filename that merely contains the letters", () => {
    expect(wholeFileFamily("docs/address-book.md")).toBeNull();
    expect(wholeFileFamily("README.md")).toBeNull();
    expect(wholeFileFamily("docs/adrenaline.md")).toBeNull();
  });

  it("never admits a project-memory file whole", () => {
    // A memory file is a mixed document. Admitting it whole would hand the
    // writer a toolchain note and a secrets policy as one decision record, and
    // would reopen #4's line rather than narrowing it.
    expect(wholeFileFamily("AGENTS.md")).toBeNull();
    expect(wholeFileFamily("CLAUDE.md")).toBeNull();
  });

  it("reads markdown only", () => {
    expect(wholeFileFamily("docs/adr/0001-thing.txt")).toBeNull();
    expect(wholeFileFamily("src/decision_log/writer.py")).toBeNull();
  });
});

/* ---------------------------------------------- heading and section shape */

describe("reading a document's headings", () => {
  it("does not read a `#` inside a fenced block as a heading", () => {
    // Every memory file in the corpus carries fenced blocks, and a shell comment
    // read as a heading would cut the record before it at that line - a silent
    // truncation of the record's own text.
    const headings = headingsIn(MEMORY_FILE).map((h) => h.text);
    expect(headings).not.toContain("this is a comment, not a heading");
    expect(headings).toContain("Toolchain");
  });

  it("ends a section at the next heading of the same or shallower depth", () => {
    const sections = decisionSections(MEMORY_FILE);
    const locked = sections.find((s) => s.heading.startsWith("Locked decisions"))!;
    const lines = MEMORY_FILE.split("\n");
    expect(lines[locked.line_start - 1]).toBe("## Locked decisions (issue #9)");
    // It stops at `## Maintaining this file` rather than running to the end.
    expect(lines[locked.line_end]).toBe("## Maintaining this file");
  });

  it("keeps a decision section's own sub-headings inside it", () => {
    const nested = `## Decisions

Intro.

### One

A.

### Two

B.

## Something else
`;
    const [only] = decisionSections(nested);
    expect(decisionSections(nested)).toHaveLength(1);
    expect(only!.line_start).toBe(1);
    expect(nested.split("\n")[only!.line_end]).toBe("## Something else");
  });

  it("declares a section by its heading and never by its prose", () => {
    // #28's defect in one line: a probe that matched vocabulary against any raw
    // line minted a `verified` mechanism out of a YAML comment. A paragraph
    // saying "we made a decision" is not the subject declaring a record.
    const prose = `## Overview

We made an important architecture decision here about the storage layer.
`;
    expect(decisionSections(prose)).toEqual([]);
  });

  it("does not admit a heading that merely points at the decision directory", () => {
    // Measured on color-grade-plugin: `## Resolved in grilling session (...) -
    // see docs/adr/ and CONTEXT.md` matched on the `adr` inside a path. A
    // cross-reference is not a declaration.
    expect(decisionSections("## Resolved in grilling session - see docs/adr/ and CONTEXT.md\n\nx\n")).toEqual([]);
  });
});

/* ---------------------------------------------- discovery over a tree */

describe("discovering records in a tree", () => {
  it("finds the ADR-directory, named-file and memory-section shapes together", () => {
    const { path, sha } = subject({
      "README.md": "# thing\n\nA subject.\n",
      "AGENTS.md": MEMORY_FILE,
      "docs/adr/0001-frame-source-abstraction.md": NYGARD_ADR,
      "docs/adr/0001-fixed-tool-calling-for-v1.md": FREEFORM_ADR,
      "native/docs/adr-editor-ui.md": "# ADR: Editor-window UI toolkit\n\n## Decision\n\nNative.\n",
      "docs/runbook.md": "# Runbook\n\nHow to restart the service.\n",
    });
    const records = discoverDecisionRecords(path, sha);
    const seen = records.map((r) => `${r.family}:${r.path}:${r.line_start}`);

    expect(seen).toEqual([
      "memory_section:AGENTS.md:20",
      "memory_section:AGENTS.md:24",
      "adr_directory:docs/adr/0001-fixed-tool-calling-for-v1.md:1",
      "adr_directory:docs/adr/0001-frame-source-abstraction.md:1",
      "named_file:native/docs/adr-editor-ui.md:1",
    ]);
    // A runbook is an instruction and a README is a description. Neither is a
    // record of a question that was argued and closed, and neither declares
    // itself one.
    expect(seen.some((s) => s.includes("runbook") || s.includes("README"))).toBe(false);
  });

  it("cites the span it read, not the whole file", () => {
    const { path, sha } = subject({ "AGENTS.md": MEMORY_FILE });
    const locked = discoverDecisionRecords(path, sha).find((r) => r.heading?.startsWith("Locked"))!;
    expect(locked.body.startsWith("## Locked decisions")).toBe(true);
    expect(locked.body).not.toContain("Maintaining this file");
    expect(locked.line_end).toBeGreaterThan(locked.line_start);
  });

  it("does not mint a second record for an ADR's own `## Decision` heading", () => {
    // The file is already the record. Two records over one span would let the
    // artifact state one decision twice.
    const { path, sha } = subject({ "docs/adr/0001-frame-source-abstraction.md": NYGARD_ADR });
    expect(discoverDecisionRecords(path, sha)).toHaveLength(1);
  });

  it("finds nothing in a subject that declares nothing, and pads nothing", () => {
    // #6: absence is reported, never manufactured and never silent. This is the
    // Java-WebSocket case for the second source - the honest answer is zero.
    const { path, sha } = subject({
      "README.md": "# Java-WebSocket\n\nA barebones WebSocket implementation.\n",
      "src/Main.java": "class Main {}\n",
      "CONTRIBUTING.md": "# Contributing\n\nOpen a pull request.\n",
    });
    const records = discoverDecisionRecords(path, sha);
    expect(records).toEqual([]);
    expect(recordsSummary(records)).toBe("no in-repo decision record declared itself");
  });

  it("gives a record a stable id derived from its span, not its prose", () => {
    const { path, sha } = subject({ "docs/adr/0001-frame-source-abstraction.md": NYGARD_ADR });
    const [record] = discoverDecisionRecords(path, sha);
    expect(record!.id).toBe(recordId("docs/adr/0001-frame-source-abstraction.md", 1));
    // Used verbatim as a rendered element id, so it carries nothing else.
    expect(record!.id).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it("keeps two sections of one document apart", () => {
    // color-grade-plugin's `docs/prd.md` carries `## Implementation Decisions`
    // and `## Testing Decisions`. Ids keyed on the path alone would collide.
    const { path, sha } = subject({
      "docs/prd.md": "# PRD\n\n## Implementation Decisions\n\nA.\n\n## Testing Decisions\n\nB.\n",
    });
    const ids = discoverDecisionRecords(path, sha).map((r) => r.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

/* ---------------------------------------------- the dedup signal */

describe("the issue a record names as its own", () => {
  it("reads an issue number from the heading", () => {
    expect(citedIssues({ heading: "Locked decisions (issue #9)", body: "text" })).toEqual([9]);
    expect(citedIssues({ heading: "Evaluation vs compliance decoupling (#12 fix)", body: "x" })).toEqual([12]);
  });

  it("reads one from the opening line when the heading names none", () => {
    expect(citedIssues({ heading: "Decision", body: "\n\nPer #34, sizing lives in the risk layer.\n" })).toEqual([34]);
  });

  it("ignores a cross-reference further down the record", () => {
    // A record names the issue it came from where it identifies itself. A `#12`
    // twelve paragraphs down is a cross-reference, and merging on it would fold
    // two decisions that merely mention one another into one node.
    const body = "## Decision\n\nSizing lives in the risk layer.\n\nSee also #12 and #13.\n";
    expect(citedIssues({ heading: "Decision", body })).toEqual([]);
  });

  it("does not read an ADR ordinal or a hex colour as an issue number", () => {
    expect(citedIssues({ heading: "0001. Pixel access", body: "#0001 is the ordinal\n" })).toEqual([]);
    expect(citedIssues({ heading: "Decision", body: "The accent is #123456.\n" })).toEqual([]);
  });
});
