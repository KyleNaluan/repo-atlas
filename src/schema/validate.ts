/**
 * Load and validate an `atlas.json` against the generated JSON Schema, and fail
 * closed.
 *
 * #3 makes `atlas.json` the stable contract and requires the schema be generated
 * from the TypeScript types; #7's render architecture opens with
 * "validate (generated JSON Schema, fail closed)". Fail closed means: a document
 * that does not validate is never rendered, never partially rendered, and never
 * repaired. The artifact's whole claim is that its contents were checked, and a
 * renderer that tolerates a malformed contract has already broken that claim
 * before the audit stage gets a chance to.
 */
import { readFileSync } from "node:fs";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { SCHEMA_VERSION, type Atlas } from "./types.js";

/** The generated schema, read from the published `schema/` directory. */
const SCHEMA_URL = new URL("../../schema/atlas.schema.json", import.meta.url);

export class AtlasValidationError extends Error {
  constructor(
    override readonly message: string,
    readonly problems: string[],
    readonly source: string,
  ) {
    super(message);
    this.name = "AtlasValidationError";
  }
}

let compiled: ValidateFunction | null = null;

export const schemaDocument = (): unknown =>
  JSON.parse(readFileSync(SCHEMA_URL, "utf8")) as unknown;

const validator = (): ValidateFunction => {
  if (compiled !== null) return compiled;
  // `strict: false` because the generated schema carries JSDoc-derived
  // annotation keywords ajv does not know; `allErrors` because a fail-closed
  // error message that reports one problem at a time is a bad tool.
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  const fn = ajv.compile(schemaDocument() as object);
  compiled = fn;
  return fn;
};

/** ajv's error objects, rendered as one readable line each. */
const describe = (errors: ErrorObject[]): string[] =>
  errors.map((e) => {
    const at = e.instancePath === "" ? "(root)" : e.instancePath;
    const extra =
      e.keyword === "additionalProperties"
        ? ` (unknown property "${String((e.params as { additionalProperty?: string }).additionalProperty)}")`
        : e.keyword === "enum"
          ? ` (allowed: ${((e.params as { allowedValues?: unknown[] }).allowedValues ?? []).join(", ")})`
          : "";
    return `${at} ${e.message ?? "is invalid"}${extra}`;
  });

/**
 * The major-version compatibility rule from #3: the contract is additive-only
 * within a major and consumers pin the major. A document from a future major is
 * refused rather than best-effort read.
 */
const checkVersion = (version: unknown, source: string): string[] => {
  if (typeof version !== "string") return [`(root) schema_version must be a string`];
  const theirs = version.split(".")[0];
  const ours = SCHEMA_VERSION.split(".")[0];
  if (theirs !== ours) {
    return [
      `(root) schema_version ${version} is major ${theirs}; this build of repo-atlas reads major ${ours}. ` +
        `Refusing to read ${source} rather than guessing at the difference.`,
    ];
  }
  return [];
};

/**
 * Validate an already-parsed value. Throws `AtlasValidationError` on any problem.
 */
export const validateAtlas = (value: unknown, source = "<memory>"): Atlas => {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AtlasValidationError(
      `${source} is not a JSON object`,
      ["(root) must be an object"],
      source,
    );
  }
  problems.push(...checkVersion((value as { schema_version?: unknown }).schema_version, source));
  const validate = validator();
  if (!validate(value)) problems.push(...describe(validate.errors ?? []));
  if (problems.length > 0) {
    throw new AtlasValidationError(
      `${source} does not match the atlas.json schema (${problems.length} problem${
        problems.length === 1 ? "" : "s"
      })`,
      problems,
      source,
    );
  }
  return value as Atlas;
};

/** Read, parse and validate an atlas.json from disk. */
export const loadAtlas = (path: string): Atlas => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new AtlasValidationError(`cannot read ${path}`, [String(cause)], path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AtlasValidationError(`${path} is not valid JSON`, [String(cause)], path);
  }
  return validateAtlas(parsed, path);
};
