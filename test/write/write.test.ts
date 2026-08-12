/**
 * The write stage.
 *
 * The tests that matter here are the ones about what the writer is NOT allowed
 * to do: it does not supply its own citation, it does not fill implemented_by,
 * and it cannot make a record admissible by being confident. Everything it says
 * goes through the gate afterwards, so these check the seam rather than the
 * prose.
 *
 * Nothing here needs a credential: the writer is injected.
 */
import { describe, expect, it } from "vitest";
import {
  assertWriteFresh,
  candidatesFrom,
  decisionId,
  promptDigest,
  proseFrom,
  StaleWriteError,
  toCandidate,
  WRITE_PROMPT_VERSION,
  writePromptText,
  WritePromptMismatchError,
  WrongSubjectError,
  type RecordToRead,
  type WrittenDecision,
  type WrittenFile,
} from "../../src/write/write.js";
import { modelWriter, parseWritten, WriterError } from "../../src/write/model-writer.js";
import { recordsIn } from "../../src/commands/write.js";
import { findReadme } from "../../src/harvest/tree.js";
import type { DecisionNode } from "../../src/schema/types.js";
import type { Harvest, HarvestedIssue } from "../../src/harvest/types.js";

const SHA = "086c99998ba6eec1353988cd88989cbe836fe6a0";

const comment = (id: number, body: string) => ({
  id,
  body,
  created_at: "x",
  updated_at: "x",
  author: "u",
  bytes: body.length,
});

const issue = (number: number, comments: ReturnType<typeof comment>[]): HarvestedIssue => ({
  number,
  title: `issue ${number}`,
  body: "b",
  state: "closed",
  created_at: "x",
  updated_at: "x",
  author: "u",
  labels: [],
  comment_count: comments.length,
  comments,
});

const RECORD: RecordToRead = {
  issue: issue(3, [comment(5180801286, "## Resolution: three tiers")]),
  comment: comment(5180801286, "## Resolution: three tiers"),
};

const ADMISSIBLE: WrittenDecision = {
  admissible: true,
  title: "Session shape",
  question: "How long should a daily session be?",
  decision: "Three tiers.",
  why: "A required tier that is cheap enough to never skip.",
  rejected: [{ alternative: "One fixed session", why_it_lost: "too long to do daily" }],
  status: "decided_and_built",
  soundbite: "The day is done after a four-minute warm-up.",
  implementation_claim: {
    description: "the session controller",
    expect: "present",
    paths: ["backend/src/main/java/Session.java"],
  },
};

/* ------------------------------------------- what the model may not do */

