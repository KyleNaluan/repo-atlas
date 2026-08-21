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
import { gateFlowCandidate } from "./flow.js";

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
 *
 * The same third answer covers a pattern that will not compile. Claims now
 * originate from model output as well as deterministic probes, so a malformed
 * regex is reachable input, not a code bug. Searching cannot proceed, so the
 * claim is undecidable exactly as an unreadable manifest is - the gate must
 * never crash on it, and never pass it silently as though the tree had been
 * read. `undecidableReason` names the specific cause for the finding.
 */
const treeHas = (
  ctx: ProbeContext,
  claim: ExistenceClaim,
): { found: boolean; where: string[]; undecidable: boolean; undecidableReason?: string } => {
  const where: string[] = [];
  let undecidable = false;

  for (const path of claim.paths ?? []) {
    if (ctx.read(path) !== null) where.push(path);
  }

  if (claim.pattern) {
    let include: RegExp | null;
    let regex: RegExp;
    try {
      include = claim.pattern.include ? new RegExp(claim.pattern.include) : null;
      regex = new RegExp(claim.pattern.regex, "i");
    } catch {
      const bad =
        claim.pattern.include !== undefined
          ? `include \`${claim.pattern.include}\` / regex \`${claim.pattern.regex}\``
          : `regex \`${claim.pattern.regex}\``;
      return {
        found: where.length > 0,
        where,
        undecidable: true,
        undecidableReason: `its search pattern did not compile (${bad}), so the tree could not be searched for it`,
      };
    }
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
    // Any alias of the technology counts, so the group that governs the finding
    // also governs its verification.
    const aliases = claim.declares;
    let sawUnrecognized = false;
    for (const m of declaredManifests(ctx)) {
      if (!m.recognized) {
        sawUnrecognized = true;
        continue;
      }
      if ([...m.names].some((n) => aliases.some((a) => n.includes(a)))) where.push(m.path);
      if (where.length >= 5) break;
    }
    // A manifest the rule could not read might declare it; absence is unproven.
    if (where.length === 0 && sawUnrecognized) undecidable = true;
  }

  return { found: where.length > 0, where, undecidable };
};

/** Single-quote for a shell, so a pattern with spaces or metacharacters survives. */
const quoted = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * What the gate read when it found nothing, cited as evidence.
 *
 * A divergence edge born from an overturned PRESENT claim states a fact about
 * the tree - the thing the record describes is not there - while having no file
 * to point at, because not finding it is the whole finding. Audit check E2 is
 * right to refuse that: a node asserting current behaviour on the strength of a
 * ticket is the failure this engine exists to prevent, and a divergence edge is
 * the node type most likely to be believed. What actually established it is a
 * NEGATIVE SEARCH RESULT, which #8's M2 already recognises as witnessing absence.
 *
 * The commands below are faithful rather than decorative. The gate searches
 * through its own tree reader, not a subprocess, so each `cmd` is written as the
 * closest git invocation that performs the same search at the same SHA and can
 * actually be run to check the claim. Where git cannot express what the gate did
 * - a declared-dependency claim is parsed from manifests, and #7's resolution is
 * explicit that a grep is NOT that rule - no command is invented; the manifests
 * the gate read are cited as files instead, which a reader can open and check.
 */
const negativeEvidence = (ctx: ProbeContext, claim: ExistenceClaim): Evidence[] => {
  const out: Evidence[] = [];
  const paths = claim.paths ?? [];
  if (paths.length > 0) {
    out.push({
      kind: "command",
      cmd: `git ls-tree -r --name-only ${ctx.sha} -- ${paths.map(quoted).join(" ")}`,
      output_excerpt: "(no output: none of these paths exist at this commit)",
    });
  }
  if (claim.pattern !== undefined) {
    const include = claim.pattern.include;
    // The gate restricted the search to files whose PATH matches `include`
    // (treeHas, above). git grep's pathspec is not a regex, so the filter is
    // reproduced by substituting the equivalently-filtered listing as the
    // pathspec - running the printed command then searches exactly the set the
    // gate searched, not the superset an unrestricted grep would. The excerpt
    // states that scope rather than claiming universality: a reader who ran an
    // unscoped command and hit a match in an excluded file would have a result
    // that contradicts the citation, the exact failure this evidence prevents.
    out.push({
      kind: "command",
      cmd:
        include === undefined
          ? `git grep -I -i -E ${quoted(claim.pattern.regex)} ${ctx.sha}`
          : `git grep -I -i -E ${quoted(claim.pattern.regex)} ${ctx.sha} -- $(git ls-tree -r --name-only ${ctx.sha} | grep -E ${quoted(include)})`,
      output_excerpt:
        include === undefined
          ? "(no output: no file at this commit matches)"
          : `(no output: no file whose path matches /${include}/ contains this pattern at this commit)`,
    });
  }
  if (claim.declares !== undefined) {
    // No invented command. The rule is a manifest parse, and #7's resolution is
    // that a substring grep is a different question with a different answer.
    for (const m of declaredManifests(ctx)) {
      if (m.recognized) out.push({ kind: "file", path: m.path, sha: ctx.sha });
    }
  }
  return out;
};

