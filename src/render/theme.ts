/**
 * The whole stylesheet, inlined. No framework, no external font, no CDN.
 *
 * The mobile pass is #8 point 11: the declared viewport matrix is
 * 390 / 768 / 1280 / 1440, and the audit names all four widths it checked. The
 * prototype's ~914px floor measured as a handful of one-line issues - flex rows
 * that would not wrap and grid column minimums - not architecture, so the fix is
 * a ~640px breakpoint that stacks the Q&A table to cards and lets every
 * genuinely wide thing (diagrams, wide tables, code) keep scrolling inside its
 * own frame rather than scrolling the page.
 */
export const CSS = `
:root{
  --bg:#0e1116; --bg2:#141922; --panel:#171d27; --panel2:#1c2129;
  --line:#2a3140; --line2:#39445a;
  --ink:#e6e9ee; --ink2:#a3adbb; --ink3:#8892a2;
  --blue:#7aa2f7; --green:#7ec699; --amber:#d9a441; --red:#e46a6a; --violet:#b48ce3;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --maxw: 1120px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth; scroll-padding-top:96px}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:15.5px;line-height:1.62;-webkit-font-smoothing:antialiased;
  overflow-wrap:break-word}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:.86em;background:#0b0e13;border:1px solid var(--line);
  border-radius:4px;padding:.08em .34em;color:#cbd3df;overflow-wrap:anywhere}
pre{font-family:var(--mono);font-size:12.5px;line-height:1.55;background:#0b0e13;
  border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto;margin:12px 0}
pre code{background:none;border:none;padding:0;font-size:inherit;overflow-wrap:normal}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 28px}
.small{font-size:13px} .muted{color:var(--ink2)} .dim{color:var(--ink3)}
[data-ev],[data-chrome]{display:inline}

/* ---------- header ---------- */
.hero{border-bottom:1px solid var(--line);background:
  radial-gradient(900px 320px at 12% -10%, rgba(122,162,247,.13), transparent 62%), var(--bg2)}
.hero-inner{max-width:var(--maxw);margin:0 auto;padding:46px 28px 30px}
.hero h1{margin:0;font-size:38px;letter-spacing:-.02em;overflow-wrap:anywhere}
.hero .sub{margin:10px 0 0;max-width:78ch;color:var(--ink2);font-size:16px}
.pin{margin-top:20px;display:flex;flex-wrap:wrap;gap:8px 26px;padding:12px 16px;
  background:#11151d;border:1px solid var(--line);border-left:3px solid var(--amber);
  border-radius:8px;font-size:13px}
.pin span{min-width:0}
.pin b{color:var(--ink);font-weight:600;margin-right:6px}
.sha{font-family:var(--mono);color:var(--amber);font-size:12px;overflow-wrap:anywhere}

/* ---------- nav ---------- */
.toc{position:sticky;top:0;z-index:20;background:rgba(14,17,22,.93);
  backdrop-filter:blur(9px);border-bottom:1px solid var(--line)}
.toc-inner{max-width:var(--maxw);margin:0 auto;padding:9px 28px;display:flex;
  align-items:center;gap:10px;flex-wrap:wrap}
.toc ul{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:4px 6px;min-width:0}
.toc a{display:block;padding:5px 10px;border-radius:6px;font-size:13px;color:var(--ink2)}
.toc a:hover{background:var(--panel);color:var(--ink);text-decoration:none}
.toc a.on{background:#1d2635;color:var(--blue)}
.audit-badge{margin-left:auto;flex:none}
.audit-badge a{font-family:var(--mono);font-size:11.5px;padding:4px 10px;border-radius:999px;
  border:1px solid var(--line2);color:var(--ink2);white-space:nowrap}
.audit-badge a.st-failed{color:var(--red);border-color:#5c2f30;background:#1c1113}
.audit-badge a.st-passed{color:var(--green);border-color:#2d5a44;background:#0f1c17}
.audit-badge a.st-warn{color:var(--amber);border-color:#5a4a2a;background:#1b160c}
.audit-badge a.st-not-run{color:var(--amber);border-color:#5a4a2a;background:#1b160c}

/* ---------- sections ---------- */
section{padding:44px 0 12px;border-top:1px solid var(--line)}
section:first-of-type{border-top:none}
h2{font-size:25px;margin:0 0 6px;letter-spacing:-.01em;display:flex;align-items:baseline;gap:12px}
h2 .n{font-family:var(--mono);font-size:13px;color:var(--ink3);font-weight:400}
h3{font-size:19px;margin:32px 0 8px}
h4{font-size:15px;margin:26px 0 8px;color:var(--ink);letter-spacing:.01em}
h5{font-size:13.5px;margin:0 0 6px;color:var(--ink)}
.lede{color:var(--ink2);max-width:84ch;margin:2px 0 18px}
p{max-width:88ch}

/* ---------- panels ---------- */
.callout{background:#111722;border:1px solid var(--line);border-left:3px solid var(--blue);
  border-radius:8px;padding:12px 16px;margin:16px 0}
.callout.warn{border-left-color:var(--amber);background:#191408}
.callout.bad{border-left-color:var(--red);background:#1c1113}
.callout p{margin:0;max-width:96ch}
.absence{background:#191408;border:1px solid var(--line);border-left:3px solid var(--amber);
  border-radius:8px;padding:12px 16px;margin:16px 0}
.absence p{margin:0;max-width:96ch}
.grid{display:grid;gap:12px}
.g2{grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px 16px;min-width:0}
.card p{margin:0;max-width:92ch}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px 16px;min-width:0}
.stat .num{font-family:var(--mono);font-size:25px;color:var(--blue);line-height:1.15;overflow-wrap:anywhere}
.stat .num.bad{color:var(--red)}
.stat .lab{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink2);margin-top:4px}

/* ---------- tables ---------- */
.tbl{overflow-x:auto;border:1px solid var(--line);border-radius:9px;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:560px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#11151d;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink2);font-weight:600}
tr:last-child td{border-bottom:none}
td.where{font-size:12.5px}

/* ---------- pills ---------- */
.pill{display:inline-block;font-size:10.5px;letter-spacing:.055em;text-transform:uppercase;
  padding:2px 8px;border-radius:999px;border:1px solid var(--line2);color:var(--ink2);
  white-space:nowrap;font-weight:600;vertical-align:middle}
.pill.ok{color:var(--green);border-color:#2d5a44;background:#0f1c17}
.pill.no{color:var(--amber);border-color:#5a4a2a;background:#1b160c}
.pill.risk{color:var(--red);border-color:#5c2f30;background:#1c1113}
.pill.div{color:var(--violet);border-color:#4a3a63;background:#171227}
.pill.info{color:var(--blue);border-color:#2f4570;background:#101725}
.pill.gap{color:var(--ink2)}

/* ---------- decisions ---------- */
.dec{background:var(--panel);border:1px solid var(--line);border-radius:9px;margin:10px 0}
.dec[open]{border-color:var(--line2);background:var(--panel2)}
.dec>summary{cursor:pointer;list-style:none;padding:13px 16px;display:flex;
  gap:12px;align-items:baseline;flex-wrap:nowrap}
.dec>summary .pill{flex:none;align-self:center}
.dec>summary::-webkit-details-marker{display:none}
.dec>summary::before{content:"\\25B8";color:var(--ink3);font-size:11px;line-height:1.6}
.dec[open]>summary::before{content:"\\25BE"}
/* The summary row is a nowrap strip by design, so every item in it must be able
   to shrink or the row sets a floor on the whole page's width. The measured
   ~914px floor of the #7 prototype was exactly this: a non-shrinking title and
   non-shrinking pills in a nowrap flex row. Shrink factors plus min-width:0 keep
   the desktop appearance (nothing shrinks while there is room) and remove the
   floor. Note this whole stylesheet is a template literal - no backticks. */
.dec .ttl{font-weight:600;white-space:nowrap;flex:0 1 auto;min-width:0;
  overflow:hidden;text-overflow:ellipsis}
.dec .one{color:var(--ink2);font-size:13.5px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;min-width:0;flex:1 1 auto}
.dec .id{font-family:var(--mono);font-size:12px;color:var(--ink3);flex:none}
.dec-body{padding:2px 18px 18px 34px;border-top:1px solid var(--line)}
dl{margin:14px 0 0;display:grid;grid-template-columns:120px 1fr;gap:8px 18px}
dt{font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);padding-top:3px}
dd{margin:0;min-width:0}
dd ul{margin:0;padding-left:18px}
dd li{margin-bottom:5px}
.say{margin:16px 0 0;max-width:96ch;padding:11px 15px;border-left:3px solid var(--green);background:#0f1a15;
  border-radius:0 7px 7px 0;font-style:italic;color:#cfe6d8}
.say b{font-style:normal;color:var(--green);font-size:11px;letter-spacing:.07em;
  text-transform:uppercase;display:block;margin-bottom:4px}
.absent-note{color:var(--ink2);font-size:13px;border-left:3px solid var(--line2);
  padding:8px 14px;background:#12151c;border-radius:0 7px 7px 0;margin-top:12px}

/* ---------- ranked deep dives ---------- */
.dive{border:1px solid var(--line);border-radius:11px;padding:20px 22px;margin:16px 0;background:var(--panel)}
.dive-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.badge{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--bg);
  background:var(--blue);border-radius:6px;padding:2px 9px}
.dive-head h3{margin:0;font-size:19px;min-width:0}
.score{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-left:auto}
.gotchas{margin-top:14px}
.gotchas>summary{cursor:pointer;font-size:13px;color:var(--blue);padding:4px 0}
.gotchas ul{margin:6px 0 0;padding-left:20px;color:var(--ink2);font-size:14px}
.gotchas li{margin-bottom:7px}

/* ---------- evidence ---------- */
.ev{margin-top:14px;border-top:1px dashed var(--line);padding-top:8px}
.ev>summary{cursor:pointer;font-size:12px;letter-spacing:.05em;text-transform:uppercase;
  color:var(--ink3);padding:3px 0}
.ev>summary:hover{color:var(--blue)}
.ev ul{list-style:none;margin:8px 0 0;padding:0}
.ev li{margin:0 0 6px;font-size:13px;display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.ev .k{font-family:var(--mono);font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;
  border:1px solid var(--line2);border-radius:4px;padding:1px 5px;color:var(--ink2);flex:none}
.ev .k.file{color:var(--blue);border-color:#2f4570}
.ev .k.issue{color:var(--violet);border-color:#4a3a63}
.ev .k.command{color:var(--green);border-color:#2d5a44}
.ev a{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere;min-width:0}
.ev .n{color:var(--ink2);font-size:12.5px;min-width:0}
.ev pre{margin:5px 0 0;font-size:11.5px;width:100%}

/* ---------- diagrams ---------- */
figure{margin:18px 0}
.diagram-frame{border:1px solid var(--line);border-radius:11px;background:#10141b;
  padding:18px;overflow-x:auto}
/* Natural size, never stretched: rescaling the SVG would rescale the text
   Graphviz measured, which is how a layout-engine diagram reacquires the
   overflow bugs hand-authored SVG has. Wide diagrams scroll in their frame. */
svg.atlas-diagram{display:block;height:auto;margin:0 auto}
figcaption{color:var(--ink2);font-size:13.5px;margin-top:10px;max-width:92ch}
.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--ink2);margin-top:10px}
.legend i{display:inline-block;width:18px;height:2px;vertical-align:middle;margin-right:6px}

/* ---------- record ---------- */
.ledger{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
.ledger .cell{background:var(--panel);border:1px solid var(--line);border-radius:9px;
  padding:11px 15px;min-width:150px;flex:1 1 150px}
.ledger .cell .num{font-family:var(--mono);font-size:21px}
.ledger .cell .lab{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2)}
.v-verified{color:var(--green)} .v-attested{color:var(--violet)} .v-cut{color:var(--ink2)}

/* ---------- the audit slot ---------- */
/* The audit stage is the only writer of these. Their own styling is fixed so a
   state change cannot silently change the page's shape around them. */
#audit-statement{margin-top:20px;border:1px solid var(--line);border-left:3px solid var(--line2);
  border-radius:8px;padding:14px 16px;background:#111722}
#audit-statement.st-not-run,#audit-statement.st-warn{border-left-color:var(--amber);background:#191408}
#audit-statement.st-passed{border-left-color:var(--green);background:#0f1a15}
#audit-statement.st-failed{border-left-color:var(--red);background:#1c1113}
#audit-statement p{margin:0 0 8px;max-width:96ch}
#audit-statement p:last-child{margin-bottom:0}
#audit-statement ul{margin:6px 0 10px;padding-left:20px;color:var(--ink2)}
#audit-statement .hash{font-family:var(--mono);font-size:11.5px;color:var(--ink2);overflow-wrap:anywhere}

footer{border-top:1px solid var(--line);margin-top:52px;padding:26px 0 60px;color:var(--ink2);font-size:13px}
.tight{margin:8px 0;padding-left:20px}
.tight li{margin-bottom:8px}
button.expand{background:var(--panel);color:var(--ink2);border:1px solid var(--line2);
  border-radius:7px;padding:6px 13px;font-size:12.5px;cursor:pointer;font-family:inherit}
button.expand:hover{color:var(--ink);border-color:var(--blue)}
:target{scroll-margin-top:96px}
:target > .dive-head h3, .dec:target{outline:2px solid rgba(122,162,247,.45);outline-offset:5px;border-radius:8px}

/* ---------- the ~640px pass (#8 point 11) ---------- */
/* Everything genuinely wide keeps its own scroller; what changes is the page
   chrome, which stops insisting on a minimum width it does not need. */
@media (max-width: 640px){
  body{font-size:15px}
  .wrap{padding:0 16px}
  .hero-inner{padding:30px 16px 22px}
  .hero h1{font-size:28px}
  .toc-inner{padding:8px 16px}
  .toc a{padding:4px 8px;font-size:12.5px}
  .audit-badge{margin-left:0}
  h2{font-size:21px;flex-wrap:wrap}
  h3{font-size:17px}
  section{padding:30px 0 10px}
  .dec>summary{flex-wrap:wrap;gap:8px}
  .dec .ttl{white-space:normal;overflow:visible;text-overflow:clip;flex:1 1 100%}
  /* The one-line clamp is a desktop affordance. On a phone the summary wraps
     rather than truncating, because there is no hover to reveal the rest. */
  .dec .one{white-space:normal;overflow:visible;text-overflow:clip;flex-basis:100%}
  .dec-body{padding:2px 14px 16px 14px}
  dl{grid-template-columns:1fr;gap:2px 0}
  dt{padding-top:10px}
  .dive{padding:16px 14px}
  .score{margin-left:0}
  .ledger .cell{min-width:0;flex:1 1 calc(50% - 10px)}

  /* The Q&A table stacks to cards: a three-column index is unreadable at 390px,
     and it is the section a reader reaches for first (#7 moved it to 02 because
     it is an index). Header cells are hidden and re-stated per row. */
  .qa-table{border:none;overflow:visible}
  .qa-table table{min-width:0;display:block}
  .qa-table thead{display:none}
  .qa-table tbody,.qa-table tr,.qa-table td{display:block;width:auto}
  .qa-table tr{background:var(--panel);border:1px solid var(--line);border-radius:9px;
    padding:12px 14px;margin-bottom:10px}
  .qa-table td{border:none;padding:0}
  .qa-table td+td{margin-top:8px}
  .qa-table td[data-label]::before{content:attr(data-label);display:block;
    font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink2);margin-bottom:3px}
}

@media print{.toc{display:none} details{display:block} details>*{display:block}}
`;
