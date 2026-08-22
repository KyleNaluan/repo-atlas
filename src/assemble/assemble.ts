/**
 * assemble - harvest + gate + rank become one atlas.json (#3, #6).
 *
 * The stage that was missing between rank and render. Rank emits survivors and a
 * deletion record; the contract needs the subject, the prose metadata, and the
 * whole `record` block that #6 requires EVERY artifact to carry - not only
 * degraded ones, because "verified, not asserted" earns trust exactly as much on
 * a rich subject, and reporting provenance only when it is thin leaks the tier
 * distinction #6 rejected.
 *
 * Nothing here judges. Every field is a restatement of what an earlier stage
 * established: the sources are harvest's, the density signals are harvest's
 * measurements, presence is counted off the nodes that survived the gate, and
 * the deletion record is rank's verbatim. This stage is where those become one
 * document, and it is deliberately the only stage that may not add a claim.
 *
 * The prose metadata is REQUIRED input rather than defaulted. A synopsis nobody
 * wrote would render as an empty statement, and #6's rule is that silence is
 * never how absence is communicated - an artifact whose product sentence is a
 * blank line asserts nothing and admits nothing. Missing prose is a failure of
 * this stage, and the write stage is what supplies it.
 */
import { SCHEMA_VERSION } from "../schema/types.js";
import type {
  AbsentCut,
  Atlas,
  AtlasNode,
  ConfidenceLedger,
  DensitySignal,
  SectionPresence,
  Shape,
  Synopsis,
} from "../schema/types.js";
import type { Harvest } from "../harvest/types.js";
import type { GatedCandidate } from "../gate/gate.js";
import type { RankResult } from "../rank/rank.js";

export class AssembleError extends Error {}

export interface AssembleInput {
  harvest: Harvest;
  /** Every candidate the gate saw, including the ones it did not confirm. */
  gated: GatedCandidate[];
  ranked: RankResult;
  /** The write stage's product sentence and annotated tree, with their evidence. */
  synopsis: Synopsis;
  shape: Shape;
  /**
   * Injected rather than read from the clock, so the same inputs assemble to the
   * same bytes and a fixture cannot drift by being re-run.
   */
  generatedAt: string;
}

/**
 * The sections The record reports on, in render order.
 *
 * Fixed rather than derived from the nodes present: a section that reports
 * nothing because no node reached it must still appear, saying so. Deriving the
 * list from what survived would make an absent section vanish from the table
 * that exists to name it.
 */
const SECTIONS = [
  "synopsis",
  "facts",
  "shape",
  "flows",
  "decisions",
  "mechanisms",
  "edges",
] as const;

/** Which node type populates a section, for the sections a node type populates. */
const SECTION_TYPE: Partial<Record<(typeof SECTIONS)[number], AtlasNode["type"]>> = {
  facts: "fact",
  flows: "flow",
  decisions: "decision",
  mechanisms: "mechanism",
  edges: "edge",
};

/**
 * Presence, per #6 point 2.
 *
 * Every section is present iff its nodes survived, with ONE exception the
 * resolution names explicitly: the decision section alone carries a `partial`
 * state, because it is the only section making a claim about a record rather
 * than about the tree. Partial is the honest reading of "the record yielded
 * decisions, and it also yielded decision-shaped candidates whose evidence did
 * not hold" - the trail exists and is incomplete, which is a different statement
 * from either "here it is" or "there is none".
 *
 * A boundary node has no section of its own; boundaries render inside the shape
 * section, so they are counted there rather than being silently uncounted.
 */
const presenceOf = (
  section: (typeof SECTIONS)[number],
  nodes: AtlasNode[],
  absentCuts: AbsentCut[],
): SectionPresence => {
  if (section === "synopsis" || section === "shape") return "present";

  const type = SECTION_TYPE[section]!;
  const survived = nodes.filter((n) => n.type === type).length;
  if (section !== "decisions") return survived > 0 ? "present" : "absent";

  if (survived === 0) return "absent";
  const cutDecisions = absentCuts.filter((c) => c.candidate_type === "decision").length;
  return cutDecisions > 0 ? "partial" : "present";
};

/**
 * An absent cut is a candidate whose node carries `absent` confidence: no
 * admissible evidence at this SHA, so it is cut outright, never hedged (#3's
 * cut-not-hedged meaning).
 *
 * The discriminator is confidence, never the gate's verdict. The gate ships
 * every candidate it sees - confirmed as-is, unresolved demoted to `attested`,
 * overturned replaced by a `divergence` edge (#7) - so a verdict is not a
 * survival signal and reading it as one would report a shipped node as cut. An
 * unresolved candidate that clears the floor ships and counts as attested; it is
 * not an absent cut.
 *
 * Most probes cannot populate this list: they emit `verified` and `attested`
 * candidates and the gate never manufactures `absent` from them. It is populated
 * by a source that produces record-shaped candidates whose evidence did not hold,
 * and by the Flow producer, whose failure mode IS an absent candidate - a chain
 * it could not establish end to end is cut with its reason rather than drawn
 * shorter (#35).
 *
 * The record reports the count, the type and why the evidence failed, and
 * deliberately withholds the claim text (#7's `absent-cut-disclosure` ruling) -
 * printing the claim would reintroduce, in the provenance section, exactly the
 * unevidenced assertion the cut removed from the body.
 */