describe("the writer proposes; it does not cite and it does not implement", () => {
  it("stamps the citation from the record, never from the model", () => {
    // The model is not asked for a citation, so it cannot produce one that does
    // not resolve - a class of failure the audit would otherwise have to catch.
    const candidate = toCandidate(RECORD, ADMISSIBLE);
    expect(candidate.node.evidence).toEqual([
      { kind: "issue", number: 3, comment_id: 5180801286 },
    ]);
  });

  it("leaves implemented_by empty, because that is a claim about the tree", () => {
    // Filling it from the writer's guess would be the artifact asserting an
    // implementation on the strength of a decision record, which is the single
    // failure #7 point 7 exists to prevent.
    const node = toCandidate(RECORD, ADMISSIBLE).node as DecisionNode;
    expect(node.implemented_by).toEqual([]);
  });

  it("turns where-to-look into a claim for the gate to resolve", () => {
    const candidate = toCandidate(RECORD, ADMISSIBLE);
    expect(candidate.claims).toEqual([
      {
        description: "the session controller",
        expect: "present",
        paths: ["backend/src/main/java/Session.java"],
      },
    ]);
  });

  it("drops a claim with nothing to read rather than sending it to the gate", () => {
    // The gate demotes a candidate whose claim cannot be resolved either way.
    // Sending one anyway would be asking it to confirm something nobody can check.
    const candidate = toCandidate(RECORD, {
      ...ADMISSIBLE,
      implementation_claim: { description: "somewhere", expect: "present" },
    });
    expect(candidate.claims).toBeUndefined();
  });

  it("clamps a model-returned build status back to decided", () => {
    // A prompt instruction is not an enforcement: the model can return a build
    // status anyway, but where a decision is built is a claim about the tree only
    // the gate may settle. So decided_and_built and decided_not_built are clamped
    // to decided here, leaving promotion in the one place that reads the tree.
    expect((toCandidate(RECORD, { ...ADMISSIBLE, status: "decided_and_built" }).node as DecisionNode).status).toBe(
      "decided",
    );
    expect((toCandidate(RECORD, { ...ADMISSIBLE, status: "decided_not_built" }).node as DecisionNode).status).toBe(
      "decided",
    );
  });

  it("keeps superseded, the one non-decided status the writer may mint", () => {
    expect((toCandidate(RECORD, { ...ADMISSIBLE, status: "superseded" }).node as DecisionNode).status).toBe(
      "superseded",
    );
  });

  it("admits a decision as attested, never as verified", () => {
    // A decision record is testimony: it establishes what was decided, never
    // that it was built. Only the gate can move this, and only downwards.
    expect(toCandidate(RECORD, ADMISSIBLE).node.confidence).toBe("attested");
  });

  it("marks the rejected alternative absent from the record rather than inventing one", () => {
    // The rejected alternative is the payload a summariser destroys, so "the
    // record names none" has to stay distinguishable from "there was none".
    const node = toCandidate(RECORD, { ...ADMISSIBLE, rejected: [] }).node as DecisionNode;
    expect(node.rejected).toEqual([]);
    expect(node.rejected_absent_from_record).toBe(true);
  });

  it("does not mark absence when the record does name an alternative", () => {
    const node = toCandidate(RECORD, ADMISSIBLE).node as DecisionNode;
    expect(node.rejected_absent_from_record).toBeUndefined();
  });

  it("gives a decision an id from the record, not from its prose", () => {
    // Prose changes when the prompt is reworded; the record it was read from does
    // not, and the id is used verbatim as a rendered element id.
    expect(toCandidate(RECORD, ADMISSIBLE).node.id).toBe(decisionId(3, 5180801286));
    expect(toCandidate(RECORD, { ...ADMISSIBLE, title: "Something else" }).node.id).toBe(
      decisionId(3, 5180801286),
    );
  });

  it("mints distinct node and divergence-edge ids for two resolution comments on one issue", () => {
    // #7 found issue #2 carrying two resolution comments, cited as distinct
    // artifacts, and `recordsIn` reads both. Keying the node id on the issue alone
    // would collide them - and collide their `{id}-divergence` edge ids in the
    // gate - collapsing two decisions the subject records apart into one malformed
    // node. The reference subject has one resolution per issue, so nothing else
    // exercises this.
    const first: RecordToRead = {
      issue: issue(2, [comment(5181222288, "## Resolution: one"), comment(5243059657, "### Resolution: two")]),
      comment: comment(5181222288, "## Resolution: one"),
    };
    const second: RecordToRead = { ...first, comment: comment(5243059657, "### Resolution: two") };
    const idA = toCandidate(first, ADMISSIBLE).node.id;
    const idB = toCandidate(second, ADMISSIBLE).node.id;
    expect(idA).toBe("d-issue-2-c5181222288");
    expect(idB).toBe("d-issue-2-c5243059657");
    expect(idA).not.toBe(idB);
    expect(`${idA}-divergence`).not.toBe(`${idB}-divergence`);
  });
});

/* ------------------------------------------- inadmissible is an answer */

describe("a record that settles nothing is cut, not dropped", () => {
  it("emits an absent-confidence candidate rather than nothing", () => {
    // #3 cuts absent outright, and the record reports the count and reason. A
    // tracker full of "closing this" notes then reads as what it is, rather than
    // as a subject where no decision was ever recorded.
    const candidate = toCandidate(RECORD, { admissible: false, because: "a status update" });
    expect(candidate.node.confidence).toBe("absent");
    expect(candidate.node.evidence).toHaveLength(1);
    expect(candidate.claims).toBeUndefined();
  });

  it("keeps the issue title so the cut can be reported by name", () => {
    const candidate = toCandidate(RECORD, { admissible: false, because: "a status update" });
    expect(candidate.node.title).toBe("issue 3");
  });

  it("asserts nothing in the fields it could not fill", () => {
    const node = toCandidate(RECORD, { admissible: false }).node as DecisionNode;
    expect(node.question).toBe("");
    expect(node.decision).toBe("");
    expect(node.why).toBe("");
  });
});

/* ------------------------------------------- the pinned set */

