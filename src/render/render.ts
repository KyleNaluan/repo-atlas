/**
 * `atlas.json` -> one static, self-contained HTML file.
 *
 * The pipeline #7 settled, and each arrow is load-bearing:
 *
 *   atlas.json -> validate (generated JSON Schema, fail closed)
 *              -> the confidence gate, applied EXACTLY ONCE
 *              -> pure projections (Q&A fold, source index fold)
 *              -> diagrams (Graphviz WASM, cached on flow hash + engine version)
 *              -> sections -> one HTML string
 *
 * The gate is applied here and nowhere else, so no section can hedge an `absent`
 * node back in - no section ever sees one. And nothing downstream of the rank
 * stage deletes anything: this function renders everything it is handed.
 */
import { html, type Safe } from "./html.js";
import { CSS } from "./theme.js";
import type { DiagramCache } from "./diagram.js";
import {
  footerBlock,
  heroBlock,
  navBlock,
  sectionDecisions,
  sectionDives,
  sectionEdges,
  sectionFlows,
  sectionQa,
  sectionRecord,
  sectionShape,
  sectionSourceIndex,
  sectionWhat,
} from "./sections.js";
import { admissible, type Atlas } from "../schema/types.js";

/** ~40 lines of progressive enhancement. The page is fully usable with JS off. */
const SCRIPT = `
(function(){
  var btn = document.getElementById('expand-decisions');
  if (btn) btn.addEventListener('click', function(){
    var all = document.querySelectorAll('details.dec');
    var open = [].every.call(all, function(d){ return d.open; });
    [].forEach.call(all, function(d){ d.open = !open; });
    btn.textContent = (open ? 'Expand' : 'Collapse') + ' all ' + all.length + ' decisions';
  });
  // A deep link into a collapsed decision must open it, or the Q&A index at 02
  // points at somewhere the reader cannot see.
  function openTarget(){
    if (!location.hash) return;
    var el;
    try { el = document.querySelector(location.hash); } catch (e) { return; }
    while (el) { if (el.tagName === 'DETAILS') el.open = true; el = el.parentElement; }
  }
  window.addEventListener('hashchange', openTarget); openTarget();
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a) setTimeout(openTarget, 0);
  });
  var links = {};
  [].forEach.call(document.querySelectorAll('.toc a'), function(a){
    var href = a.getAttribute('href');
    if (href && href.charAt(0) === '#') links[href.slice(1)] = a;
  });
  if (window.IntersectionObserver) {
    var obs = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        var a = links[en.target.id];
        if (a && en.isIntersecting) {
          [].forEach.call(document.querySelectorAll('.toc a.on'), function(x){ x.classList.remove('on'); });
          a.classList.add('on');
        }
      });
    }, { rootMargin: '-90px 0px -70% 0px' });
    [].forEach.call(document.querySelectorAll('section[id]'), function(s){ obs.observe(s); });
  }
})();
`;

export interface RenderOptions {
  cache?: DiagramCache;
}

export const render = async (atlas: Atlas, options: RenderOptions = {}): Promise<string> => {
  // The hard confidence gate (#3), applied exactly once.
  const surviving = atlas.nodes.filter(admissible);

  // Async sections are resolved before assembly so the template stays a plain
  // synchronous fold - one place where the page order is visible in full.
  const flows = await sectionFlows(atlas, surviving, options.cache);
  const dives = await sectionDives(atlas, surviving);

  const body: Safe = html`
    ${heroBlock(atlas)} ${navBlock(atlas)}
    <div class="wrap">
      ${sectionWhat(atlas, surviving)} ${sectionQa(atlas, surviving)}
      ${sectionShape(atlas, surviving)} ${flows} ${sectionDecisions(atlas, surviving)} ${dives}
      ${sectionEdges(atlas, surviving)} ${sectionRecord(atlas, surviving)}
      ${sectionSourceIndex(atlas, surviving)} ${footerBlock(atlas)}
    </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${atlas.subject.owner}/${atlas.subject.repo} - codebase atlas @ ${atlas.subject.sha.slice(0, 7)}</title>
<style>${CSS}</style>
</head>
<body>
${body.toString()}
<script>${SCRIPT}</script>
</body>
</html>
`;
};
