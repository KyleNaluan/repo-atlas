/**
 * The nine sections.
 *
 * Order, and why (#7):
 *   01 What this is          product sentence + Facts + the verification strip
 *   02 Questions an interviewer will ask   GENERATED from the graph, at the FRONT
 *   03 The real shape        annotated tree + Boundary nodes
 *   04 One submission        Flow nodes, laid out by Graphviz
 *   05 The decision trail    Decision nodes, collapsed one-liners
 *   06 Deep dives            Mechanism nodes, ranked, open
 *   07 Honest edges          Edge nodes, grouped by kind
 *   08 The record            provenance, density, degradation, deletions, audit slot
 *   09 Source index          GENERATED from every evidence entry
 *
 * The Q&A table is at 02 because its stated use is "the interviewer just asked X,
 * find the answer", which makes it an index rather than a summary, and an index
 * belongs at the front.
 *
 * Two rules run through every function here:
 *
 * - A section with no surviving nodes renders an explicit absence panel in its
 *   own slot. Silence is never how absence is communicated (#6), and rendering
 *   in place keeps section numbering stable across subjects.
 * - No section decides what survives. Budgets and deletion belong to the rank
 *   stage (#7, #9); these functions render everything they are handed and read
 *   the deletion record only to report the cut.
 */
import {
  chrome,
  from,
  html,
  join,
  prose,
  proseFragment,
  provAttr,
  raw,
  type Provenance,
  type Safe,
} from "./html.js";
import { commitUrl, renderEvidence, treeUrl } from "./links.js";
import { renderFlow, type DiagramCache } from "./diagram.js";
import { highlight } from "./highlight.js";
import { badge, statement } from "../artifact/statement.js";
import {
  allExtraEvidence,
  anchorOf,
  confidenceTally,
  deletionsFor,
  qaIndex,
  ranked,
  sourceIndex,
  taggedExtraEvidence,
  totalEvidence,
} from "./projections.js";
import {
  isType,
  type Atlas,
  type AtlasNode,
  type CommandEvidence,
  type DecisionNode,
  type EdgeNode,
  type Evidence,
  type MechanismNode,
} from "../schema/types.js";

/* ------------------------------------------------------------------ atoms */

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const evidenceList = (
  items: Evidence[],
  atlas: Atlas,
  owner: string,
  field: string,
  label = "Evidence",
): Safe => {
  if (items.length === 0) return html``;
  return html`<details class="ev">
    <summary>${chrome`${label} (${items.length})`}</summary>
    <ul>
      ${join(
        items.map((e, i) => {
          const r = renderEvidence(e, atlas.subject);
          return html`<li>
            <span class="k ${r.kind}">${r.kind}</span>
            ${r.href
              ? html`<a href="${r.href}" data-ev="${provAttr(from(owner, `${field}[${i}]`))}"
                  >${r.label}</a
                >`
              : html`<code data-ev="${provAttr(from(owner, `${field}[${i}]`))}">${r.label}</code>`}
            ${r.note
              ? html`<span class="n">- ${prose(r.note, from(owner, `${field}[${i}].note`))}</span>`
              : ""}
            ${r.output
              ? html`<pre><code>${prose(r.output, from(owner, `${field}[${i}].output_excerpt`))}</code></pre>`
              : ""}
          </li>`;
        }),
      )}
    </ul>
  </details>`;
};

/**
 * The two absence phrasings, and the distinction is not cosmetic (#7 point 2).
 *
 * Only the decision section may be "absent from the record", because it is the
 * only section making a claim ABOUT a record. Every other empty section says
 * "nothing surfaced": the probes ran and found nothing they could evidence,
 * which is not a report of a missing archive. Using the former for a mechanism
 * section would smuggle in a claim that a record exists and was missed.
 *
 * These strings are golden-file pinned in render CI (#8 point 10) so the
 * phrasing cannot rot, and the audit asserts at runtime that "absent from the
 * record" appears nowhere but the decision section.
 */
export const absencePanel = (what: string, why: string, fromRecord = false): Safe => html`
  <div class="absence">
    <p>
      ${chrome`<b>${what} - ${fromRecord ? "absent from the record" : "nothing surfaced"}.</b> ${why}`}
    </p>
  </div>`;

const EDGE_KIND_PILL: Record<EdgeNode["kind"], { cls: string; text: string }> = {
  unbuilt: { cls: "no", text: "decided, not built" },
  tradeoff: { cls: "info", text: "tradeoff" },
  risk: { cls: "risk", text: "risk" },
  divergence: { cls: "div", text: "divergence" },
  coverage_gap: { cls: "gap", text: "coverage gap" },
};

