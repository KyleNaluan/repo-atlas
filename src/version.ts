/**
 * The package version, read from package.json at runtime rather than duplicated
 * as a literal - two places to bump is one place to forget.
 */
import { readFileSync } from "node:fs";

const PACKAGE_URL = new URL("../package.json", import.meta.url);

export const version: string = (
  JSON.parse(readFileSync(PACKAGE_URL, "utf8")) as { version: string }
).version;
