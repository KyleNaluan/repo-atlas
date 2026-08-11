/**
 * V1, V2, V3 - the visual checks, computed rather than judged.
 *
 * All three are warnings, and that is the classification rule doing its job:
 * their failure means the artifact is worse than it should be, not that it makes
 * a claim that is not true. Evidence is truth; layout is quality.
 *
 * No model is asked "does this look right" (#8 rejects it: a model asked whether
 * a page looks verified says yes, and there is no fixture that can prove such a
 * check works). Every named defect - horizontal scroll, clipping, contrast - is
 * computable from layout, so it is computed.
 *
 * Two mechanics are deliberate, both learned the hard way in the prototype:
 *
 * - Every `<details>` is forced open first. Collapsed content is content, and a
 *   layout check that only sees the summary measures a document nobody reads.
 * - Static invariants are preferred over interaction simulation. Asserting
 *   `scroll-padding-top >= nav height` beats driving 42 scrolls: the simulated
 *   version raced against smooth scrolling and passed while measuring nothing.
 */
import type { Page } from "puppeteer-core";
import { spec } from "../register.js";
import { failed, passed, type CheckResult } from "../types.js";

/** #8, point 11: the declared viewport matrix, named in the audit statement. */
export const VIEWPORTS = [390, 768, 1280, 1440] as const;

const VIEWPORT_HEIGHT = 900;

/** WCAG 2.1 AA: 4.5:1 for body text, 3:1 for large text (>=18.66px bold or >=24px). */
const AA_NORMAL = 4.5;
const AA_LARGE = 3;

export interface ViewportMeasurement {
  width: number;
  scrollWidth: number;
  clientWidth: number;
  overflowing: string[];
  clipped: string[];
  lowContrast: string[];
}

/**
 * The in-page measurement, as a source string rather than a function.
 *
 * This is deliberate and it is not stylistic. A function handed to
 * `page.evaluate` is compiled by whatever bundler is in the toolchain first, and
 * esbuild's keep-names transform rewrites inner helpers into `__name(fn, "...")`
 * calls whose helper does not exist in the browser. The failure is a runtime
 * "__name is not defined" inside the page, which surfaces as the audit crashing
 * rather than as anything to do with the artifact. A string is evaluated exactly
 * as written, in every toolchain, so the check measures the page instead of the
 * build.
 */
const measureScript = (normal: number, large: number): string => `(() => {
  const doc = document.documentElement;
  const describe = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = typeof el.className === "string" && el.className
      ? "." + el.className.trim().split(/\\s+/).join(".")
      : "";
    const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : "");
  };

  /* True when some ancestor scrolls or clips this element on purpose. Wide
     content living in its own scroller is the design, not a defect. */
  const inItsOwnFrame = (el) => {
    let parent = el.parentElement;
    while (parent !== null && parent !== doc) {
      if (getComputedStyle(parent).overflowX !== "visible") return true;
      parent = parent.parentElement;
    }
    return false;
  };

  const overflowing = [];
  const clipped = [];
  const lowContrast = [];

  const all = Array.prototype.slice.call(document.querySelectorAll("body *"));
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.right > doc.clientWidth + 1 && !inItsOwnFrame(el)) {
      overflowing.push(describe(el));
    }
    const style = getComputedStyle(el);
    /* Clipping means text wider than its box in a box that does not scroll AND
       that nothing above it scrolls either. Content inside its own scroller -
       a diagram, a wide table, a code block - is the design, not a defect.
       SVG elements are excluded: scrollWidth and clientWidth do not describe
       SVG geometry, so comparing them reports every label in every diagram. */
    if (
      !(el instanceof SVGElement) &&
      el.scrollWidth > el.clientWidth + 1 &&
      style.overflowX === "visible" &&
      !inItsOwnFrame(el) &&
      (el.textContent || "").trim().length > 0 &&
      el.children.length === 0
    ) {
      clipped.push(describe(el));
    }
  }

  const parseColor = (value) => {
    const parts = value.match(/[\\d.]+/g) || [];
    return [
      Number(parts[0] || 0),
      Number(parts[1] || 0),
      Number(parts[2] || 0),
      parts[3] === undefined ? 1 : Number(parts[3]),
    ];
  };
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const effectiveBackground = (el) => {
    let node = el;
    while (node !== null) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg[3] > 0) return bg;
      node = node.parentElement;
    }
    return [14, 17, 22, 1];
  };

  /* SVG text is painted with 'fill', not 'color'. A Graphviz <text> reads its
     CSS 'color' as the inherited page ink, which is not what is on screen, so a
     diagram label must be scored against its fill instead. This is a different
     reason from the clipping loop's SVGElement skip - that one exists because
     scrollWidth/clientWidth do not describe SVG geometry at all - so the two
     carve-outs are not the same rule and must not be unified away. */
  const svgForeground = (el) => {
    const fill = getComputedStyle(el).fill;
    if (!fill || fill === "none") return null;
    const c = parseColor(fill);
    return c[3] === 0 ? null : c;
  };
  const svgShapes = ["polygon", "ellipse", "path", "rect", "circle", "polyline"];
  /* Graphviz emits each box as a shape and its label as siblings in one <g>, so
     the paint behind a label is a preceding sibling shape the text sits over.
     Require geometric containment so an edge's arrowhead polygon is not mistaken
     for the box behind an edge label; when nothing sits behind the text - an edge
     label over the frame rather than over a box - the caller falls back to the
     CSS ancestor background, which is correct for that case. */
  const svgBackground = (el, rect) => {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let sib = el.previousElementSibling;
    while (sib !== null) {
      if (svgShapes.indexOf(sib.tagName.toLowerCase()) !== -1) {
        const r = sib.getBoundingClientRect();
        if (r.left <= cx && cx <= r.right && r.top <= cy && cy <= r.bottom) {
          const fill = getComputedStyle(sib).fill;
          if (fill && fill !== "none") {
            const c = parseColor(fill);
            if (c[3] > 0) return c;
          }
        }
      }
      sib = sib.previousElementSibling;
    }
    return null;
  };

  for (const el of all) {
    if (el.children.length > 0) continue;
    const text = (el.textContent || "").trim();
    if (text.length === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    let fg;
    let bg;
    if (el instanceof SVGElement) {
      fg = svgForeground(el);
      if (fg === null) continue;
      bg = svgBackground(el, rect) || effectiveBackground(el);
    } else {
      fg = parseColor(style.color);
      if (fg[3] === 0) continue;
      bg = effectiveBackground(el);
    }
    const lighter = Math.max(luminance(fg), luminance(bg));
    const darker = Math.min(luminance(fg), luminance(bg));
    const ratio = (lighter + 0.05) / (darker + 0.05);
    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const required = size >= 24 || (bold && size >= 18.66) ? ${large} : ${normal};
    if (ratio < required) {
      lowContrast.push(describe(el) + " at " + ratio.toFixed(2) + ":1, needs " + required + ":1");
    }
  }

  return {
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    overflowing: overflowing,
    clipped: clipped,
    lowContrast: lowContrast,
  };
})()`;

