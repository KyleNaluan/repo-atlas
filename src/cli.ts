#!/usr/bin/env node
/**
 * `repo-atlas` - stage-per-subcommand over a content-addressed cache (#2).
 *
 * The mechanical stages (`harvest`, `probe`, `gate`) are plain deterministic
 * code; the judgement stages (`rank`, `audit`) call a model. Each stage reads
 * and writes the cache keyed on the pinned SHA, and `run` orchestrates them.
 *
 * Stages land across a series of PRs. A stage that is not built yet says so and
 * exits non-zero: an engine whose product is "verified, not asserted" does not
 * get to fake a stage boundary.
 */
import { STAGES, type Stage } from "./stages.js";
import { AtlasValidationError } from "./schema/validate.js";

const NAME = "repo-atlas";

const usage = (): string => {
  const width = Math.max(...STAGES.map((s) => s.name.length));
  const lines = STAGES.map(
    (s) => `  ${s.name.padEnd(width)}  ${s.summary}${s.implemented ? "" : "   [not built yet]"}`,
  );
  return [
    `${NAME} - evidence-linked, self-contained overviews of a repository`,
    "",
    `usage: ${NAME} <stage> [options]`,
    "",
    "stages:",
    ...lines,
    "",
    "options:",
    "  -h, --help       this message",
    "  -v, --version    print the version and the atlas.json schema version",
    "",
    `Run \`${NAME} <stage> --help\` for a stage's own options.`,
    "",
    "Every design decision behind this tool is recorded on its tracker:",
    "https://github.com/KyleNaluan/repo-atlas/issues",
  ].join("\n");
};

const find = (name: string): Stage | undefined => STAGES.find((s) => s.name === name);

export const main = async (argv: string[]): Promise<number> => {
  const [first, ...rest] = argv;

  if (first === undefined || first === "-h" || first === "--help" || first === "help") {
    console.log(usage());
    return first === undefined ? 1 : 0;
  }
  if (first === "-v" || first === "--version") {
    const { version } = await import("./version.js");
    const { SCHEMA_VERSION } = await import("./schema/types.js");
    console.log(`${NAME} ${version} (atlas.json schema ${SCHEMA_VERSION})`);
    return 0;
  }

  const stage = find(first);
  if (!stage) {
    console.error(`${NAME}: unknown stage "${first}"`);
    console.error(`${NAME}: stages are ${STAGES.map((s) => s.name).join(", ")}`);
    return 64; // EX_USAGE
  }
  if (!stage.implemented) {
    console.error(`${NAME}: the "${stage.name}" stage is not built yet in this version.`);
    console.error(`${NAME}: ${stage.summary}`);
    return 70; // EX_SOFTWARE
  }
  return stage.run(rest);
};

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === new URL(`file://${entry}`).href || entry.endsWith("cli.ts") || entry.endsWith("cli.js");
};

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof AtlasValidationError) {
        console.error(`${NAME}: ${error.message}`);
        for (const p of error.problems) console.error(`  - ${p}`);
      } else {
        console.error(`${NAME}: ${error instanceof Error ? error.message : String(error)}`);
        if (process.env["REPO_ATLAS_DEBUG"] && error instanceof Error) console.error(error.stack);
      }
      process.exitCode = 1;
    });
}