export const absentCutsOf = (gated: GatedCandidate[]): AbsentCut[] =>
  gated
    .filter((g) => g.node.confidence === "absent")
    .map((g) => ({
      id: g.node.id,
      candidate_type: g.node.type,
      reason: g.finding,
      note: `no admissible evidence at this SHA (${g.probe_id})`,
    }));

/**
 * The ledger counts what SHIPPED plus what was cut for want of evidence.
 *
 * Rank's deletions are deliberately not counted here: a node cut to fit a
 * section budget was evidenced, and folding it into an evidence ledger would
 * report the artifact as less verified than it is. The two records answer
 * different questions and #9 keeps them separate for that reason.
 */
const ledgerOf = (nodes: AtlasNode[], absentCuts: AbsentCut[]): ConfidenceLedger => ({
  verified: nodes.filter((n) => n.confidence === "verified").length,
  attested: nodes.filter((n) => n.confidence === "attested").length,
  absent_cut: absentCuts.length,
});

/** Harvest's four measurements, in the record's shape. They are copied, not recomputed. */
const densityOf = (harvest: Harvest): Record<string, DensitySignal> => {
  const d = harvest.density;
  return {
    closed_issues_with_resolution_comment: {
      value: d.closed_issues_with_resolution_comment.value,
      of: d.closed_issues_with_resolution_comment.of,
    },
    comment_to_body_ratio: {
      value: d.comment_to_body_ratio.value,
      note: d.comment_to_body_ratio.note,
    },
    source_files_citing_issues: {
      value: d.source_files_citing_issues.value,
      of: d.source_files_citing_issues.of,
    },
    adr_directory: { value: d.adr_directory.value, note: d.adr_directory.note },
  };
};

export const assemble = (input: AssembleInput): Atlas => {
  const { harvest, gated, ranked, synopsis, shape } = input;

  // The one cross-stage agreement this stage is in a position to check, and it
  // is worth checking: nodes gated against one tree and ranked against another
  // would produce an artifact whose citations resolve at a SHA it never names.
  const rankedIds = new Set(ranked.nodes.map((n) => n.id));
  const gatedIds = new Set(gated.map((g) => g.node.id));
  const strays = [...rankedIds].filter((id) => !gatedIds.has(id));
  if (strays.length > 0) {
    throw new AssembleError(
      `${strays.length} ranked node${strays.length === 1 ? "" : "s"} never passed the gate: ` +
        `${strays.slice(0, 5).join(", ")}${strays.length > 5 ? ", ..." : ""}`,
    );
  }
  if (synopsis.statement.trim() === "" || shape.tree.trim() === "") {
    throw new AssembleError(
      "the synopsis statement and the annotated tree are required; an artifact whose product " +
        "sentence is blank asserts nothing and admits nothing (#6)",
    );
  }
  // An `absent` node has no admissible evidence and is cut outright, never
  // hedged (#3). Rank owns that deletion; a ranked node still carrying absent
  // confidence would have it reach a section, which no stage may allow.
  const absentRanked = ranked.nodes.filter((n) => n.confidence === "absent");
  if (absentRanked.length > 0) {
    throw new AssembleError(
      `${absentRanked.length} ranked node${absentRanked.length === 1 ? "" : "s"} ` +
        `carr${absentRanked.length === 1 ? "ies" : "y"} absent confidence and must never reach a ` +
        `section (#3): ${absentRanked.slice(0, 5).map((n) => n.id).join(", ")}` +
        `${absentRanked.length > 5 ? ", ..." : ""}`,
    );
  }

  const absent_cuts = absentCutsOf(gated);
  const nodes = ranked.nodes;

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: input.generatedAt,
    profile: ranked.profile,
    rubric_version: ranked.rubric_version,
    subject: { ...harvest.subject },
    synopsis,
    shape,
    nodes,
    record: {
      sources: harvest.sources.map((s) => ({ ...s })),
      density_signals: densityOf(harvest),
      section_presence: Object.fromEntries(
        SECTIONS.map((s) => [s, presenceOf(s, nodes, absent_cuts)]),
      ),
      confidence_ledger: ledgerOf(nodes, absent_cuts),
      absent_cuts,
      deletions: ranked.deletions,
      budgets: ranked.budgets,
      ...(harvest.private_split.declared
        ? {
            private_source: {
              declared: true,
              ...(harvest.private_split.repo === undefined
                ? {}
                : { repo: harvest.private_split.repo }),
              readable_at_harvest: harvest.private_split.readable_at_harvest,
              ...(harvest.private_split.note === undefined
                ? {}
                : { note: harvest.private_split.note }),
            },
          }
        : {}),
      // The audit has not run yet. `not_run` is the honest state and the audit
      // command rewrites it in place (#8, 7.1); defaulting to anything else here
      // would have the artifact claim a verification nobody performed.
      audit: { status: "not_run" },
    },
  };
};