const STATUS_PILL: Record<DecisionNode["status"], { cls: string; text: string }> = {
  decided: { cls: "info", text: "decided" },
  decided_and_built: { cls: "ok", text: "built" },
  decided_not_built: { cls: "no", text: "decided, not built" },
  superseded: { cls: "gap", text: "superseded" },
};

const ENFORCEMENT_LABEL: Record<MechanismNode["enforcement"], string> = {
  "type-level": "enforced in the type system",
  "query-level": "enforced in SQL",
  "test-level": "enforced by a test or a CI check",
  convention: "enforced by convention",
};

const title = (n: AtlasNode): Safe => prose(n.title, from(n.id, "title"));

/* ------------------------------------------------- 01 What this is */

export const sectionWhat = (atlas: Atlas, nodes: AtlasNode[]): Safe => {
  const factNodes = ranked(nodes.filter(isType("fact")));
  const isSuiteCommand = (e: Evidence): e is CommandEvidence =>
    e.kind === "command" && /test|mvn|npm/.test(e.cmd);
  const suiteFact = factNodes.find((f) => f.evidence.some(isSuiteCommand));
  const suiteOutput = suiteFact?.evidence.find(isSuiteCommand);
  const failing = /BUILD FAILURE|FAILED|\[ERROR\]/.test(suiteOutput?.output_excerpt ?? "");
  return html`
    <section id="what">
      <h2><span class="n">01</span>${chrome`What this is`}</h2>
      <p class="lede">${prose(atlas.synopsis.statement, from("synopsis", "statement"))}</p>
      <div class="grid g3" style="margin-bottom:18px">
        ${join(
          factNodes.map(
            (f) => html`<div class="stat" id="${f.id}">
              <div class="num ${f.id === suiteFact?.id && failing ? "bad" : ""}">
                ${prose(f.value, from(f.id, "value"))}
              </div>
              <div class="lab">${prose(f.label, from(f.id, "label"))}</div>
            </div>`,
          ),
        )}
      </div>
      ${suiteOutput && suiteFact
        ? html`<div class="callout ${failing ? "bad" : ""}">
            <p>
              ${chrome`<b>The suite, run at this commit.</b> <code>${suiteOutput.cmd}</code> was run
              against this exact commit in a clean worktree.`}
              ${suiteOutput.note
                ? html`<span class="dim"
                    >(${prose(suiteOutput.note, from(suiteFact.id, "evidence.note"))})</span
                  >`
                : ""}
              ${failing
                ? chrome`The suite does not pass at this SHA. What is reported is what was observed;
                    the diagnosis is in Honest edges.`
                : ""}
            </p>
            <pre><code>${prose(suiteOutput.output_excerpt, from(suiteFact.id, "evidence.output_excerpt"))}</code></pre>
          </div>`
        : ""}
      ${evidenceList(
        atlas.synopsis.evidence,
        atlas,
        "synopsis",
        "evidence",
        "Evidence for the product sentence",
      )}
    </section>`;
};

/* ---------------------------------- 02 Questions an interviewer will ask */

export const sectionQa = (atlas: Atlas, nodes: AtlasNode[]): Safe => {
  const rows = qaIndex(nodes);
  const cut = deletionsFor(atlas, "interviewer_questions");
  return html`
    <section id="qa">
      <h2><span class="n">02</span>${chrome`Questions an interviewer will ask`}</h2>
      <p class="lede">
        ${chrome`Generated: every question below is declared on the node that carries the evidence for
        its answer, so the "short answer" and "where it lives" columns are the node's own fields and
        its own citations. Nothing in this table is written twice.`}
      </p>
      ${rows.length === 0
        ? absencePanel(
            "Interviewer questions",
            "No surviving node declared a question, so there is nothing to index.",
          )
        : html`<div class="tbl qa-table"><table>
            <thead><tr>
              <th style="width:26%">${chrome`Question`}</th>
              <th>${chrome`Short answer`}</th>
              <th style="width:20%">${chrome`Where it lives`}</th>
            </tr></thead>
            <tbody>
              ${join(
                rows.map(
                  (r) => html`<tr>
                    <td data-label="Question"><b>${prose(r.question, r.questionProv)}</b></td>
                    <td data-label="Short answer">${prose(r.answer, r.answerProv)}</td>
                    <td class="where" data-label="Where it lives">
                      ${join(
                        r.nodes.map(
                          (n) => html`<a href="${anchorOf(n)}">${title(n)}</a>`,
                        ),
                        "<br>",
                      )}
                    </td>
                  </tr>`,
                ),
              )}
            </tbody>
          </table></div>`}
      ${cut.length > 0
        ? html`<p class="small dim">
            ${chrome`${cut.length} further ${plural(cut.length, "question", "questions")} scored below
            this profile's budget and ${plural(cut.length, "was", "were")} cut by the rank stage. Each
            cut is recorded with its score in <code>atlas.json</code>; see
            <a href="#record">The record</a>.`}
          </p>`
        : ""}
    </section>`;
};

