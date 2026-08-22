/**
 * One durable record, and the derivations the subject draws from it.
 *
 * The judgement encoded: the second story worth telling about a system is not
 * another request. It is what happens to the state a request left behind - which
 * independent readings the design supports, what each is filtered by, and what
 * each is consequently blind to. That is the second reference Flow #35 exists to
 * recover, and it has no entry point, so it is a SEPARATE TRACE MODE rather than
 * an HTTP adapter pointed at a repository (accepted design 5.5).
 *
 * Registered separately from the three request adapters for the reason every
 * Flow adapter is: "this subject stores nothing durably", "it stores something
 * nothing derives from", and "it stores something three services derive from"
 * are three different findings, and only naming them keeps them apart (#5, #6).
 */
import { flowCandidate, absentCandidate } from "../flow/candidate.js";
import {
  durableReads,
  lineageBranches,
  lineageHubs,
  lineageTrace,
  reachableFrom,
  subjectGraph,
  type LineageBranch,
} from "../flow/lineage.js";
import { javaIndex, type JavaIndex, type TypeSymbol } from "../flow/symbols.js";
import { methodKey, type TraceResult } from "../flow/trace.js";
import type { Candidate, FlowClaim, Probe, ProbeContext } from "../types.js";

/**
 * Three, from report 5.5 point 4, and it is a threshold rather than a budget.
 *
 * Two readers of a record is a dependency; three independent derivations is a
 * design decision the subject made, and the difference is what separates the
 * reference story from "some classes use this repository" (report 3.4). It bounds
 * what is worth PROPOSING, never what survives - rank alone deletes (#9), and a
 * hub that falls short is an absent cut naming its own count, not a silence.
 */
const MIN_BRANCHES = 3;

const started = (hub: TypeSymbol, index: JavaIndex): TraceResult => {
  const read = durableReads(hub)[0]!;
  const key = methodKey(hub, read.method);
  return {
    entry: key,
    landmarks: new Map([[key, { key, type: hub, method: read.method }]]),
    edges: [],
    terminals: new Set(),
    gaps: [],
    cyclesCut: 0,
    cycleAt: new Set(),
  };
};

/**
 * The closed negative: no derivation drawn here reads another's.
 *
 * Admissible ONLY when a closed reachability check over the subject-owned symbol
 * graph establishes it for every ordered pair, and omitted ENTIRELY otherwise -
 * never weakened to "appear independent" (report 5.5). The claims travel with it
 * so the gate re-derives the same closure from the blob; a caption that made the
 * statement without them is quarantined by the gate on sight.
 */
const independenceClaims = (
  ctx: ProbeContext,
  index: JavaIndex,
  branches: LineageBranch[],
): FlowClaim[] | undefined => {
  const graph = subjectGraph(ctx, index);
  const claims: FlowClaim[] = [];
  for (const from of branches) {
    const reachable = reachableFrom(graph, from.consumer.name);
    for (const other of branches) {
      if (other === from) continue;
      const targets = [
        other.consumer,
        ...other.derivations.map((key) => other.landmarks.get(key)!.type),
      ];
      for (const target of [...new Map(targets.map((t) => [t.qualified + t.path, t])).values()]) {
        if (reachable.has(target.name)) return undefined;
        claims.push({
          expect: "absent",
          matcher: "reachability",
          from: {
            path: from.consumer.path,
            name: from.consumer.name,
            owner: from.consumer.qualified,
          },
          to: { path: target.path, name: target.name, owner: target.qualified },
          evidence: [
            {
              kind: "file",
              path: from.consumer.path,
              line_start: from.consumer.line_start,
              line_end: from.consumer.header_line_end,
              sha: ctx.sha,
            },
          ],
        });
      }
    }
  }
  return claims.length === 0 ? undefined : claims;
};

export const flowJavaSharedState: Probe = {
  id: "flow-java-shared-state",
  finds: "one durable record and the independent derivations the subject draws from it",
  toolchain: "java",
  applies: async (ctx) => {
    const index = await javaIndex(ctx);
    return lineageHubs(index).length > 0
      ? { ok: true }
      : {
          ok: false,
          reason:
            "not applicable to this subject: no production Java type is a durable-storage boundary that the subject both writes and reads with its own SQL, so there is no record to derive from",
        };
  },
  run: async (ctx) => {
    const index = await javaIndex(ctx);
    const out: Candidate[] = [];
    for (const hub of lineageHubs(index)) {
      const { branches, refused } = lineageBranches(index, hub);

      // A consumer this producer could not resolve is reported as its own absent
      // cut rather than left out in silence (#6). The rest of the refusals are
      // structural - the record's own author, a type the container does not
      // manage, a reader that derives nothing - and are not cuts at all.
      for (const cut of refused.filter((r) => r.why === "unresolved_call")) {
        out.push(
          absentCandidate(
            {
              probeId: "flow-java-shared-state",
              prefix: "fl-record",
              sha: ctx.sha,
              title: `${hub.name} read by ${cut.consumer.name}`,
              entryTitle: hub.name,
              idHint: cut.consumer.name,
              trace: started(hub, index),
            },
            cut.detail,
          ),
        );
      }

      if (branches.length < MIN_BRANCHES) {
        const why = refused
          .map((r) => `${r.consumer.name} (${r.why})`)
          .join(", ");
        out.push(
          absentCandidate(
            {
              probeId: "flow-java-shared-state",
              prefix: "fl-record",
              sha: ctx.sha,
              title: `${hub.name}, one record and its derivations`,
              entryTitle: hub.name,
              trace: started(hub, index),
            },
            `too_few_derivations: ${branches.length} subject service${branches.length === 1 ? "" : "s"} read ${hub.name} and reach a named derivation, and a shared-state story needs ${MIN_BRANCHES}` +
              (why === "" ? "" : ` (not counted: ${why})`),
          ),
        );
        continue;
      }

      const trace = lineageTrace(hub, durableReads(hub), branches);
      const independence = independenceClaims(ctx, index, branches);
      out.push(
        flowCandidate({
          probeId: "flow-java-shared-state",
          prefix: "fl-record",
          sha: ctx.sha,
          title: `${hub.name}: ${branches.length} independent derivations over one record`,
          entryTitle: hub.name,
          captionFrom: `the ${hub.name} record`,
          ...(independence === undefined
            ? {}
            : {
                entryClaims: independence,
                captionSuffix:
                  "No derivation drawn here reaches another: the closed symbol graph over this subject takes none of them to any of the others.",
              }),
          trace,
        }),
      );
    }
    return out;
  },
};