/**
 * One pass over a viewport.
 *
 * Everything is measured in one evaluate call so the three checks see exactly
 * the same frame - measuring them separately would let a relayout between calls
 * make two checks disagree about the same page.
 *
 * Every `<details>` is forced open first. Collapsed content is content, and a
 * layout check that only sees the summaries measures a document nobody reads.
 */
const measure = async (page: Page, width: number): Promise<ViewportMeasurement> => {
  await page.setViewport({ width, height: VIEWPORT_HEIGHT });
  await page.evaluate(
    `(() => { const d = document.querySelectorAll("details"); for (let i = 0; i < d.length; i += 1) d[i].open = true; })()`,
  );
  // Let the forced-open layout settle before measuring it.
  await new Promise((resolve) => setTimeout(resolve, 60));

  const measured = (await page.evaluate(measureScript(AA_NORMAL, AA_LARGE))) as Omit<
    ViewportMeasurement,
    "width"
  >;
  return { width, ...measured };
};

export interface VisualResults {
  measurements: ViewportMeasurement[];
  checks: CheckResult[];
}

export const runVisualChecks = async (page: Page): Promise<VisualResults> => {
  const measurements: ViewportMeasurement[] = [];
  for (const width of VIEWPORTS) measurements.push(await measure(page, width));

  const scrolls = measurements.filter((m) => m.scrollWidth > m.clientWidth + 1);
  const v1 =
    scrolls.length === 0
      ? passed(spec("V1"), VIEWPORTS.length)
      : failed(
          spec("V1"),
          scrolls.map(
            (m) =>
              `the page scrolls horizontally at ${m.width}px (content is ${m.scrollWidth}px wide)` +
              (m.overflowing.length > 0 ? `: ${m.overflowing.slice(0, 3).join("; ")}` : ""),
          ),
          VIEWPORTS.length,
        );

  const clipped = measurements.flatMap((m) =>
    m.clipped.map((c) => `at ${m.width}px, clipped by a non-scrollable ancestor: ${c}`),
  );
  const v2 =
    clipped.length === 0
      ? passed(spec("V2"), VIEWPORTS.length)
      : failed(spec("V2"), clipped.slice(0, 20), clipped.length);

  const contrast = measurements.flatMap((m) =>
    m.lowContrast.map((c) => `at ${m.width}px, below WCAG AA: ${c}`),
  );
  // The same element fails at every width, so report each distinct finding once.
  const distinctContrast = [
    ...new Set(contrast.map((c) => c.replace(/^at \d+px, /, ""))),
  ];
  const v3 =
    distinctContrast.length === 0
      ? passed(spec("V3"), VIEWPORTS.length)
      : failed(spec("V3"), distinctContrast.slice(0, 20), distinctContrast.length);

  return { measurements, checks: [v1, v2, v3] };
};
