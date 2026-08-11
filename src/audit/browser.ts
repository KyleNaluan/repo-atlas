/**
 * The headless browser Pass B needs, and the precondition of having one.
 *
 * Two deliberate choices.
 *
 * `puppeteer-core` rather than `puppeteer`: the full package downloads a
 * Chromium build on install, which would put ~150 MB behind `npx repo-atlas` for
 * a tool whose render stage was kept to one runtime dependency on purpose.
 * `puppeteer-core` drives a browser that is already on the machine.
 *
 * A missing browser is a PRECONDITION FAILURE, not a skip. #8 already imposes
 * that discipline on the clone: a missing precondition is a distinct
 * `failed: precondition`, never a pass and never a silent skip. A browser is as
 * much a precondition for pass B as the clone is for pass A, and the alternative
 * - quietly reporting five hard gates as inapplicable and shipping the artifact
 * anyway - would let a machine without Chrome mint an artifact that claims more
 * verification than it received.
 *
 * The network is disabled for the whole session. That is not belt-and-braces for
 * S2: it is what makes S2 mean anything. Asserting "exactly one request" while
 * the page could still reach the network measures the page's luck.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { launch, type Browser, type Page } from "puppeteer-core";

/** Where a Chrome-family browser usually lives, per platform. */
const CANDIDATES: Record<string, string[]> = {
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/snap/bin/chromium",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

export class NoBrowserError extends Error {
  constructor(tried: string[]) {
    super(
      "pass B needs a Chrome-family browser and none was found. " +
        "Set CHROME_PATH to one, or install Chrome or Chromium. " +
        `Looked at: ${tried.join(", ")}. ` +
        "This is reported as a precondition failure rather than a skip: the audit " +
        "cannot certify what it was unable to open.",
    );
    this.name = "NoBrowserError";
  }
}

/** The browser this run will use, or an explanation of why there is none. */
export const findBrowser = (): string => {
  const declared = process.env["CHROME_PATH"] ?? process.env["PUPPETEER_EXECUTABLE_PATH"];
  const tried = declared ? [declared] : (CANDIDATES[process.platform] ?? []);
  for (const path of tried) if (existsSync(path)) return path;
  throw new NoBrowserError(tried.length > 0 ? tried : [`no candidates for ${process.platform}`]);
};

export const browserAvailable = (): boolean => {
  try {
    findBrowser();
    return true;
  } catch {
    return false;
  }
};

export interface LoadedPage {
  page: Page;
  /** Every request the page made, in order. The first is the file itself. */
  requests: string[];
  /** Console output of any level, formatted for the finding list. */
  console: string[];
  /** Page errors - an uncaught exception is a console failure by another route. */
  pageErrors: string[];
  close: () => Promise<void>;
}

export interface OpenOptions {
  /** Starting viewport. The visual checks resize from here. */
  width?: number;
  height?: number;
}

/**
 * Open a local artifact with the network disabled, recording what it asked for.
 *
 * Requests are recorded BEFORE interception decides anything, so a blocked
 * request still counts. An audit that only counted the requests that succeeded
 * would pass an artifact that tried to phone home and failed.
 */
export const openArtifact = async (
  path: string,
  options: OpenOptions = {},
): Promise<LoadedPage> => {
  const executablePath = findBrowser();
  const browser: Browser = await launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
    defaultViewport: {
      width: options.width ?? 1280,
      height: options.height ?? 900,
    },
  });

  // Everything after launch is guarded: a broken or hanging artifact - exactly
  // the kind of subject an audit is pointed at - can make newPage or the 30s
  // goto throw before the returned `close` is ever wired up, which would leak the
  // Chrome process. Close it on any failure and let the original error propagate
  // unchanged so the caller still learns what actually broke.
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    const consoleLines: string[] = [];
    const pageErrors: string[] = [];

    page.on("console", (message) => {
      consoleLines.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error: unknown) => {
      pageErrors.push(error instanceof Error ? error.message : String(error));
    });

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      requests.push(url);
      // The file itself is the only thing that may load. Everything else is
      // aborted rather than allowed to fail slowly, and it is already counted.
      if (url.startsWith("file://")) void request.continue();
      else void request.abort();
    });

    await page.goto(pathToFileURL(path).href, { waitUntil: "load", timeout: 30_000 });

    return {
      page,
      requests,
      console: consoleLines,
      pageErrors,
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
};
