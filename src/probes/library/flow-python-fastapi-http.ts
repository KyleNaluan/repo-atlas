/**
 * One FastAPI route, traced from its handler to its terminals (#52).
 *
 * The judgement encoded is `flow-java-spring-http`'s, in a language that states
 * it differently: an execution story starts where the outside world can reach the
 * subject, and a FastAPI route is that boundary written as a decorator naming one
 * verb and one literal path. Everything after it is resolved from declarations -
 * imports, `__init__` attributes, annotations, return annotations - and the phase
 * stops, by name, wherever the tree stops establishing the next step.
 *
 * The route claim reuses the `spring_route` matcher, and the name is Java-flavoured
 * history rather than a statement about the framework. What the matcher asserts is
 * "the caller and the handler establish the same verb and the same normalized path",
 * which is exactly what is being claimed here; the gate re-derives the Python half
 * with its own reader, sharing only `normalizedRoute`. #52 fixes the new-matcher
 * budget at one (`declared_pipeline`), so renaming it is a separate decision.
 *
 * There is no transport arrow on either #52 subject and that is said by name
 * rather than left as an absence: ftb's `webui` is server-rendered Jinja with no
 * `fetch` anywhere, and dsa's only client-side call is htmx-attribute driven with
 * a Jinja-templated path, which the existing TypeScript scanner correctly refuses
 * as `generated_path:`. Both subjects therefore get caption-level route claims and
 * no transport arrow - exactly the state PR 4 shipped for Spring before PR 6 had a
 * caller to draw one from.
 */
import { flowCandidate } from "../flow/candidate.js";
import { pyHttpEntries } from "../flow/py-entries.js";
import { declaresFastAPI } from "../flow/py-framework.js";
import { pythonIndex } from "../flow/py-symbols.js";
import { pyTraceFrom, soleLandmarkTrace } from "../flow/py-trace.js";
import { absentCandidate } from "../flow/candidate.js";
import type { Candidate, FlowClaim, Probe } from "../types.js";

const PROBE_ID = "flow-python-fastapi-http";
const PREFIX = "fl-py-http";

export const flowPythonFastapiHttp: Probe = {
  id: PROBE_ID,
  finds: "one FastAPI route traced through typed Python calls to its response and durable effects",
  toolchain: "python",
  applies: async (ctx) => {
    const index = await pythonIndex(ctx);
    return declaresFastAPI(index.paths, ctx.read)
      ? { ok: true }
      : {
          ok: false,
          reason:
            "not applicable to this subject: no production Python source imports fastapi, so it declares no FastAPI HTTP surface to trace",
        };
  },
  run: async (ctx) => {
    const index = await pythonIndex(ctx);
    const { entries, cuts } = pyHttpEntries(index);
    const out: Candidate[] = [];
    for (const entry of entries) {
      const route = `${entry.protocol.method} ${entry.protocol.path}`;
      // The route itself is a claim about the tree, so the gate re-derives it from
      // the blob rather than taking the producer's word: the decorator, the `def`
      // and every span the prefix was composed from are all cited, because their
      // composition is what is being claimed.
      const symbol = {
        path: entry.type.path,
        name: entry.method.name,
        owner: entry.type.qualified,
        arity: entry.method.params.length,
        protocol: entry.protocol,
      };
      const routeClaim: FlowClaim = {
        expect: "present",
        matcher: "spring_route",
        from: symbol,
        to: symbol,
        evidence: [
          {
            kind: "file",
            path: entry.type.path,
            line_start: entry.method.line_start,
            line_end: entry.method.line_end,
            sha: ctx.sha,
          },
          ...entry.composition.map((span) => ({
            kind: "file" as const,
            path: span.path,
            line_start: span.line_start,
            line_end: span.line_end,
            sha: ctx.sha,
          })),
        ],
      };
      out.push(
        flowCandidate({
          probeId: PROBE_ID,
          prefix: PREFIX,
          sha: ctx.sha,
          title: `${route}, entry to terminal`,
          entryTitle: route,
          entryKind: "request",
          entryClaims: [routeClaim],
          trace: pyTraceFrom(index, entry.type, entry.method),
        }),
      );
    }
    // A route this reader refused is a NAMED cut rather than a silence (#6): a
    // dynamic path, a prefix that is not a literal, and a router nothing mounts
    // are three different findings about the subject, and reporting none of them
    // would make a subject with an unmountable router read like one with no routes.
    for (const cut of cuts) {
      out.push(
        absentCandidate(
          {
            probeId: PROBE_ID,
            prefix: PREFIX,
            sha: ctx.sha,
            title: `${cut.type.name}.${cut.method.name}, route not established`,
            entryTitle: cut.method.name,
            idHint: `route-cut-${cut.method.name}`,
            trace: soleLandmarkTrace(cut.type, cut.method),
          },
          cut.reason,
        ),
      );
    }
    return out;
  },
};
