import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One owned temp root for the whole Vitest run, removed even when tests fail. */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "repo-atlas-vitest-"));
  process.env["TMPDIR"] = root;
  process.env["REPO_ATLAS_TEST_TEMP_ROOT"] = root;
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
