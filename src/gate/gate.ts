/**
 * The existence gate, which must be able to overturn the record in BOTH
 * directions (#7's resolution point 7).
 *
 * The single-direction version of this is the obvious one and it is wrong. It
 * would take the record's word for what exists and only check claims that
 * something IS built. #7 found the mirror case live on the reference subject:
 * an open ticket for a "second language adapter" whose implementation fully
 * existed at the pinned SHA. An open ticket is not evidence of absence, exactly
 * as a closed decision is not evidence of implementation.
 *
 * So a claim carries what the record IMPLIES (`expect`), the gate reads the
 * tree, and there are three outcomes:
 *
 *   confirmed  - the tree agrees with the record; the candidate stands
 *   overturned - the tree disagrees; the candidate becomes a `divergence` edge
 *                rather than being dropped, because a confirmed contradiction
 *                between the record and the build is the most interesting thing
 *                either of them can produce
 *   unresolved - the gate could not read enough to decide; the candidate is
 *                demoted rather than admitted, because a claim nobody checked
 *                must never arrive looking checked
 */
import type { Candidate, ExistenceClaim, ProbeContext } from "../probes/types.js";
import { declaredManifests } from "../probes/manifests.js";
import type { AtlasNode, EdgeNode, Evidence } from "../schema/types.js";

export type Verdict = "confirmed" | "overturned" | "unresolved";

export interface GatedCandidate {
  probe_id: string;
  node: AtlasNode;
  verdict: Verdict;
  /** What the gate read, in one line, for the record. */
  finding: string;
}

/**
 * Does the tree hold the thing the claim is about?
 *
 * `undecidable` is the third answer a boolean cannot carry: the gate looked but
 * a manifest present in a form the shared rule cannot read might declare the
 * dependency. Treating that as "not declared" would let the gate confirm a
 * divergence it never established - so the claim comes back undecidable and the
 * candidate is demoted rather than confirmed.
 */
const treeHas = (
  ctx: ProbeContext,
  claim: ExistenceClaim,
): { found: boolean; where: string[]; undecidable: boolean } => {
  const where: string[] = [];
  let undecidable = false;

  for (const path of claim.paths ?? []) {
    if (ctx.read(path) !== null) where.push(path);
  }

  if (claim.pattern) {
    const include = claim.pattern.include ? new RegExp(claim.pattern.include) : null;
    const regex = new RegExp(claim.pattern.regex, "i");
    for (const path of ctx.paths) {
      if (include && !include.test(path)) continue;
      const text = ctx.read(path);
      if (text !== null && regex.test(text)) where.push(path);
      if (where.length >= 5) break;
    }
  }

  if (claim.declares !== undefined) {
    // Re-parse declared dependency names with the SAME rule the probe used, so
    // "declared" means one thing on both sides. A bare mention in a comment or a
    // transitive coordinate is not a declaration and must not settle the claim.
    const tech = claim.declares;
    let sawUnrecognized = false;
    for (const m of declaredManifests(ctx)) {
      if (!m.recognized) {
        sawUnrecognized = true;
        continue;
      }
      if ([...m.names].some((n) => n.includes(tech))) where.push(m.path);
      if (where.length >= 5) break;
    }
    // A manifest the rule could not read might declare it; absence is unproven.
    if (where.length === 0 && sawUnrecognized) undecidable = true;
  }

  return { found: where.length > 0, where, undecidable };
};

/**
 * A candidate the tree contradicted becomes a divergence edge.
 *
 * Dropping it would throw away the finding. The record and the build disagreeing
 * is not noise to be filtered - it is the thing an interviewer asks about, and
 * #7 requires the confirmed contradiction to survive as its own node.
 */
const toDivergence = (candidate: Candidate, claim: ExistenceClaim, where: string[]): EdgeNode => {
  const evidence: Evidence[] = where.slice(0, 3).map((path) => ({
    kind: "file" as const,
    path,
    sha: "",
  }));
  const said =
    claim.expect === "absent"
      ? "the record implies this is not built, and the tree says otherwise"
      : "the record implies this exists, and the tree does not carry it";
  return {
    type: "edge",
    kind: "divergence",
    id: `${candidate.node.id}-divergence`,
    title: candidate.node.title,
    statement: `${claim.description}. Checked against the tree: ${said}.`,
    why_it_matters:
      "The record and the build disagree. Going first on that is strictly better than being caught by it, and it is the one finding a summariser cannot produce.",
    how_to_say_it: `The tracker and the code disagree here - ${said}.`,
    evidence: [...candidate.node.evidence, ...evidence],
    confidence: "verified",
    interview_value: 0,
    ...(candidate.probe_id === undefined ? {} : { probe_id: candidate.probe_id }),
  };
};

export const gateCandidate = (ctx: ProbeContext, candidate: Candidate): GatedCandidate => {
  const claims = candidate.claims ?? [];
  if (claims.length === 0) {
    return {
      probe_id: candidate.probe_id,
      node: candidate.node,
      verdict: "confirmed",
      finding: "grounded in what the probe read; no separate claim to resolve",
    };
  }

  for (const claim of claims) {
    const checkable =
      (claim.paths?.length ?? 0) > 0 || claim.pattern !== undefined || claim.declares !== undefined;
    if (!checkable) {
      // A claim with nothing to read cannot be resolved either way. #7's live
      // false positive is the reason this is a demotion rather than a pass: the
      // record alone is not enough to admit a claim about the tree.
      return {
        probe_id: candidate.probe_id,
        node: { ...candidate.node, confidence: "attested" },
        verdict: "unresolved",
        finding: `${claim.description}: nothing in the tree settles this either way, so it stands on the record alone`,
      };
    }

    const { found, where, undecidable } = treeHas(ctx, claim);
    if (undecidable) {
      // A build manifest is present but in a form the shared rule cannot read.
      // Confirming the divergence would assert a contradiction the gate did not
      // establish, so the candidate is demoted exactly as an unreadable claim is.
      return {
        probe_id: candidate.probe_id,
        node: { ...candidate.node, confidence: "attested" },
        verdict: "unresolved",
        finding: `${claim.description}: a build manifest is present but in a form this gate cannot read, so whether it declares this is undecided`,
      };
    }
    const agrees = claim.expect === "present" ? found : !found;
    if (!agrees) {
      const divergence = toDivergence(candidate, claim, where);
      const evidence = divergence.evidence.map((e) =>
        e.kind === "file" && e.sha === "" ? { ...e, sha: ctx.sha } : e,
      );
      return {
        probe_id: candidate.probe_id,
        node: { ...divergence, evidence },
        verdict: "overturned",
        finding: `${claim.description}, but the tree says otherwise${where.length > 0 ? ` (${where.slice(0, 3).join(", ")})` : ""}`,
      };
    }
  }

  return {
    probe_id: candidate.probe_id,
    node: candidate.node,
    verdict: "confirmed",
    finding: "the tree agrees with the record",
  };
};

export const gate = (ctx: ProbeContext, candidates: Candidate[]): GatedCandidate[] =>
  candidates.map((c) => gateCandidate(ctx, c));