/* ------------------------------------------------ 03 The real shape */

export const sectionShape = (atlas: Atlas, nodes: AtlasNode[]): Safe => {
  const boundaries = ranked(nodes.filter(isType("boundary")));
  return html`
    <section id="shape">
      <h2><span class="n">03</span>${chrome`The real shape`}</h2>
      <p class="lede">
        ${chrome`The annotated tree, and the boundaries inside it that carry weight.`}
      </p>
      <pre><code>${prose(atlas.shape.tree, from("shape", "tree"))}</code></pre>
      ${evidenceList(atlas.shape.evidence, atlas, "shape", "evidence", "Evidence for this tree")}
      <h4>${chrome`The boundaries that carry weight`}</h4>
      ${boundaries.length === 0
        ? absencePanel("Boundaries", "No boundary survived the confidence gate.")
        : html`<div class="grid g2">
            ${join(
              boundaries.map(
                (b) => html`<div class="card" id="${b.id}">
                  <h5>${title(b)}</h5>
                  <p class="small muted">${prose(b.enforced_by, from(b.id, "enforced_by"))}</p>
                  <p class="small dim" style="margin-top:8px">
                    ${chrome`<b>Without it:</b>`}
                    ${prose(b.what_breaks_without_it, from(b.id, "what_breaks_without_it"))}
                  </p>
                  ${evidenceList(b.evidence, atlas, b.id, "evidence")}
                </div>`,
              ),
            )}
          </div>`}
    </section>`;
};

/* -------------------------------------------- 04 One submission, end to end */

export const sectionFlows = async (
  atlas: Atlas,
  nodes: AtlasNode[],
  cache?: DiagramCache,
): Promise<Safe> => {
  const flows = ranked(nodes.filter(isType("flow")));
  const figures: Safe[] = [];
  for (const flow of flows) {
    const { svg, long } = await renderFlow(flow, cache);
    figures.push(html`
      <h3 id="${flow.id}">${title(flow)}</h3>
      <figure>
        <div class="diagram-frame" data-ev="${provAttr(from(flow.id, "steps"))}">
          ${raw(svg)}
        </div>
        <div class="legend">
          <span>${chrome`<i style="background:#7aa2f7"></i>request path`}</span>
          <span>${chrome`<i style="background:#7ec699"></i>response path`}</span>
          <span>${chrome`<i style="background:#d9a441"></i>outside the transaction`}</span>
          <span class="dim"
            >${chrome`laid out by Graphviz - no coordinate in this file was written by hand`}</span
          >
        </div>
        ${flow.caption
          ? html`<figcaption>${prose(flow.caption, from(flow.id, "caption"))}</figcaption>`
          : ""}
        ${long
          ? html`<p class="small dim">
              ${chrome`This flow has ${flow.steps.length} steps and lays out as a strip rather than a
              readable figure. Diagram quality is bounded by how the flow is modelled, not by the
              layout engine; splitting it at a natural seam is a modelling decision.`}
            </p>`
          : ""}
      </figure>
      ${evidenceList(
        [...flow.evidence, ...flow.steps.flatMap((s) => (s.evidence ? [s.evidence] : []))],
        atlas,
        flow.id,
        "evidence",
        "Every box on this diagram, cited",
      )}`);
  }
  return html`
    <section id="flow">
      <h2><span class="n">04</span>${chrome`One submission, end to end`}</h2>
      <p class="lede">
        ${chrome`The thing worth being able to narrate at a whiteboard. Every box traces to a call
        site; every arrow is an edge the layout engine routed, not a line someone drew.`}
      </p>
      ${flows.length === 0
        ? absencePanel("Traced flows", "No flow survived the confidence gate.")
        : join(figures)}
    </section>`;
};

/* -------------------------------------------- 05 The decision trail */