describe("a pinned written set cannot go quietly stale", () => {
  const file = (over: Partial<WrittenFile> = {}): WrittenFile => ({
    prompt_version: WRITE_PROMPT_VERSION,
    prompt_sha256: promptDigest(writePromptText()),
    subject_sha: SHA,
    decisions: [{ issue: 3, comment_id: 5180801286, written: ADMISSIBLE }],
    prose: { admissible: true, statement: "s", tree: "t" },
    ...over,
  });

  it("accepts a set produced under this prompt at this SHA", () => {
    expect(() => assertWriteFresh(file(), writePromptText(), SHA)).not.toThrow();
  });

  it("refuses a set produced under a prompt that has since been edited", () => {
    expect(() => assertWriteFresh(file(), "someone reworded the prompt", SHA)).toThrow(
      StaleWriteError,
    );
  });

  it("refuses a set produced under a different prompt version", () => {
    expect(() => assertWriteFresh(file({ prompt_version: "v0" }), writePromptText(), SHA)).toThrow(
      WritePromptMismatchError,
    );
  });

  it("refuses prose describing a different tree", () => {
    // Prose written against one tree assembled into a document naming another is
    // the same failure as citations resolved at the wrong SHA.
    expect(() => assertWriteFresh(file(), writePromptText(), "0".repeat(40))).toThrow(
      WrongSubjectError,
    );
  });

  it("checks freshness in the loader, so no path can route around it", () => {
    expect(() =>
      candidatesFrom(file(), [RECORD.issue], "someone reworded the prompt", SHA),
    ).toThrow(StaleWriteError);
  });

  it("yields candidates in issue order, so a run reproduces", () => {
    const two = file({
      decisions: [
        { issue: 9, comment_id: 2, written: ADMISSIBLE },
        { issue: 3, comment_id: 1, written: ADMISSIBLE },
      ],
    });
    const issues = [issue(3, [comment(1, "x")]), issue(9, [comment(2, "y")])];
    expect(candidatesFrom(two, issues, writePromptText(), SHA).map((c) => c.node.id)).toEqual([
      decisionId(3, 1),
      decisionId(9, 2),
    ]);
  });

  it("skips a pinned entry whose record is not in this harvest", () => {
    // The set is keyed on issue and comment id, so an entry naming a comment the
    // harvest does not carry would otherwise mint a decision citing nothing.
    const stray = file({ decisions: [{ issue: 404, comment_id: 1, written: ADMISSIBLE }] });
    expect(candidatesFrom(stray, [RECORD.issue], writePromptText(), SHA)).toEqual([]);
  });
});

/* ------------------------------------------- the prose */

describe("the product sentence and the annotated tree", () => {
  it("carries evidence pinned to the SHA it was written at", () => {
    const prose = proseFrom({ admissible: true, statement: "s", tree: "t" }, SHA, "README.md")!;
    expect(prose.synopsis.evidence).toEqual([{ kind: "file", path: "README.md", sha: SHA }]);
    // The annotated tree is derived from every path at this commit, not from a
    // file. An earlier version cited the path "." and audit check L1 rightly
    // refused it: no such entry exists in the tree, and a citation nobody can
    // resolve is worse than none. This one a reader can run.
    expect(prose.shape.evidence).toEqual([
      {
        kind: "command",
        cmd: `git ls-tree -r --name-only ${SHA}`,
        output_excerpt: "(the listing this tree was annotated from)",
      },
    ]);
  });

  it("is absent rather than blank when the writer could not produce it", () => {
    expect(proseFrom({ admissible: false, because: "no README" }, SHA, "README.md")).toBeUndefined();
    expect(proseFrom({ admissible: true, statement: "  ", tree: "t" }, SHA, "README.md")).toBeUndefined();
  });
});

/* ------------------------------------------- selecting the records */

describe("which comments are read", () => {
  const harvestWith = (issues: HarvestedIssue[]): Harvest =>
    ({ subject: { sha: SHA }, issues }) as Harvest;

  it("reads resolution-shaped comments and leaves the rest alone", () => {
    const h = harvestWith([
      issue(1, [comment(10, "## Resolution: a thing"), comment(11, "looks good to me")]),
      issue(2, [comment(20, "just closing this out")]),
    ]);
    expect(recordsIn(h).map((r) => r.comment.id)).toEqual([10]);
  });

  it("reads every resolution comment on an issue that carries two", () => {
    // #7 found issue #2 carrying two, cited as distinct artifacts. Reading only
    // the first would silently halve that issue's record.
    const h = harvestWith([
      issue(2, [comment(5181222288, "## Resolution: one"), comment(5243059657, "### Resolution: two")]),
    ]);
    expect(recordsIn(h).map((r) => r.comment.id)).toEqual([5181222288, 5243059657]);
  });

  it("finds nothing in a tracker that settles nothing", () => {
    // The Java-WebSocket case (#10). Zero records is the honest answer, not a
    // failure.
    expect(recordsIn(harvestWith([issue(1, [comment(10, "+1")])]))).toEqual([]);
  });
});

