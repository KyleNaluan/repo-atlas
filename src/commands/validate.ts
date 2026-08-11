/**
 * `repo-atlas validate <atlas.json>` - the fail-closed contract check (#3),
 * exposed on its own so a consumer of the stable output contract (the separate
 * interview-prep tool) can check a document with the same code the engine uses,
 * rather than a second implementation that can disagree with it.
 */
import { loadAtlas, AtlasValidationError } from "../schema/validate.js";
import { admissible } from "../schema/types.js";

const USAGE = `usage: repo-atlas validate <atlas.json>

Validates a document against the generated JSON Schema and the major-version
rule, then prints what it contains. Exits 0 only if the document is valid.`;

export const validateCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const path = argv[0];
  if (path === undefined) {
    console.error(USAGE);
    return 64;
  }

  try {
    const atlas = loadAtlas(path);
    const surviving = atlas.nodes.filter(admissible);
    const byType = new Map<string, number>();
    for (const n of surviving) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
    const types = [...byType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, c]) => `${t} ${c}`)
      .join(", ");

    console.log(`${path}: valid against atlas.json schema ${atlas.schema_version}`);
    console.log(`  subject      ${atlas.subject.owner}/${atlas.subject.repo} @ ${atlas.subject.sha}`);
    console.log(`  profile      ${atlas.profile}, rubric ${atlas.rubric_version}`);
    console.log(`  nodes        ${atlas.nodes.length} (${surviving.length} admissible: ${types || "none"})`);
    console.log(`  cut          ${atlas.record.absent_cuts.length} no evidence, ${atlas.record.deletions.length} rank/budget`);
    console.log(`  audit        ${atlas.record.audit.status}`);
    return 0;
  } catch (error) {
    if (error instanceof AtlasValidationError) {
      console.error(`${error.message}`);
      for (const p of error.problems) console.error(`  - ${p}`);
      return 65; // EX_DATAERR
    }
    throw error;
  }
};