const decisionBlock = (d: DecisionNode, atlas: Atlas): Safe => {
  const pill = STATUS_PILL[d.status];
  // The "#N" chip is derived from the node's own first issue citation, not
  // authored - a decision with no issue in its record simply gets no chip.
  const issue = d.evidence.find((e) => e.kind === "issue");
  const firstSentence = d.decision.split(/(?<=\.)\s/)[0] ?? d.decision;
  return html`
    <details class="dec" id="${d.id}">
      <summary>
        <span class="id">${issue ? `#${issue.number}` : ""}</span>
        <span class="ttl">${title(d)}</span>
        <span class="one">- ${prose(firstSentence, from(d.id, "decision"))}</span>
        ${d.rejected.length === 0 && d.rejected_absent_from_record
          ? html`<span class="pill gap">${chrome`no alternative recorded`}</span>`
          : ""}
        <span class="pill ${pill.cls}" data-ev="${provAttr(from(d.id, "status"))}">${pill.text}</span>
      </summary>
      <div class="dec-body">
        <dl>
          <dt>${chrome`Question`}</dt>
          <dd>${prose(d.question, from(d.id, "question"))}</dd>
          <dt>${chrome`Decision`}</dt>
          <dd>${prose(d.decision, from(d.id, "decision"))}</dd>
          <dt>${chrome`Why`}</dt>
          <dd>${prose(d.why, from(d.id, "why"))}</dd>
          ${d.rejected.length > 0
            ? html`<dt>${chrome`Rejected`}</dt>
                <dd><ul>
                  ${join(
                    d.rejected.map(
                      (r, i) => html`<li>
                        <b>${prose(r.alternative, from(d.id, `rejected[${i}].alternative`))}</b> -
                        ${prose(r.why_it_lost, from(d.id, `rejected[${i}].why_it_lost`))}
                      </li>`,
                    ),
                  )}
                </ul></dd>`
            : ""}
          ${d.divergence
            ? html`<dt>${chrome`Divergence`}</dt>
                <dd>${prose(d.divergence, from(d.id, "divergence"))}</dd>`
            : ""}
        </dl>
        ${d.rejected.length === 0 && d.rejected_absent_from_record
          ? html`<p class="absent-note">
              ${chrome`<b>No alternative is recorded.</b> The record states what was decided but not
              what lost. This is reported rather than filled in: the renderer never invents an
              alternative, and a decision with no recorded alternative ranks below one that has one.`}
            </p>`
          : ""}
        <p class="say">
          ${chrome`<b>Say it like this</b>`}${prose(d.soundbite, from(d.id, "soundbite"))}
        </p>
        ${evidenceList(d.evidence, atlas, d.id, "evidence", "The record")}
        ${evidenceList(d.implemented_by, atlas, d.id, "implemented_by", "Built, and where")}
      </div>
    </details>`;
};

export const sectionDecisions = (atlas: Atlas, nodes: AtlasNode[]): Safe => {
  const decisions = ranked(nodes.filter(isType("decision")));
  const presence = atlas.record.section_presence["decisions"] ?? "present";
  return html`
    <section id="decisions">
      <h2><span class="n">05</span>${chrome`The decision trail`}</h2>
      <p class="lede">
        ${chrome`Each row is a question that was argued and closed, with the rejected alternative and
        the reason it lost. Expand one for the why, the alternatives and a line you can actually
        say.`}
      </p>
      ${presence === "absent" || decisions.length === 0
        ? absencePanel(
            "The decision trail",
            "No decision record with admissible evidence was found in this repository. Nothing here was reconstructed from commit messages: a commit message restating a ticket title is not a decision record.",
            true,
          )
        : html`
            <button class="expand" id="expand-decisions" type="button">
              ${chrome`Expand all ${decisions.length} decisions`}
            </button>
            ${join(decisions.map((d) => decisionBlock(d, atlas)))}`}
    </section>`;
};

/* ------------------------------------------------------ 06 Deep dives */

export const sectionDives = async (atlas: Atlas, nodes: AtlasNode[]): Promise<Safe> => {
  const mechanisms = ranked(nodes.filter(isType("mechanism")));
  const cut = deletionsFor(atlas, "mechanisms");
  const dives: Safe[] = [];
  for (const [i, m] of mechanisms.entries()) {
    const excerpt = m.code_excerpt
      ? await highlight(m.code_excerpt.text, m.code_excerpt.language)
      : null;
    dives.push(html`
      <div class="dive" id="${m.id}">
        <div class="dive-head">
          <span class="badge">#${i + 1}</span>
          <h3>${title(m)}</h3>
          <span class="pill info" data-ev="${provAttr(from(m.id, "enforcement"))}"
            >${ENFORCEMENT_LABEL[m.enforcement]}</span
          >
          <span class="score" data-ev="${provAttr(from(m.id, "interview_value"))}"
            >value ${m.interview_value}/5 &middot; ${m.confidence}</span
          >
        </div>
        <p>${prose(m.what, from(m.id, "what"))}</p>
        <p>${prose(m.why_interesting, from(m.id, "why_interesting"))}</p>
        ${excerpt && m.code_excerpt
          ? html`<pre><code class="lang-${m.code_excerpt.language}">${proseFragment(
              excerpt,
              from(m.id, "code_excerpt.text"),
            )}</code></pre>`
          : ""}
        ${m.gotchas.length > 0
          ? html`<details class="gotchas">
              <summary>
                ${chrome`${m.gotchas.length} sharp ${plural(m.gotchas.length, "edge", "edges")} worth knowing`}
              </summary>
              <ul>
                ${join(
                  m.gotchas.map(
                    (g, gi) => html`<li>${prose(g, from(m.id, `gotchas[${gi}]`))}</li>`,
                  ),
                )}
              </ul>
            </details>`
          : ""}
        ${evidenceList(
          [...m.evidence, ...(m.code_excerpt ? [m.code_excerpt.evidence] : [])],
          atlas,
          m.id,
          "evidence",
        )}
      </div>`);
  }
  return html`
    <section id="deep">
      <h2><span class="n">06</span>${chrome`Deep dives`}</h2>
      ${mechanisms.length > 0
        ? html`<p class="lede">
            ${chrome`${mechanisms.length} mechanisms, ranked by interview value under rubric
            <code>${atlas.rubric_version}</code> for the <code>${atlas.profile}</code> profile. The
            ranking is data in <code>atlas.json</code>, not the renderer's opinion.`}
          </p>`
        : ""}
      ${mechanisms.length === 0
        ? absencePanel(
            "Deep dives",
            "No mechanism cleared the confidence gate and the value floor. The probe library ran; it found nothing it could evidence.",
          )
        : join(dives)}
      ${cut.length > 0
        ? html`<p class="small dim">
            ${chrome`${cut.length} further ${plural(cut.length, "mechanism", "mechanisms")} scored
            above the value floor and ${plural(cut.length, "was", "were")} still cut by the rank
            stage to keep this section within its budget. Each cut is recorded with its score in
            <code>atlas.json</code>; see <a href="#record">The record</a>.`}
          </p>`
        : ""}
    </section>`;
};

/* --------------------------------------------------- 07 Honest edges */

const EDGE_GROUP_ORDER: EdgeNode["kind"][] = [
  "risk",
  "unbuilt",
  "divergence",
  "coverage_gap",
  "tradeoff",
];

const EDGE_GROUP_TITLES: Record<EdgeNode["kind"], string> = {
  risk: "What a careful reviewer would find first",
  unbuilt: "Designed and decided, but not built",
  divergence: "Where the record and the build disagree",
  coverage_gap: "Referenced but unresolved, or uncovered",
  tradeoff: "Tradeoffs taken knowingly",
};

export const sectionEdges = (atlas: Atlas, nodes: AtlasNode[]): Safe => {
  const edges = ranked(nodes.filter(isType("edge")));
  return html`
    <section id="edges">
      <h2><span class="n">07</span>${chrome`Honest edges`}</h2>
      <p class="lede">
        ${chrome`What is unfinished, what was traded away, and what an interviewer will find if they
        look. Going first on all of this is strictly better than being caught by it.`}
      </p>
      ${edges.length === 0
        ? absencePanel("Honest edges", "No edge survived the confidence gate.")
        : join(
            EDGE_GROUP_ORDER.map((kind) => {
              const group = edges.filter((e) => e.kind === kind);
              if (group.length === 0) return html``;
              return html`
                <h4>${chrome`${EDGE_GROUP_TITLES[kind]}`}</h4>
                ${join(
                  group.map(
                    (e) => html`
                      <div class="card" id="${e.id}" style="margin-bottom:12px">
                        <div class="dive-head" style="margin-bottom:6px">
                          <h5 style="font-size:15px">${title(e)}</h5>
                          <span
                            class="pill ${EDGE_KIND_PILL[e.kind].cls}"
                            data-ev="${provAttr(from(e.id, "kind"))}"
                            >${EDGE_KIND_PILL[e.kind].text}</span
                          >
                          <span class="score" data-ev="${provAttr(from(e.id, "interview_value"))}"
                            >value ${e.interview_value}/5 &middot; ${e.confidence}</span
                          >
                        </div>
                        <p class="small">${prose(e.statement, from(e.id, "statement"))}</p>
                        <p class="small muted" style="margin-top:8px">
                          ${prose(e.why_it_matters, from(e.id, "why_it_matters"))}
                        </p>
                        <p class="say">
                          ${chrome`<b>Say it like this</b>`}${prose(
                            e.how_to_say_it,
                            from(e.id, "how_to_say_it"),
                          )}
                        </p>
                        ${evidenceList(e.evidence, atlas, e.id, "evidence")}
                      </div>`,
                  ),
                )}`;
            }),
          )}
    </section>`;
};

/* ---------------------------------------------------- 08 The record */

const recordProv = (field: string): Provenance => from("record", field);

export const sectionRecord = (atlas: Atlas, surviving: AtlasNode[]): Safe => {
  const tally = confidenceTally(surviving);
  const r = atlas.record;
  const floor = r.budgets["interview_value_floor"];
  // A trimmed question is a deletion, but not a deleted node. Count the two apart
  // so the record does not report a trimmed question as a node the rank stage cut.
  const nodeCuts = r.deletions.filter((d) => d.unit !== "question");
  const questionCuts = r.deletions.filter((d) => d.unit === "question");
  return html`
    <section id="record">
      <h2><span class="n">08</span>${chrome`The record`}</h2>
      <p class="lede">
        ${chrome`What existed to read, what was admitted as evidence, and what was cut. This section
        is on every artifact, not only degraded ones - a conditional provenance section would leak a
        tier distinction this design does not have.`}
      </p>

      <div class="ledger">
        <div class="cell">
          <div class="num v-verified">${tally["verified"] ?? 0}</div>
          <div class="lab">${chrome`verified nodes`}</div>
        </div>
        <div class="cell">
          <div class="num v-attested">${tally["attested"] ?? 0}</div>
          <div class="lab">${chrome`attested nodes`}</div>
        </div>
        <div class="cell">
          <div class="num v-cut">${r.absent_cuts.length}</div>
          <div class="lab">${chrome`cut: no evidence`}</div>
        </div>
        <div class="cell">
          <div class="num v-cut">${nodeCuts.length}</div>
          <div class="lab">${chrome`cut: rank / budget`}</div>
        </div>
        <div class="cell">
          <div class="num">${totalEvidence(surviving, allExtraEvidence(atlas))}</div>
          <div class="lab">${chrome`evidence entries`}</div>
        </div>
      </div>

      <h4>${chrome`What each section promised, and on what basis`}</h4>
      <div class="tbl"><table>
        <thead><tr><th>${chrome`Section`}</th><th>${chrome`Presence`}</th></tr></thead>
        <tbody>
          ${join(
            Object.entries(r.section_presence).map(
              ([k, v]) => html`<tr>
                <td><code>${k}</code></td>
                <td>
                  <span class="pill ${v === "present" ? "ok" : v === "partial" ? "no" : "risk"}"
                    >${v}</span
                  >
                </td>
              </tr>`,
            ),
          )}
        </tbody>
      </table></div>

      <h4>${chrome`Decision-record density, measured`}</h4>
      <p class="small muted">
        ${chrome`Four signals, recorded separately. There is deliberately no scalar score and no
        threshold: extraction decides what the artifact promises, and a density number that could
        contradict it in either direction would be a second authority.`}
      </p>
      <div class="tbl"><table>
        <thead><tr>
          <th style="width:36%">${chrome`Signal`}</th>
          <th style="width:14%">${chrome`Value`}</th>
          <th>${chrome`Note`}</th>
        </tr></thead>
        <tbody>
          ${join(
            Object.entries(r.density_signals).map(
              ([key, s]) => html`<tr>
                <td><code>${key}</code></td>
                <td>
                  <b>${typeof s.value === "boolean" ? (s.value ? "yes" : "no") : s.value}</b>${s.of
                    ? html` <span class="dim">${chrome`of ${s.of}`}</span>`
                    : ""}
                </td>
                <td class="muted small">
                  ${s.note ? prose(s.note, recordProv(`density_signals.${key}.note`)) : ""}
                </td>
              </tr>`,
            ),
          )}
        </tbody>
      </table></div>

      <h4>${chrome`Sources, and what each was admitted as`}</h4>
      <div class="tbl"><table>
        <thead><tr>
          <th>${chrome`Source`}</th>
          <th>${chrome`What existed`}</th>
          <th>${chrome`How it was fetched`}</th>
          <th>${chrome`Admissible as`}</th>
        </tr></thead>
        <tbody>
          ${join(
            r.sources.map(
              (s, i) => html`<tr>
                <td><b>${prose(s.source, recordProv(`sources[${i}].source`))}</b></td>
                <td class="small">${prose(s.what_existed, recordProv(`sources[${i}].what_existed`))}</td>
                <td class="small muted">${prose(s.fetched, recordProv(`sources[${i}].fetched`))}</td>
                <td class="small">${prose(s.admissible_as, recordProv(`sources[${i}].admissible_as`))}</td>
              </tr>`,
            ),
          )}
        </tbody>
      </table></div>

      <h4>${chrome`What was cut for want of evidence`}</h4>
      ${r.absent_cuts.length === 0
        ? html`<p class="small muted">${chrome`Nothing was cut for absent evidence.`}</p>`
        : html`
            <p class="small muted">
              ${chrome`${r.absent_cuts.length} candidate
              ${plural(r.absent_cuts.length, "claim", "claims")} had no admissible evidence at this
              SHA and ${plural(r.absent_cuts.length, "was", "were")} cut outright rather than hedged.
              <b>The content is deliberately not reproduced here</b> - restating a claim in order to
              say it is unsupported is the hedge this design refuses. What is reported is the count
              and the reason the evidence failed; the ids are in <code>atlas.json</code>.`}
            </p>
            <div class="tbl"><table>
              <thead><tr>
                <th style="width:18%">${chrome`Candidate`}</th>
                <th style="width:12%">${chrome`Type`}</th>
                <th>${chrome`Why the evidence failed`}</th>
              </tr></thead>
              <tbody>
                ${join(
                  r.absent_cuts.map(
                    (c, i) => html`<tr>
                      <td><code>${c.id}</code></td>
                      <td class="small">${c.candidate_type}</td>
                      <td class="small muted">
                        ${prose(c.reason, recordProv(`absent_cuts[${i}].reason`))}
                      </td>
                    </tr>`,
                  ),
                )}
              </tbody>
            </table></div>`}

      <h4>${chrome`What was cut for want of value`}</h4>
      <p class="small muted">
        ${chrome`${nodeCuts.length} ${plural(nodeCuts.length, "node", "nodes")} scored and
        deleted by the rank stage${floor === undefined ? "" : `: a hard floor at interview_value ${floor}, plus per-section budgets`}${questionCuts.length === 0 ? "" : `, and ${questionCuts.length} ${plural(questionCuts.length, "interviewer question", "interviewer questions")} trimmed from surviving nodes to fit the same budgets`}.
        Every deletion is recorded in <code>atlas.json</code> with its id, score and reason, so the
        ruthlessness is auditable and the renderer cannot quietly resurrect a deleted node.`}
      </p>
      <details class="ev" style="border-top:none">
        <summary>${chrome`The deletion record (${r.deletions.length})`}</summary>
        <div class="tbl"><table>
          <thead><tr>
            <th>${chrome`Cut`}</th><th>${chrome`Unit`}</th><th>${chrome`Score`}</th><th>${chrome`Reason`}</th>
          </tr></thead>
          <tbody>
            ${join(
              r.deletions.map(
                (d, i) => html`<tr>
                  <td><code>${d.id}</code></td>
                  <td class="small">${d.unit ?? "node"}</td>
                  <td>${d.score}</td>
                  <td class="small muted">${prose(d.reason, recordProv(`deletions[${i}].reason`))}</td>
                </tr>`,
              ),
            )}
          </tbody>
        </table></div>
      </details>

      <h4>${chrome`Audit`}</h4>
      <div id="audit-statement" data-atlas-audit="statement">
        ${statement({ status: "not_run", checks: [], contentHash: "", auditedAt: "", subjectSha: atlas.subject.sha })}
      </div>
    </section>`;
};

/* ----------------------------------------------- 09 Source index */

export const sectionSourceIndex = (atlas: Atlas, surviving: AtlasNode[]): Safe => {
  const grouped = sourceIndex(surviving, taggedExtraEvidence(atlas), atlas.subject);
  const titles: Record<Evidence["kind"], string> = {
    file: "Files, pinned at this SHA",
    issue: "Issues and resolution comments",
    command: "Commands run against this commit",
  };
  const order: Evidence["kind"][] = ["issue", "file", "command"];
  return html`
    <section id="index">
      <h2><span class="n">09</span>${chrome`Source index`}</h2>
      <p class="lede">
        ${chrome`Generated by folding every evidence entry on every surviving node, deduplicated and
        ordered by how many claims lean on it - so this is a reading order, not an alphabetical
        dump.`}
      </p>
      ${join(
        order.map((kind) => {
          const list = grouped.get(kind) ?? [];
          if (list.length === 0) return html``;
          return html`
            <h4>${chrome`${titles[kind]} (${list.length})`}</h4>
            <div class="tbl"><table>
              <thead><tr>
                <th style="width:38%">${chrome`Source`}</th>
                <th style="width:8%">${chrome`Cited`}</th>
                <th>${chrome`By`}</th>
              </tr></thead>
              <tbody>
                ${join(
                  list.map(
                    (s) => html`<tr>
                      <td>
                        ${s.href
                          ? html`<a href="${s.href}" data-ev="${provAttr(from(s.owner, "evidence"))}"
                              >${s.label}</a
                            >`
                          : html`<code data-ev="${provAttr(from(s.owner, "evidence"))}"
                              >${s.label}</code
                            >`}
                      </td>
                      <td>${s.citedBy.length || "-"}</td>
                      <td class="small muted">
                        ${join(
                          s.citedBy.map((n) => html`<a href="${anchorOf(n)}">${title(n)}</a>`),
                          " &middot; ",
                        )}
                      </td>
                    </tr>`,
                  ),
                )}
              </tbody>
            </table></div>`;
        }),
      )}
    </section>`;
};

/* ---------------------------------------------------- page furniture */

export const heroBlock = (atlas: Atlas): Safe => html`
  <header class="hero">
    <div class="hero-inner">
      <h1>${atlas.subject.repo}</h1>
      <p class="sub">
        ${chrome`A codebase overview generated for one purpose: so the person who built it can talk
        about it fluently in an interview. Ranked by what is worth saying out loud, not by file
        order.`}
      </p>
      <div class="pin">
        <span>${chrome`<b>Pinned commit</b>`}
          <a class="sha" href="${commitUrl(atlas.subject)}">${atlas.subject.sha}</a></span>
        <span>${chrome`<b>Branch</b>`} ${atlas.subject.branch}</span>
        <span>${chrome`<b>Read on</b>`} ${atlas.subject.read_on}</span>
        <span>${chrome`<b>Repo</b>`}
          <a href="${treeUrl(atlas.subject)}"
            >${atlas.subject.owner}/${atlas.subject.repo}</a
          >
          (${atlas.subject.visibility})</span>
        <span
          >${chrome`<b>Profile</b> ${atlas.profile} &middot; rubric ${atlas.rubric_version}`}</span
        >
      </div>
      <p class="small muted" style="margin-top:14px;max-width:82ch">
        ${chrome`Every source link is pinned to that commit, so it stays valid as the branch moves.
        Generated from <code>atlas.json</code> (schema ${atlas.schema_version}) - the JSON is the
        contract, this page is one view of it.`}
      </p>
    </div>
  </header>`;

export const NAV: readonly (readonly [string, string])[] = [
  ["what", "What this is"],
  ["qa", "Interviewer questions"],
  ["shape", "The real shape"],
  ["flow", "One submission"],
  ["decisions", "Decision trail"],
  ["deep", "Deep dives"],
  ["edges", "Honest edges"],
  ["record", "The record"],
  ["index", "Source index"],
] as const;

export const navBlock = (atlas: Atlas): Safe => html`
  <nav class="toc">
    <div class="toc-inner">
      <ul>
        ${join(NAV.map(([id, label]) => html`<li><a href="#${id}">${chrome`${label}`}</a></li>`))}
      </ul>
      <span class="audit-badge" data-atlas-audit="badge"
        >${badge(atlas.record.audit.status)}</span
      >
    </div>
  </nav>`;

/**
 * The footer states no audit conclusion.
 *
 * The #7 prototype's footer asserted "every claim above traces to evidence" and
 * "no private problem content appears anywhere" unconditionally, while its own
 * record section said the audit never ran. Those are checks E1, E2, P1 and L1 of
 * #8's register, asserted as fact by the stage least able to establish them.
 * #8 ruling 1 is that no sentence in the artifact may state an audit conclusion
 * except inside the audit slot, so they are gone rather than made conditional -
 * a conditional assertion is still the renderer deciding what the audit found.
 */
export const footerBlock = (atlas: Atlas): Safe => html`
  <footer>
    <p>
      ${chrome`Generated ${atlas.generated_at} from <code>atlas.json</code> at
      <code class="sha">${atlas.subject.sha.slice(0, 7)}</code>.`}
    </p>
    <p>
      ${chrome`What this document was and was not checked for is stated in
      <a href="#audit-statement">the audit box</a>, which is the only place on this page that says
      so.`}
    </p>
  </footer>`;
