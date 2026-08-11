/**
 * L1, L2, L5, E2 - the evidence checks.
 *
 * These are gates because a citation that does not resolve is a false citation,
 * and a false citation is the artifact making a claim that is not true. That is
 * the whole classification rule.
 */
import { blobAt, lineCount } from "../git.js";
import { spec } from "../register.js";
import { failed, notApplicable, passed, type AuditContext, type CheckResult } from "../types.js";
import type { Atlas, AtlasNode, Evidence, FileEvidence } from "../../schema/types.js";

/**
 * The one traversal of the evidence-bearing locations (synopsis, shape,
 * node.evidence, decision.implemented_by, mechanism.code_excerpt, flow.steps).
 *
 * L1/L2 coverage and the synthetic subject the tests build both resolve
 * citations at exactly these locations, so they share this walk rather than
 * keeping two copies in step by hand: a future schema addition that adds an
 * evidence-bearing field is added here once, and neither side can silently drift
 * from the other and stop materialising a cited file the check still resolves.
 */
export const eachEvidence = (atlas: Atlas, visit: (e: Evidence, owner: string) => void): void => {
  const walk = (owner: string, list: Evidence[]) => {
    for (const e of list) visit(e, owner);
  };
  walk("synopsis", atlas.synopsis.evidence);
  walk("shape", atlas.shape.evidence);
  for (const n of atlas.nodes) {
    walk(n.id, n.evidence);
    if (n.type === "decision") walk(n.id, n.implemented_by);
    if (n.type === "mechanism" && n.code_excerpt) walk(n.id, [n.code_excerpt.evidence]);
    if (n.type === "flow") for (const s of n.steps) if (s.evidence) walk(n.id, [s.evidence]);
  }
};

/** Every file evidence entry in the graph, with the node that carries it. */
export const fileEvidence = (atlas: Atlas): { owner: string; e: FileEvidence }[] => {
  const out: { owner: string; e: FileEvidence }[] = [];
  eachEvidence(atlas, (e, owner) => {
    if (e.kind === "file") out.push({ owner, e });
  });
  return out;
};

/**
 * The graph carries no file evidence at all, so neither L1 (paths) nor L2
 * (ranges) has anything to resolve. This stage's contract is that a check which
 * could not run never counts as passing and that absence is never communicated
 * by silence (#8), so both report not_applicable by name with a reason rather
 * than a hollow pass. The decision-poor subject in #10 can produce exactly this.
 */
const noFileEvidence = (): [CheckResult, CheckResult] => [
  notApplicable(spec("L1"), "the graph cites no files, so there is no path to resolve"),
  notApplicable(spec("L2"), "the graph cites no files, so there is no line range to resolve"),
];

/**
 * L1 and L2 run as one pass over the tree because they read the same blob: the
 * path has to exist before a range inside it can mean anything, and reading the
 * file twice to report them separately would be slower and no more honest.
 */
export const resolveFileEvidence = (ctx: AuditContext): [CheckResult, CheckResult] => {
  const entries = fileEvidence(ctx.atlas);
  if (entries.length === 0) return noFileEvidence();
  const missing: string[] = [];
  const outOfRange: string[] = [];
  // L2's population is the line ranges DECLARED in the graph, counted
  // independently of whether their path resolved. Deciding applicability from
  // the ranges the check managed to examine mis-describes a graph that declared
  // ranges whose paths simply did not resolve at this SHA - it would report "no
  // ranges to resolve" while pointing the reader of a failed audit the wrong way
  // (#8: the audit must never mis-describe its own coverage).
  let declaredRanges = 0;
  let examinedRanges = 0;
  const unresolvedRanges: string[] = [];

  for (const { owner, e } of entries) {
    if (e.line_start !== undefined) declaredRanges += 1;
    const contents = blobAt(ctx.clone, ctx.atlas.subject.sha, e.path);
    if (contents === null) {
      missing.push(`${owner}: ${e.path} does not exist at ${ctx.atlas.subject.sha}`);
      if (e.line_start !== undefined) {
        unresolvedRanges.push(`${owner}: ${e.path}:${e.line_start}`);
      }
      continue;
    }
    if (e.line_start === undefined) continue;
    examinedRanges += 1;
    const lines = lineCount(contents);
    const end = e.line_end ?? e.line_start;
    if (e.line_start < 1 || end < e.line_start || end > lines) {
      outOfRange.push(
        `${owner}: ${e.path}:${e.line_start}-${end} but the file has ${lines} lines at ${ctx.atlas.subject.sha}`,
      );
    }
  }

  const l1 =
    missing.length === 0
      ? passed(spec("L1"), entries.length)
      : failed(spec("L1"), missing, entries.length);

  // L1 examined a real population (the file paths) and reports its outcome. L2's
  // applicability keys off the ranges DECLARED, not the ranges examined:
  // - No entry declares a range: L2 had no population, so not_applicable by name
  //   rather than a hollow passed(0) - the both-empty ruling, one finer (#8).
  // - Ranges declared but not one of their paths resolved: L2 examined nothing,
  //   so it still cannot claim a pass, and its reason must be the real one - the
  //   unresolved paths - never "no ranges exist" (see L1 for those paths).
  // - Some declared ranges resolved and some did not: L2 reports on the subset it
  //   examined but must NAME the shortfall, so a reduced count is never read as
  //   full coverage. L2 may never claim coverage it did not have, regardless of
  //   the fact that any unresolved path already fails L1 and blocks the verdict.
  // - Otherwise L2 reports on the ranges it actually examined; the count never
  //   claims coverage it did not have.
  const shortfall = `${unresolvedRanges.length} of ${declaredRanges} declared line range(s) could not be checked because their paths did not resolve at ${ctx.atlas.subject.sha}; see L1: ${unresolvedRanges.slice(0, 20).join("; ")}`;
  let l2: CheckResult;
  if (declaredRanges === 0) {
    l2 = notApplicable(spec("L2"), "the graph cites files but none carry a line range to resolve");
  } else if (examinedRanges === 0) {
    l2 = notApplicable(spec("L2"), shortfall);
  } else if (outOfRange.length > 0) {
    l2 = failed(spec("L2"), outOfRange, examinedRanges);
  } else if (unresolvedRanges.length > 0) {
    l2 = { ...passed(spec("L2"), examinedRanges), reason: shortfall };
  } else {
    l2 = passed(spec("L2"), examinedRanges);
  }

  return [l1, l2];
};

