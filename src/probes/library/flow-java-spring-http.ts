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
import { flowCandidate, type TransportCaller } from "../flow/candidate.js";
import { httpEntries, type HttpEntry } from "../flow/entries.js";
import { clientIndex } from "../flow/http-client.js";
import { slug } from "../id.js";
import { javaIndex } from "../flow/symbols.js";
import { traceFrom } from "../flow/trace.js";
import type { Candidate, FlowClaim, Probe, ProbeContext } from "../types.js";

const SPRING_IMPORT = /^\s*import\s+org\.springframework\./m;

/**
 * The client modules that call one route, matched on verb AND normalized path.
 *
 * Path text alone is not a match (report 5.2): `GET /api/attempts` and
 * `POST /api/attempts` are two different stories through the same string, and
 * this subject writes both. One box per calling MODULE, at the same granularity
 * every other box uses, with every action that reaches the route named inside it
 * so the arrow's endpoint is findable in the box it lands on.
 */
const callersOf = (ctx: ProbeContext, entry: HttpEntry): TransportCaller[] => {
  const matched = clientIndex(ctx).calls.filter(
    (call) =>
      call.protocol.method === entry.protocol.method && call.protocol.path === entry.protocol.path,
  );
  const byModule = new Map<string, typeof matched>();
  for (const call of matched) byModule.set(call.path, [...(byModule.get(call.path) ?? []), call]);

  const used = new Set<string>();
  const out: TransportCaller[] = [];
  for (const [path, calls] of byModule) {
    const file = path.slice(path.lastIndexOf("/") + 1);
    const base = slug(file);
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    const wrapper = calls.find((call) => call.wrapper !== undefined)?.wrapper;
    out.push({
      id,
      node: file,
      path,
      actions: [...new Set(calls.map((call) => call.action.name))],
      box: {
        line_start: Math.min(...calls.map((call) => call.action.line_start)),
        line_end: Math.max(...calls.map((call) => call.call.line_end)),
      },
      calls: calls.map((call) => ({ ...call.call, action: call.action.name })),
      ...(wrapper === undefined
        ? {}
        : {
            wrapper: {
              path: wrapper.path,
              line_start: wrapper.line_start,
              line_end: wrapper.line_end,
            },
          }),
      protocol: entry.protocol,
    });
  }
  return out;
};

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
      const callers = callersOf(ctx, entry);
      out.push(
        flowCandidate({
          probeId: "flow-java-spring-http",
          prefix: "fl-http",
          sha: ctx.sha,
          // The title says where the story STARTS, which the transport stitch
          // moves: a route a module in this subject calls is a browser-to-response
          // narrative, and one nothing here calls is still only reachable from
          // outside. Neither is asserted - `callers` is empty exactly when no
          // caller could be resolved to this exact verb and path.
          title: `${route}, ${callers.length === 0 ? "entry" : "browser"} to terminal`,
          entryTitle: route,
          entryKind: "request",
          entryClaims: [routeClaim],
          callers,
          trace,
        }),
      );
    }
    return out;
  },
};
