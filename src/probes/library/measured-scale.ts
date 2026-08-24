/**
 * The stat tiles: figures the harvest measured, restated as Fact nodes.
 *
 * The reference overview opens with six of these - lines of main and test Java,
 * the backend test count, packages, migrations, commits and calendar days - and
 * nothing in the pipeline minted a single one, so the section had no producer at
 * all. Same class of gap as the missing Decision producer: a node type in the
 * schema that no stage fills.
 *
 * EVERY FIGURE HERE WAS ALREADY MEASURED. This probe computes nothing new; it
 * restates `harvest.scale` and counts paths in the tree it was handed, and cites
 * the command that produces each figure so a reader can re-run it at the pinned
 * SHA. A stat tile is the easiest place in an artifact to put a number nobody
 * checked, which is exactly why each one carries the command that produced it.
 *
 * A citation only earns that trust if running it yields the number the tile
 * shows - the one rule three findings on these tiles all reduce to. The audit's
 * evidenceResolver never executes a command's excerpt, so a tile whose cited
 * command selects a DIFFERENT set than its value counts - the whole tree instead
 * of the production-source subset, say - ships a number that looks checkable and
 * is not, which is worse than no citation. So the count and the command are built
 * from ONE `select`: a path filter is a predicate AND the `grep -iE` pipeline that
 * reproduces it, both off the same regex sources (`SOURCE_EXTENSION_ERE`,
 * `TEST_PATH_ERE`), so the two cannot diverge by review.
 *
 * The same rule governs HOW the lines tile counts, not just WHICH files it reads.
 * `scale.lines` is `countLines` summed per file (`tree.ts`), which counts a final
 * line with no trailing newline as a line; a bare `wc -l` counts newline bytes, so
 * it under-reports by one per file lacking a trailing newline, and `xargs`
 * concatenation merges such a file's last line into the next file's first. Piping
 * each blob through `awk 1` re-emits every record newline-terminated before the
 * count, so `wc -l` then reproduces `countLines` exactly. The command is fixed to
 * match the measured figure; the figure is never adjusted to suit the command.
 *
 * It emits nothing rather than a zero for a figure the harvest could not
 * establish: "0 commits" is a claim, and an unmeasured value rendered as 0 is a
 * false one. #5's rule that a probe finding nothing emits nothing applies per
 * figure, not just per probe.
 */
import {
  MIGRATION_EXTENSION_ERE,
  MIGRATION_PATH_ERE,
  SOURCE_EXTENSION_ERE,
  TEST_PATH_ERE,
  countLines,
  hasSourceExtension,
  isMigrationFile,
  isSourceFile,
  isTestPath,
} from "../../harvest/tree.js";
import type { Candidate, Probe, ProbeContext } from "../types.js";
import type { Evidence } from "../../schema/types.js";

const fact = (
  id: string,
  label: string,
  value: string,
  title: string,
  cmd: string,
  excerpt: string,
): Candidate => ({
  probe_id: "measured-scale",
  node: {
    type: "fact" as const,
    id,
    title,
    label,
    value,
    evidence: [{ kind: "command", cmd, output_excerpt: excerpt } satisfies Evidence],
    // Every figure here is a command's output, so the tile says so. `source` is
    // what the renderer shows beside the number, and a tile whose provenance
    // said "file" while citing a command would misdescribe its own evidence.
    source: "command" as const,
    confidence: "verified" as const,
    interview_value: 0,
  },
});

const thousands = (n: number): string => n.toLocaleString("en-US");

/**
 * A path filter as both the predicate that counts and the `grep -iE` pipeline
 * that reproduces it. The pipeline is rendered from `SOURCE_EXTENSION_ERE` and
 * `TEST_PATH_ERE`, the exact sources `isSourceFile`/`isTestPath` compile, so the
 * grep can never select a set the predicate would not.
 */
interface PathFilter {
  keep: (path: string) => boolean;
  pipe: string;
}

const productionSource: PathFilter = {
  keep: isSourceFile,
  pipe: `grep -iE '${SOURCE_EXTENSION_ERE}' | grep -ivE '${TEST_PATH_ERE}'`,
};

const testFiles: PathFilter = {
  keep: (p) => hasSourceExtension(p) && isTestPath(p),
  pipe: `grep -iE '${SOURCE_EXTENSION_ERE}' | grep -iE '${TEST_PATH_ERE}'`,
};

/**
 * Schema migrations, from the same one-select discipline: `isMigrationFile` is
 * the predicate and the pipeline is its two EREs, so the tile's number and the
 * command a reader would run to check it cannot select different sets.
 */
const migrations: PathFilter = {
  keep: isMigrationFile,
  pipe: `grep -iE '${MIGRATION_PATH_ERE}' | grep -iE '${MIGRATION_EXTENSION_ERE}'`,
};