/* ------------------------------------------- reading the reply */

describe("the model writer", () => {
  it("asks once per record, never once for the set", async () => {
    // Extraction is not comparative: a writer shown two records at once can
    // borrow a rationale from the wrong one.
    const prompts: string[] = [];
    const writer = modelWriter({
      ask: async (p) => {
        prompts.push(p);
        return JSON.stringify(ADMISSIBLE);
      },
    });
    await writer.decision(RECORD, "PROMPT");
    await writer.decision(RECORD, "PROMPT");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("## Resolution: three tiers");
  });

  it("shows the writer one record and no others", async () => {
    let prompt = "";
    await modelWriter({
      ask: async (p) => {
        prompt = p;
        return JSON.stringify(ADMISSIBLE);
      },
    }).decision(RECORD, "PROMPT");
    expect(prompt).toContain("#3");
    expect(prompt).not.toContain("issue 9");
  });

  it("fails the run on a reply that is not a verdict, rather than recording a cut", async () => {
    // The rule this pins, and it reverses what the stage did first. An
    // `admissible: false` is not a statement about the model - it is a permanent
    // record that this resolution comment settles no decision, carried into the
    // artifact as a cut for want of evidence. A service message where JSON was
    // expected must therefore never produce one.
    //
    // It is pinned because it already happened: a refresh run hit a session
    // limit and wrote issue #10 - the record that produces the reference
    // subject's divergence finding - into the pinned set as a comment that
    // settles nothing. A fixture attesting to an infrastructure failure attests
    // to nothing, and would have read as a real measurement forever.
    await expect(
      modelWriter({ ask: async () => "You've hit your session limit" }).decision(RECORD, "PROMPT"),
    ).rejects.toThrow(WriterError);
  });

  it("fails the run on a reply that omits the verdict", async () => {
    // The model answered, but not the question it was asked. Recording that as
    // "this record settles nothing" would attribute the model's miss to the
    // subject.
    await expect(
      modelWriter({ ask: async () => '{"decision":"we did a thing"}' }).decision(RECORD, "PROMPT"),
    ).rejects.toThrow(WriterError);
  });

  it("still lets the model declare a record inadmissible", async () => {
    // The one route to a cut: the model saying so in a well-formed verdict.
    const written = await modelWriter({
      ask: async () => '{"admissible": false, "because": "a status update, not a decision"}',
    }).decision(RECORD, "PROMPT");
    expect(written.admissible).toBe(false);
    expect(written.because).toContain("status update");
  });

  it("fails the prose the same way, rather than reporting the subject shapeless", async () => {
    await expect(
      modelWriter({ ask: async () => "You've hit your session limit" }).prose(
        { readme: "r", paths: ["a"], decisions: [] },
        "PROMPT",
      ),
    ).rejects.toThrow(WriterError);
  });

  it("tolerates a fence or a preamble around the JSON", () => {
    expect(parseWritten<{ a: number }>('here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("says so plainly when there is no JSON at all", () => {
    expect(() => parseWritten("no json here")).toThrow(WriterError);
  });
});

/* ------------------------------------------- finding the README */

describe("the README is found, not assumed", () => {
  it("prefers a markdown README at the root", () => {
    expect(findReadme(["README.md", "docs/README.md", "src/A.java"])).toBe("README.md");
  });

  it("finds a README whatever extension it carries", () => {
    // The degradation subject's is `README.markdown`. A hardcoded `README.md`
    // handed the writer an empty string, which it correctly refused to write
    // from - failing the run three stages later for a reason that had nothing to
    // do with the subject.
    expect(findReadme(["README.markdown", "pom.xml"])).toBe("README.markdown");
    expect(findReadme(["README", "pom.xml"])).toBe("README");
    expect(findReadme(["README.rst", "pom.xml"])).toBe("README.rst");
  });

  it("ignores a README that is not at the root", () => {
    // `docs/README.md` is documentation about a part; the product sentence is
    // about the whole.
    expect(findReadme(["docs/README.md", "src/A.java"])).toBeUndefined();
  });

  it("returns nothing when the subject has none", () => {
    // The writer then declines rather than describing what a repository of this
    // shape usually is.
    expect(findReadme(["pom.xml", "src/A.java"])).toBeUndefined();
  });
});