/**
 * A candidate the tree contradicted becomes a divergence edge.
 *
 * Dropping it would throw away the finding. The record and the build disagreeing
 * is not noise to be filtered - it is the thing an interviewer asks about, and
 * #7 requires the confirmed contradiction to survive as its own node.
 */
const toDivergence = (
  ctx: ProbeContext,
  candidate: Candidate,
  claim: ExistenceClaim,
  where: string[],
): EdgeNode => {
  // An overturned ABSENT claim found the thing, so the files it was found in are
  // the evidence. An overturned PRESENT claim found nothing, so what established
  // it is the search that came back empty.
  const evidence: Evidence[] =
    where.length > 0
      ? where.slice(0, 3).map((path) => ({ kind: "file" as const, path, sha: "" }))
      : negativeEvidence(ctx, claim);
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

/**
 * The gate settles whether a decision was built, in both directions.
 *
 * The write stage never sets this, and must not: a resolution comment states what
 * was decided, never that it was built, and treating the record as evidence of
 * implementation is the exact failure #7 point 7 wrote a bidirectional gate to
 * prevent. So the settlement happens here, on the strength of the gate's own
 * reading of the tree, and `implemented_by` carries the paths the gate actually
 * located rather than anything a model proposed. Verification recorded, not
 * assertion trusted.
 *
 * A confirmed present-claim promotes to `decided_and_built` with the paths the
 * gate located. A confirmed absent-claim settles the mirror: `decided_not_built`,
 * with `implemented_by` left empty per #8's E2, because confirming a thing is not
 * there is not a citation of where it is built. A decision with neither is left
 * alone - `decided` is the honest state for a decision nothing in the tree was
 * asked to confirm, and moving one on the strength of a claim nobody checked would
 * be the thing this function exists to avoid.
 *
 * Only a `decided` node moves. A `superseded` decision is a statement about the
 * decision's standing - a later decision replaced it - not about its build state,
 * and its old code lingering in the tree is exactly what one would expect, not
 * evidence to relabel it `decided_and_built`. Confirming that stale code would
 * erase the fact that the decision was overtaken, so `superseded` is left untouched.
 */
const settleBuild = (
  node: AtlasNode,
  confirmedAt: string[],
  confirmedAbsent: boolean,
  sha: string,
): AtlasNode => {
  if (node.type !== "decision" || node.status !== "decided") return node;
  if (confirmedAt.length > 0) {
    const seen = new Set<string>();
    const implemented_by: Evidence[] = confirmedAt
      .filter((path) => !seen.has(path) && seen.add(path))
      .map((path) => ({ kind: "file" as const, path, sha }));
    return { ...node, status: "decided_and_built", implemented_by };
  }
  if (confirmedAbsent) return { ...node, status: "decided_not_built", implemented_by: [] };
  return node;
};

export const gateCandidate = (ctx: ProbeContext, candidate: Candidate): GatedCandidate => {
  // A Flow is atomic and never follows the generic demote/divergence path. One
  // broken arrow invalidates the story on both sides, so the Flow gate either
  // verifies the complete links-based graph or quarantines it as absent (#35).
  if (candidate.node.type === "flow") return gateFlowCandidate(ctx, candidate);

  const claims = candidate.claims ?? [];
  /** Where a confirmed present-claim was found, for the settlement below. */
  const confirmedAt: string[] = [];
  /** True once the tree confirms an absent-claim, settling `decided_not_built`. */
  let confirmedAbsent = false;
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

    const { found, where, undecidable, undecidableReason } = treeHas(ctx, claim);
    if (undecidable) {
      // The gate looked but could not settle the claim: a build manifest present
      // in a form the shared rule cannot read, or a model-authored pattern that
      // will not compile. Either way, confirming the divergence would assert a
      // contradiction the gate did not establish, so the candidate is demoted
      // exactly as an unreadable claim is.
      return {
        probe_id: candidate.probe_id,
        node: { ...candidate.node, confidence: "attested" },
        verdict: "unresolved",
        finding: `${claim.description}: ${undecidableReason ?? "a build manifest is present but in a form this gate cannot read, so whether it declares this is undecided"}`,
      };
    }
    const agrees = claim.expect === "present" ? found : !found;
    if (agrees && claim.expect === "present") {
      // Remembered so a confirmed decision can record WHERE the gate found it.
      // Discarding these would throw away a verification the gate performed.
      confirmedAt.push(...where);
    }
    if (agrees && claim.expect === "absent") {
      // The mirror verification: the tree confirms the decision was not built.
      confirmedAbsent = true;
    }
    if (!agrees) {
      const divergence = toDivergence(ctx, candidate, claim, where);
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
    node: settleBuild(candidate.node, confirmedAt, confirmedAbsent, ctx.sha),
    verdict: "confirmed",
    finding:
      confirmedAt.length === 0
        ? "the tree agrees with the record"
        : `the tree agrees with the record, and carries it at ${confirmedAt.slice(0, 3).join(", ")}`,
  };
};

export const gate = (ctx: ProbeContext, candidates: Candidate[]): GatedCandidate[] =>
  candidates.map((c) => gateCandidate(ctx, c));
