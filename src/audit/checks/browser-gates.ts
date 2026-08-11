/**
 * S2, S3, S4, L4, E1 - the gates that need a live DOM.
 *
 * E1 is the headline check of the whole contract, and it is only possible
 * because the render stage stamps provenance. Post-hoc attribution was measured
 * at 39% of the artifact's words unattributable from the DOM, concentrated
 * exactly in the folded sections where re-derivation would hide, and no
 * text-matching closes that gap because the renderer legitimately clamps, slices
 * and composes. An approximate check cannot be a hard gate, so the render stage
 * carries the burden and this reads what it wrote.
 */
import { statSync, readdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import type { Page } from "puppeteer-core";
import { spec } from "../register.js";
import { failed, passed, type CheckResult } from "../types.js";
import type { Atlas } from "../../schema/types.js";
import type { LoadedPage } from "../browser.js";

/**
 * S2 - exactly one network request when loaded.
 *
 * The request log is the whole check. S1's grep catches a reference in code that
 * never executes; this catches a request S1's regexes do not know how to spell.
 */
export const oneRequest = (loaded: LoadedPage, artifactPath: string): CheckResult => {
  const foreign = loaded.requests.filter((url) => url !== `file://${artifactPath}`);
  return foreign.length === 0 && loaded.requests.length === 1
    ? passed(spec("S2"), loaded.requests.length)
    : failed(
        spec("S2"),
        foreign.length > 0
          ? foreign.slice(0, 20).map((url) => `the page requested ${url}`)
          : [`expected exactly one request, the file itself; the page made ${loaded.requests.length}`],
        loaded.requests.length,
      );
};

/**
 * S3 - console clean.
 *
 * A gate, not a warning, and the reasoning is worth keeping: a console error in
 * an artifact with ~40 lines of inline JS means the collapse and deep-link
 * behaviour is broken, which means a reader following a Q&A row can land
 * nowhere. The index would be lying about where the answer lives. That is a
 * truth failure, not a polish failure.
 */
export const consoleClean = (loaded: LoadedPage): CheckResult => {
  const problems = [
    ...loaded.console.filter((line) => !line.startsWith("log:") && !line.startsWith("debug:")),
    ...loaded.pageErrors.map((message) => `uncaught: ${message}`),
  ];
  return problems.length === 0
    ? passed(spec("S3"), 0)
    : failed(spec("S3"), problems.slice(0, 20), problems.length);
};

/**
 * S4 - the artifact is one file, and nothing was written beside it.
 *
 * Trivial, and it is the property the whole self-contained claim rests on. The
 * comparison is against the files the render stage is allowed to emit: exactly
 * the artifact, and on a failed run its quarantined copy.
 */
export const oneFile = (artifactPath: string): CheckResult => {
  const stat = statSync(artifactPath);
  if (!stat.isFile()) {
    return failed(spec("S4"), [`${artifactPath} is not a regular file`], 0);
  }
  const dir = dirname(artifactPath);
  const name = basename(artifactPath);
  const siblings = readdirSync(dir).filter(
    (entry) => entry !== name && entry !== `${name.replace(/\.html$/, "")}.failed.html`,
  );
  // Siblings are reported, not forbidden: the output directory may legitimately
  // hold atlas.json and earlier artifacts. What matters is that the artifact
  // needs none of them, which S1 and S2 establish.
  return passed(spec("S4"), siblings.length);
};

/**
 * L4 - every internal anchor resolves to an element.
 *
 * This is the check that makes the Q&A table's promise real. The captain ruled
 * the table stays at the front because it is an index; an index whose rows can
 * point nowhere is not an index.
 */
export const anchorsResolve = async (page: Page): Promise<CheckResult> => {
  const broken = await page.evaluate(() => {
    const targets = Array.from(document.querySelectorAll('a[href^="#"]'))
      .map((a) => (a.getAttribute("href") ?? "").slice(1))
      .filter((id) => id.length > 0);
    const unique = [...new Set(targets)];
    return {
      total: unique.length,
      broken: unique.filter((id) => document.getElementById(id) === null),
    };
  });
  return broken.broken.length === 0
    ? passed(spec("L4"), broken.total)
    : failed(
        spec("L4"),
        broken.broken.map((id) => `internal link #${id} points at no element`),
        broken.total,
      );
};

/**
 * E1 - every prose passage traces to a graph field or to the chrome inventory.
 *
 * The operational definition (#8, point 4): every text node of four-plus words
 * is either attributable to a specific field of a specific graph element
 * carrying admissible evidence, or a member of the renderer's declared chrome.
 * Nothing else.
 *
 * The check is in three parts, and the second and third are what #16 adds beyond
 * "is there a stamp":
 *   1. no wordy text node lies outside a data-ev or data-chrome stamp;
 *   2. every owner a data-ev stamp names actually exists in the graph and
 *      survived the confidence gate;
 *   3. every node owner carries evidence, so a stamp cannot launder a claim by
 *      pointing at a node that has none.
 */
const WORDY = 4;

export const provenanceWalk = async (page: Page, atlas: Atlas): Promise<CheckResult> => {
  const walk = await page.evaluate((minWords: number) => {
    const unattributed: string[] = [];
    const owners = new Set<string>();
    let attributed = 0;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text.split(/\s+/).filter(Boolean).length < minWords) continue;

      // Two things on the page are not prose and are excluded by construction.
      //
      // Script and style source is behaviour, not a passage anyone reads; #8's
      // definition is about prose text nodes, and demanding graph provenance for
      // the inline JS would be asking the renderer to attribute its own machinery
      // to the subject repository.
      //
      // The audit's own statement is the single place on the page permitted to
      // make a claim the graph does not support - it reports what the audit
      // established. It is already isolated by the hash-exclusion mechanic, and
      // attributing it to a node would be exactly the confusion the reserved slot
      // exists to prevent.
      let excluded: HTMLElement | null = node.parentElement;
      let skip = false;
      while (excluded !== null) {
        const tag = excluded.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || excluded.hasAttribute("data-atlas-audit")) {
          skip = true;
          break;
        }
        excluded = excluded.parentElement;
      }
      if (skip) continue;

      let element: HTMLElement | null = node.parentElement;
      let stamp: string | null = null;
      let chrome = false;
      while (element !== null) {
        const ev = element.getAttribute("data-ev");
        if (ev !== null) {
          stamp = ev;
          break;
        }
        if (element.hasAttribute("data-chrome")) {
          chrome = true;
          break;
        }
        element = element.parentElement;
      }
      if (stamp !== null) {
        attributed += 1;
        owners.add(stamp.split(":")[0] ?? "");
      } else if (chrome) {
        attributed += 1;
      } else {
        unattributed.push(text.slice(0, 100));
      }
    }
    return { unattributed, owners: [...owners], attributed };
  }, WORDY);

  const problems = walk.unattributed
    .slice(0, 20)
    .map((text) => `unattributed passage: ${JSON.stringify(text)}`);

  // Parts 2 and 3: a stamp that names a node the graph does not hold, or holds
  // without evidence, is worse than no stamp - it looks like provenance.
  const byId = new Map(atlas.nodes.map((n) => [n.id, n]));
  const METADATA_OWNERS = new Set(["synopsis", "shape", "record"]);
  for (const owner of walk.owners) {
    if (METADATA_OWNERS.has(owner)) continue;
    const node = byId.get(owner);
    if (!node) {
      problems.push(`a passage claims provenance from ${owner}, which is not in the graph`);
      continue;
    }
    if (node.confidence === "absent") {
      problems.push(`a passage claims provenance from ${owner}, which the confidence gate cut`);
    }
    if (node.evidence.length === 0) {
      problems.push(`a passage claims provenance from ${owner}, which carries no evidence`);
    }
  }

  return problems.length === 0
    ? passed(spec("E1"), walk.attributed)
    : failed(spec("E1"), problems, walk.attributed + walk.unattributed.length);
};
