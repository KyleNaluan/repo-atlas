/**
 * Pass B - browser, network disabled.
 *
 * Five hard gates and three computed warnings, over one page load. It runs after
 * pass A because there is no point launching a browser to look at an artifact
 * whose evidence does not resolve.
 *
 * Screenshots are kept as ARTIFACTS OF the audit, not inputs TO it (#8, 6.4).
 * They exist so a human can see what was measured; no check reads them, and no
 * model is asked what they show.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openArtifact, type LoadedPage } from "./browser.js";
import {
  anchorsResolve,
  consoleClean,
  oneFile,
  oneRequest,
  provenanceWalk,
} from "./checks/browser-gates.js";
import { runVisualChecks, VIEWPORTS, type ViewportMeasurement } from "./checks/visual.js";
import { isBlocking, type CheckResult } from "./types.js";
import type { Atlas } from "../schema/types.js";

export interface PassBOptions {
  /** Where to write the per-viewport screenshots, if anywhere. */
  screenshotDir?: string;
}

export interface PassBResult {
  checks: CheckResult[];
  measurements: ViewportMeasurement[];
  screenshots: string[];
}

export const runPassB = async (
  artifactPath: string,
  atlas: Atlas,
  options: PassBOptions = {},
): Promise<PassBResult> => {
  const path = resolve(artifactPath);
  const loaded: LoadedPage = await openArtifact(path);
  const checks: CheckResult[] = [];
  const screenshots: string[] = [];
  let measurements: ViewportMeasurement[] = [];

  try {
    // Gates first, cheapest and most decisive, exactly as in pass A. A gate
    // failure stops the pass: the visual checks would be measuring the quality
    // of a document that is not going to ship.
    const gates = [
      oneRequest(loaded, path),
      consoleClean(loaded),
      oneFile(path),
      await anchorsResolve(loaded.page),
      await provenanceWalk(loaded.page, atlas),
    ];
    for (const gate of gates) {
      checks.push(gate);
      if (isBlocking(gate)) return { checks, measurements, screenshots };
    }

    const visual = await runVisualChecks(loaded.page);
    measurements = visual.measurements;
    checks.push(...visual.checks);

    if (options.screenshotDir) {
      const dir = resolve(options.screenshotDir);
      mkdirSync(dir, { recursive: true });
      for (const width of VIEWPORTS) {
        await loaded.page.setViewport({ width, height: 900 });
        const file = join(dir, `viewport-${width}.png`);
        await loaded.page.screenshot({ path: file as `${string}.png`, fullPage: true });
        screenshots.push(file);
      }
    }
  } finally {
    await loaded.close();
  }

  return { checks, measurements, screenshots };
};

/** Written into the audit statement: the widths the layout checks actually ran at. */
export const declaredViewports = (): number[] => [...VIEWPORTS];
