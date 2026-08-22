/**
 * One Spring HTTP route, traced from its handler to its terminals.
 *
 * The judgement encoded: an execution story starts where the outside world can
 * reach the subject, and an HTTP route is that boundary written into the type
 * system as an annotation. Everything after it is resolved from declarations -
 * receivers, fields, locals, overloads - and the phase stops, by name, wherever
 * the tree stops establishing the next step.
 *
 * This adapter is registered separately from the CLI one so the four honest
 * states stay distinguishable in the run's own report (#35, accepted design 8):
 * no applicable adapter, adapter ran and found no entry, candidate trace failed
 * verification, and verified Flow lost in ranking.
 */
import { flowCandidate } from "../flow/candidate.js";
import { httpEntries } from "../flow/entries.js";
import { javaIndex } from "../flow/symbols.js";
import { traceFrom } from "../flow/trace.js";
import type { Candidate, FlowClaim, Probe } from "../types.js";

const SPRING_IMPORT = /^\s*import\s+org\.springframework\./m;

export const flowJavaSpringHttp: Probe = {
  id: "flow-java-spring-http",
  finds: "one Spring HTTP route traced through typed calls to its response and durable writes",
  toolchain: "java",
  applies: async (ctx) => {
    const index = await javaIndex(ctx);
    const runsSpring = index.paths.some((path) => SPRING_IMPORT.test(ctx.read(path) ?? ""));
    return runsSpring
      ? { ok: true }
      : {
          ok: false,
          reason:
            "not applicable to this subject: no production Java source imports org.springframework, so it declares no Spring HTTP surface to trace",
        };
  },
  run: async (ctx) => {
    const index = await javaIndex(ctx);
    const out: Candidate[] = [];
    for (const entry of httpEntries(index)) {
      const trace = traceFrom(index, entry.type, entry.method);
      const route = `${entry.protocol.method} ${entry.protocol.path}`;
      // The route itself is a claim about the tree, so the gate re-derives it
      // from the blob rather than taking the producer's word: the class-level
      // prefix and the method mapping are both cited, because their composition
      // is what is being claimed.
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
            line_start: entry.type.line_start,
            line_end: entry.type.header_line_end,
            sha: ctx.sha,
          },
          {
            kind: "file",
            path: entry.type.path,
            line_start: entry.method.line_start,
            line_end: entry.method.line_end,
            sha: ctx.sha,
          },
        ],
      };
      out.push(
        flowCandidate({
          probeId: "flow-java-spring-http",
          prefix: "fl-http",
          sha: ctx.sha,
          title: `${route}, entry to terminal`,
          entryTitle: route,
          entryKind: "request",
          entryClaims: [routeClaim],
          trace,
        }),
      );
    }
    return out;
  },
};
