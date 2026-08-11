/**
 * `repo-atlas write --harvest <harvest.json> --clone <path> [-o written.json]`
 *
 * The credentialed half of the write seam, and the only place a model reads a
 * decision record. It runs locally through an authenticated CLI and commits its
 * output, exactly as `repo-atlas score` does: CI then assembles from the pinned
 * file and never holds a credential.
 *
 * The output records the prompt it was produced under by version AND digest, the
 * model the SDK reported, and the SHA it was written at. A refresh that changes
 * the reading therefore shows which of the three moved.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { modelWriter } from "../write/model-writer.js";
import {
  promptDigest,
  proseFrom,
  writePromptText,
  WRITE_PROMPT_VERSION,
  type RecordToRead,
  type WrittenFile,
} from "../write/write.js";
import { RESOLUTION_HEADING } from "../harvest/issues.js";
import { fileAt, treeFiles } from "../harvest/tree.js";
import type { Harvest } from "../harvest/types.js";

const USAGE = `usage: repo-atlas write --harvest <harvest.json> --clone <path> [-o <written.json>]

Reads each resolution-shaped comment in the harvest and turns it into a decision
candidate, then writes the product sentence and the annotated tree.

options:
  --harvest <path>    the harvest to read (required)
  --clone <path>      a local checkout at the pinned SHA, for the README and listing (required)
  --readme <path>     the README to read, relative to the clone (default: README.md)
  -o, --out <path>    where to write it (default: out/written.json)

This command calls a model and needs an authenticated CLI. Its output is committed
and the rest of the pipeline reads that file, so no other stage and no CI job
needs a credential.

Each record is read ALONE. Extraction is not comparative - a decision means what
its own record says - and a writer shown two records at once can borrow a
rationale from the wrong one.

A comment that settles no decision is recorded as inadmissible rather than
dropped, so the artifact can report that a decision-shaped record existed and did
not survive. That is a different statement from a subject with no decision trail,
and #6 forbids collapsing the two into silence.`;

const flag = (argv: string[], ...names: string[]): string | undefined => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};

/** Every resolution-shaped comment in the harvest, with the issue carrying it. */
export const recordsIn = (harvest: Harvest): RecordToRead[] =>
  harvest.issues
    .flatMap((issue) =>
      issue.comments
        .filter((comment) => RESOLUTION_HEADING.test(comment.body))
        .map((comment) => ({ issue, comment })),
    )
    .sort((a, b) => a.issue.number - b.issue.number || a.comment.id - b.comment.id);

export const writeCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const harvestPath = flag(argv, "--harvest");
  const clone = flag(argv, "--clone");
  if (harvestPath === undefined || clone === undefined) {
    console.error(USAGE);
    return 64;
  }

  const harvest = JSON.parse(readFileSync(harvestPath, "utf8")) as Harvest;
  const prompt = writePromptText();
  const records = recordsIn(harvest);

  let model: string | undefined;
  const writer = modelWriter({
    onModel: (m) => {
      // Recorded, not asserted: whichever model the SDK actually charged the run
      // to is what goes in the file, so a refresh shows if it moved under us.
      if (m !== undefined) model = m;
    },
  });

  console.log(
    `writing ${harvest.subject.owner}/${harvest.subject.repo} at ${harvest.subject.sha} ` +
      `under write prompt ${WRITE_PROMPT_VERSION}`,
  );
  console.log(`  ${records.length} resolution-shaped comment${records.length === 1 ? "" : "s"} to read`);

  const decisions: WrittenFile["decisions"] = [];
  for (const record of records) {
    const written = await writer.decision(record, prompt);
    decisions.push({ issue: record.issue.number, comment_id: record.comment.id, written });
    console.log(
      written.admissible
        ? `  read  #${record.issue.number} comment ${record.comment.id} - ${written.title ?? "(untitled)"}`
        : `  cut   #${record.issue.number} comment ${record.comment.id} - ${written.because ?? "no reason given"}`,
    );
  }

  const readmePath = flag(argv, "--readme") ?? "README.md";
  // Read at the pinned SHA, the same source treeFiles reads the listing from, so
  // the summarized bytes and the {path, sha} citation proseFrom stamps agree by
  // construction rather than by a clean-checkout precondition holding. A README
  // absent at that SHA is left empty on purpose: the prompt's own rule is that an
  // unreadable README cannot support a product sentence, so the writer reports it
  // inadmissible rather than this command guessing from the working tree.
  const readme = fileAt(resolve(clone), harvest.subject.sha, readmePath) ?? "";
  const prose = await writer.prose(
    {
      readme,
      paths: treeFiles(resolve(clone), harvest.subject.sha),
      decisions: decisions
        .filter((d) => d.written.admissible)
        .map((d) => ({ title: d.written.title ?? "", decision: d.written.decision ?? "" })),
    },
    prompt,
  );
  console.log(
    prose.admissible
      ? `  wrote the product sentence and the annotated tree`
      : `  cut   the product sentence and tree - ${prose.because ?? "no reason given"}`,
  );

  const file: WrittenFile = {
    prompt_version: WRITE_PROMPT_VERSION,
    prompt_sha256: promptDigest(prompt),
    generated_at: new Date().toISOString(),
    ...(model === undefined ? {} : { model }),
    subject_sha: harvest.subject.sha,
    decisions,
    prose,
  };

  const output = resolve(flag(argv, "-o", "--out") ?? "out/written.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(file, null, 2)}\n`, "utf8");

  const admissible = decisions.filter((d) => d.written.admissible).length;
  console.log(`  ${admissible} of ${decisions.length} records yielded a decision -> ${output}`);
  console.log(`  model ${model ?? "(the SDK reported none)"}, prompt ${promptDigest(prompt)}`);

  // Reported, never a failure. A subject whose tracker settles nothing is the
  // honest-degradation case (#10), not a broken run.
  if (proseFrom(prose, harvest.subject.sha, readmePath) === undefined) {
    console.log("  the product sentence and tree are absent; assemble will refuse without them");
  }
  return 0;
};