/**
 * L5 - every rendered evidence link carries the run's SHA.
 *
 * `links.ts` already refuses to build an unpinned link at render time. This
 * asserts the property again from outside, on the shipped bytes, because the two
 * guard different failure modes: the render-time guard protects against a bad
 * Evidence object, and this protects against a renderer change that stops
 * calling links.ts at all.
 */
export const shaPinned = (ctx: AuditContext): CheckResult => {
  const { sha, url } = ctx.atlas.subject;
  const blobLinks = [...ctx.artifact.matchAll(/href="([^"]*\/(?:blob|tree|commit)\/[^"]*)"/g)].map(
    (m) => m[1] ?? "",
  );
  const unpinned = blobLinks.filter((href) => href.startsWith(url) && !href.includes(sha));
  return unpinned.length === 0
    ? passed(spec("L5"), blobLinks.length)
    : failed(
        spec("L5"),
        unpinned.slice(0, 20).map((h) => `link is not pinned to ${sha}: ${h}`),
        blobLinks.length,
      );
};

/**
 * E2 - a present-tense behavioural claim needs file or command evidence.
 *
 * Discovery finding 4, made operational: design documents are written in the
 * present tense about things that do not exist. A node whose rendered prose
 * describes current behaviour must carry evidence that observed the behaviour;
 * an issue citation alone is a record of intent, which #3 already calls
 * `attested` rather than `verified`.
 *
 * The complementary structural assertions ride along on the same gate: a
 * `decided_not_built` decision must have an empty implemented_by[], and a
 * `decided_and_built` one must not. #7 found the mirror case live - an open
 * ticket whose implementation fully existed - so the gate has to be able to
 * disagree with the record in both directions. Confirming that the outcome is
 * internally consistent is this check's share of that; overturning the record is
 * the existence gate's job, not the audit's.
 */
const BEHAVIOURAL_EDGE_KINDS = new Set(["divergence", "tradeoff", "risk"]);

const isBehavioural = (n: AtlasNode): boolean =>
  n.type === "mechanism" ||
  n.type === "boundary" ||
  n.type === "flow" ||
  (n.type === "edge" && BEHAVIOURAL_EDGE_KINDS.has(n.kind));

const observesBehaviour = (e: Evidence): boolean => e.kind === "file" || e.kind === "command";

export const presentTenseClaims = (ctx: AuditContext): CheckResult => {
  const admissible = ctx.atlas.nodes.filter((n) => n.confidence !== "absent");
  const problems: string[] = [];
  let behavioural = 0;

  for (const n of admissible) {
    if (isBehavioural(n)) {
      behavioural += 1;
      if (!n.evidence.some(observesBehaviour)) {
        problems.push(
          `${n.id} (${n.type}) describes current behaviour but cites no file or command evidence - only a record of intent`,
        );
      }
    }
    if (n.type === "decision") {
      if (n.status === "decided_not_built" && n.implemented_by.length > 0) {
        problems.push(
          `${n.id} is decided_not_built but carries ${n.implemented_by.length} implementation citations`,
        );
      }
      if (n.status === "decided_and_built" && n.implemented_by.length === 0) {
        problems.push(`${n.id} is decided_and_built but cites nothing that implements it`);
      }
    }
  }

  return problems.length === 0
    ? passed(spec("E2"), behavioural)
    : failed(spec("E2"), problems, behavioural);
};
