import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

describe("fixture temp ownership", () => {
  it("routes every mkdtemp fixture below the run-scoped root", () => {
    // globalSetup owns this directory and removes it after all workers finish.
    // This assertion prevents a future suite from silently returning to the
    // process-wide /tmp root, which is how the flow/probe fixtures exhausted the
    // fleet tmpfs with one inode per tiny git repository.
    const owned = process.env["REPO_ATLAS_TEST_TEMP_ROOT"];
    expect(owned).toBeDefined();
    expect(tmpdir()).toBe(owned);
    expect(existsSync(owned!)).toBe(true);
  });
});
