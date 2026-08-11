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
import { abortedFor, isBlocking, type CheckResult } from "./types.js";
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

/**
 * One step behind the same per-check error boundary pass A uses. A browser check
 * that throws - the page context is destroyed, the browser dies mid-run - becomes
 * a defined `aborted` failure for each id it owns rather than an exception that
 * escapes runPassB and degrades an audit report into a generic exit 70. The
 * checks it never reached are named as not-run by run.ts, exactly as in pass A.
 */
interface Step {
  ids: string[];
  run: () => Promise<CheckResult[]> | CheckResult[];
}

const runStep = async (step: Step): Promise<CheckResult[]> => {
  try {
    return await step.run();
  } catch (cause) {
    return abortedFor(step.ids, cause);
  }
};

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
    // Gates first, cheapest and most decisive, exactly as in pass A. A blocking
    // result - a gate failure or an aborted check - stops the pass: the visual
    // checks would be measuring the quality of a document that is not going to
    // ship, or a page whose context is already gone.
    const steps: Step[] = [
      { ids: ["S2"], run: () => [oneRequest(loaded, path)] },
      { ids: ["S3"], run: () => [consoleClean(loaded)] },
      { ids: ["S4"], run: () => [oneFile(path)] },
      { ids: ["L4"], run: async () => [await anchorsResolve(loaded.page)] },
      { ids: ["E1"], run: async () => [await provenanceWalk(loaded.page, atlas)] },
      {
        ids: ["V1", "V2", "V3"],
        run: async () => {
          const visual = await runVisualChecks(loaded.page);
          measurements = visual.measurements;
          return visual.checks;
        },
      },
    ];
    for (const step of steps) {
      const rs = await runStep(step);
      checks.push(...rs);
      if (rs.some(isBlocking)) return { checks, measurements, screenshots };
    }

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
