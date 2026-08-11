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
import type { AtlasNode, Evidence, FileEvidence } from "../../schema/types.js";

/** Every file evidence entry in the graph, with the node that carries it. */
export const fileEvidence = (atlas: AuditContext["atlas"]): { owner: string; e: FileEvidence }[] => {
  const out: { owner: string; e: FileEvidence }[] = [];
  const add = (owner: string, list: Evidence[]) => {
    for (const e of list) if (e.kind === "file") out.push({ owner, e });
  };
  add("synopsis", atlas.synopsis.evidence);
  add("shape", atlas.shape.evidence);
  for (const n of atlas.nodes) {
    add(n.id, n.evidence);
    if (n.type === "decision") add(n.id, n.implemented_by);
    if (n.type === "mechanism" && n.code_excerpt) add(n.id, [n.code_excerpt.evidence]);
    if (n.type === "flow") for (const s of n.steps) if (s.evidence) add(n.id, [s.evidence]);
  }
  return out;
};

/**
 * L1 and L2 run as one pass over the tree because they read the same blob: the
 * path has to exist before a range inside it can mean anything, and reading the
 * file twice to report them separately would be slower and no more honest.
 */
export const resolveFileEvidence = (ctx: AuditContext): [CheckResult, CheckResult] => {
  const entries = fileEvidence(ctx.atlas);
  const missing: string[] = [];
  const outOfRange: string[] = [];
  let ranges = 0;

  for (const { owner, e } of entries) {
    const contents = blobAt(ctx.clone, ctx.atlas.subject.sha, e.path);
    if (contents === null) {
      missing.push(`${owner}: ${e.path} does not exist at ${ctx.atlas.subject.sha}`);
      continue;
    }
    if (e.line_start === undefined) continue;
    ranges += 1;
    const lines = lineCount(contents);
    const end = e.line_end ?? e.line_start;
    if (e.line_start < 1 || end < e.line_start || end > lines) {
      outOfRange.push(
        `${owner}: ${e.path}:${e.line_start}-${end} but the file has ${lines} lines at ${ctx.atlas.subject.sha}`,
      );
    }
  }

  return [
    missing.length === 0
      ? passed(spec("L1"), entries.length)
      : failed(spec("L1"), missing, entries.length),
    outOfRange.length === 0
      ? passed(spec("L2"), ranges)
      : failed(spec("L2"), outOfRange, ranges),
  ];
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

/** Reported when a subject's graph carries no file evidence at all. */
export const noFileEvidence = (ctx: AuditContext): CheckResult | null =>
  fileEvidence(ctx.atlas).length === 0
    ? notApplicable(spec("L1"), "the graph cites no files, so there is nothing to resolve")
    : null;