/**
 * The line command for a selection, matching `countLines` exactly.
 *
 * `awk 1` re-emits every record newline-terminated before `wc -l` counts, which
 * is what makes a bare `wc -l` reproduce `countLines` for a file with no trailing
 * newline. See this module's header: the command is fixed to match the measured
 * figure, never the other way round.
 */
const lineCommand = (sha: string, listing: string): string =>
  `${listing} | xargs -I{} sh -c 'git cat-file -p ${sha}:{} | awk 1' | wc -l`;

/** The matching paths and the listing command that selects exactly them. */
const select = (
  ctx: ProbeContext,
  filter: PathFilter,
): { paths: string[]; listing: string } => ({
  paths: ctx.paths.filter(filter.keep),
  listing: `git ls-tree -r --name-only ${ctx.sha} | ${filter.pipe}`,
});

const find = async (ctx: ProbeContext): Promise<Candidate[]> => {
  const out: Candidate[] = [];
  const { scale } = ctx.harvest;
  const source = select(ctx, productionSource);
  const tests = select(ctx, testFiles);

  if (scale.lines > 0) {
    out.push(
      fact(
        "f-scale-lines",
        "lines of production source",
        thousands(scale.lines),
        "How much code there is",
        lineCommand(ctx.sha, source.listing),
        `${thousands(scale.lines)} lines across ${thousands(source.paths.length)} production source files`,
      ),
    );
  }

  if (source.paths.length > 0) {
    out.push(
      fact(
        "f-scale-files",
        "production source files",
        thousands(source.paths.length),
        "How many files carry it",
        source.listing,
        `${thousands(source.paths.length)} production source files, ${thousands(tests.paths.length)} test files`,
      ),
    );
  }

  if (scale.commits > 0) {
    // The two together are the interesting figure: a commit count alone says
    // nothing without the window it happened in.
    const window =
      scale.days === null
        ? ""
        : `, over ${thousands(scale.days)} calendar day${scale.days === 1 ? "" : "s"}`;
    out.push(
      fact(
        "f-scale-history",
        scale.days === null ? "commits" : `commits, ${thousands(scale.days)} calendar days`,
        thousands(scale.commits),
        "How long it took",
        `git rev-list --count ${ctx.sha}`,
        `${thousands(scale.commits)} commits${window}${
          scale.first_commit === null ? "" : ` (${scale.first_commit} to ${scale.last_commit})`
        }`,
      ),
    );
  }

  if (tests.paths.length > 0) {
    out.push(
      fact(
        "f-scale-tests",
        "test files",
        thousands(tests.paths.length),
        "How much of it is tested",
        tests.listing,
        `${thousands(tests.paths.length)} test files alongside ${thousands(source.paths.length)} production files`,
      ),
    );
  }

  // The test-line figure is the one tile this probe MEASURES rather than
  // restates, because `harvest.scale` carries production lines only - and the
  // reference overview opens with both halves, since "how much of this is test
  // code" is a different question from "how big is it".
  //
  // Measuring it here would break the module's own guarantee unless the reading
  // is reconciled first, so it is: the same `lines` helper is run over the
  // PRODUCTION selection and must reproduce `scale.lines`, the figure the harvest
  // established independently. Where the two disagree, this probe's reading of a
  // line is not the harvest's, and it states no line figure it cannot ground - it
  // does not publish a second number and leave a reader to discover the two were
  // counted differently.
  const lines = (paths: string[]): number =>
    paths.reduce((n, p) => n + countLines(ctx.read(p) ?? ""), 0);

  if (tests.paths.length > 0 && lines(source.paths) === scale.lines) {
    const testLines = lines(tests.paths);
    if (testLines > 0) {
      out.push(
        fact(
          "f-scale-test-lines",
          "lines of test source",
          thousands(testLines),
          "How much of it is test code",
          lineCommand(ctx.sha, tests.listing),
          `${thousands(testLines)} lines of test source against ${thousands(scale.lines)} of production source`,
        ),
      );
    }
  }

  const schema = select(ctx, migrations);
  if (schema.paths.length > 0) {
    // Versioned migrations are the shape of a schema that was grown rather than
    // generated, and the count is the number of times it changed on purpose.
    const first = schema.paths[0];
    const last = schema.paths[schema.paths.length - 1];
    out.push(
      fact(
        "f-scale-migrations",
        `schema migration${schema.paths.length === 1 ? "" : "s"}`,
        thousands(schema.paths.length),
        "How the schema got here",
        schema.listing,
        schema.paths.length === 1
          ? `1 migration file: ${first}`
          : `${thousands(schema.paths.length)} migration files, ${first} through ${last}`,
      ),
    );
  }

  return out;
};

export const measuredScale: Probe = {
  id: "measured-scale",
  /**
   * Every tile IS a captured command's output, which is #3's second leg of
   * `verified` verbatim, and the count and the command are built from one
   * `select` so they cannot select different sets (#28).
   */
  reading: "direct",
  finds: "the scale figures the harvest measured, each citing the command that produces it",
  toolchain: "any",
  run: find,
};
