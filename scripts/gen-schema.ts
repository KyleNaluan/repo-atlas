/**
 * Generate `schema/atlas.schema.json` from `src/schema/types.ts`.
 *
 * #3: "Hand-maintained JSON Schema - drifts from the types; generation makes
 * drift structurally impossible." This script is that generation, and
 * `--check` is the CI half: it regenerates in memory and fails if the committed
 * file differs, so a type change without a schema regen cannot merge.
 *
 *   npm run schema:gen      write the schema
 *   npm run schema:check    fail if the committed schema is stale
 */
import { createGenerator } from "ts-json-schema-generator";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const OUT = resolve(root, "schema/atlas.schema.json");

const generate = (): string => {
  const schema = createGenerator({
    path: resolve(root, "src/schema/types.ts"),
    tsconfig: resolve(root, "tsconfig.json"),
    type: "Atlas",
    expose: "export",
    topRef: true,
    jsDoc: "extended",
    additionalProperties: false,
    sortProps: true,
    skipTypeCheck: true,
  }).createSchema("Atlas");
  // Stable, diffable, and byte-identical run to run.
  return `${JSON.stringify(schema, null, 2)}\n`;
};

const main = () => {
  const generated = generate();
  if (process.argv.includes("--check")) {
    let committed: string;
    try {
      committed = readFileSync(OUT, "utf8");
    } catch {
      console.error(`schema:check - ${OUT} does not exist. Run \`npm run schema:gen\`.`);
      process.exit(1);
    }
    if (committed !== generated) {
      console.error(
        "schema:check - schema/atlas.schema.json is stale relative to src/schema/types.ts.\n" +
          "Run `npm run schema:gen` and commit the result.",
      );
      process.exit(1);
    }
    console.log("schema:check - schema/atlas.schema.json matches src/schema/types.ts");
    return;
  }
  writeFileSync(OUT, generated, "utf8");
  console.log(`wrote ${OUT} (${(generated.length / 1024).toFixed(1)} KB)`);
};

main();
