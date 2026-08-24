/**
 * One declared LangGraph topology, drawn as the Flow it is (#52, D2).
 *
 * The judgement encoded is the one D2 settles, and it is worth stating plainly
 * because the arrows are not calls. `graph.add_edge("sweep", "investigate")` says
 * the framework will run `investigate` after `sweep`; no line of subject code
 * calls `investigate`. D2's answer is that this IS a Flow - it has an entry, steps
 * and terminals, which is what a Flow is - expressed through one new gate matcher
 * that carries the distinction while the relation stays `call` at the schema
 * level. The precedent is `process_launch`, which also draws an arrow whose source
 * is not subject code.
 *
 * The reason it is not optional on the dsa subject is #52 report 4.4: EVERY
 * execution path there funnels through `compiled.invoke(...)` where `compiled`
 * comes from `build_graph(...) -> Any`, so the atomic rule quarantines the CLI
 * story and every route that reaches it. The pipeline a reader actually wants to
 * see is declared, in literals, ten lines apart - and reading that declaration is
 * both the honest way to recover it and MORE re-derivable than a call trace, not
 * less.
 *
 * A component here is a NODE, not the module: the topology declares nodes as its
 * parts, and "a component is what the subject declares itself to have" is the same
 * rule that makes a module a box in the other two adapters. So each registered
 * `def` gets its own pseudo-type and its own box, and the figure is the topology.
 *
 * What is deliberately NOT traced is what happens INSIDE a node. That is a
 * different story - the tracer's - and on this subject it is a quarantine, because
 * the node bodies are pandas-heavy and largely unannotated. Folding it in would
 * mean either losing the topology or asserting a chain nothing established.
 */
import { absentCandidate, flowCandidate } from "../flow/candidate.js";
import { pyPipelines, type PyPipeline } from "../flow/py-entries.js";
import { declaresLangGraph } from "../flow/py-framework.js";
import { pythonIndex } from "../flow/py-symbols.js";
import { soleLandmarkTrace } from "../flow/py-trace.js";
import { methodKey, type TraceEdge, type TraceLandmark, type TraceResult } from "../flow/trace.js";
import type { MethodSymbol, TypeSymbol } from "../flow/symbols.js";
import type { Candidate, FlowClaim, Probe } from "../types.js";

const PROBE_ID = "flow-python-langgraph-pipeline";
const PREFIX = "fl-py-graph";

/**
 * One registered node, projected into the type shape a rendered box is read
 * through.
 *
 * The module pseudo-type the other two adapters use would collapse all five nodes
 * into one box, because `candidate.ts` draws one box per TYPE. Here the node IS
 * the component the subject declares, so it gets its own.
 */
const nodePseudoType = (path: string, method: MethodSymbol): TypeSymbol => ({
  name: method.name,
  qualified: method.name,
  path,
  kind: "class",
  modifiers: [],
  supertypes: new Set<string>(),
  annotations: [],
  fields: new Map(),
  fieldsDeclared: new Map(),
  bean: true,
  methods: [method],
  line_start: method.line_start,
  header_line_end: method.line_start,
  line_end: method.line_end,
});

/**
 * The declared topology as a `TraceResult`, so the language-neutral candidate
 * emitter draws it.
 *
 * There is no walk here and there is nothing to gap on: every box is a registered
 * node and every arrow is a declared edge. The atomic rule still holds and is
 * still what matters - a topology naming a key nothing registered, or an edge
 * whose endpoints are not both literals, never reaches this function at all; it is
 * a named cut in `pyPipelines`.
 */
const topologyTrace = (pipeline: PyPipeline): TraceResult | null => {
  const byKey = new Map<string, { type: TypeSymbol; method: MethodSymbol }>();
  const landmarks = new Map<string, TraceLandmark>();
  for (const node of pipeline.nodes) {
    const type = nodePseudoType(pipeline.type.path, node.method);
    const key = methodKey(type, node.method);
    byKey.set(node.key, { type, method: node.method });
    landmarks.set(key, { key, type, method: node.method });
  }
  const entry = byKey.get(pipeline.entryKey);
  if (entry === undefined) return null;
  const edges: TraceEdge[] = pipeline.edges.map((edge) => {
    const from = byKey.get(edge.from)!;
    const to = byKey.get(edge.to)!;
    return {
      from: methodKey(from.type, from.method),
      to: methodKey(to.type, to.method),
      relation: "call" as const,
      label: `add_edge("${edge.from}", "${edge.to}")`,
      path: edge.span.path,
      line_start: edge.span.line_start,
      line_end: edge.span.line_end,
      inReturn: false,
      heldReceiver: false,
      pipeline: { fromKey: edge.from, toKey: edge.to },
      // The two registrations are half of what the arrow asserts: an edge between
      // keys nothing registered is an edge between nothing. Cited for the same
      // reason a dispatch arrow cites its guard.
      cites: [
        pipeline.nodes.find((node) => node.key === edge.from)!.registration,
        pipeline.nodes.find((node) => node.key === edge.to)!.registration,
      ],
    };
  });
  const terminals = new Set(
    pipeline.terminalKeys
      .map((key) => byKey.get(key))
      .filter((node): node is { type: TypeSymbol; method: MethodSymbol } => node !== undefined)
      .map((node) => methodKey(node.type, node.method)),
  );
  return {
    entry: methodKey(entry.type, entry.method),
    landmarks,
    edges,
    terminals,
    gaps: [],
    cyclesCut: 0,
    cycleAt: new Set(),
  };
};

export const flowPythonLanggraphPipeline: Probe = {
  id: PROBE_ID,
  finds: "one LangGraph pipeline the subject declares in literals, drawn as the execution story it declares",
  toolchain: "python",
  applies: async (ctx) => {
    const index = await pythonIndex(ctx);
    return declaresLangGraph(index.paths, ctx.read)
      ? { ok: true }
      : {
          ok: false,
          reason:
            "not applicable to this subject: no production Python source imports langgraph, so it declares no graph topology to read",
        };
  },
  run: async (ctx) => {
    const index = await pythonIndex(ctx);
    const { pipelines, cuts } = pyPipelines(index);
    const out: Candidate[] = [];
    for (const pipeline of pipelines) {
      const trace = topologyTrace(pipeline);
      if (trace === null) continue;
      const entryNode = pipeline.nodes.find((node) => node.key === pipeline.entryKey)!;
      const entrySymbol = {
        path: pipeline.type.path,
        name: entryNode.method.name,
        owner: entryNode.method.name,
      };
      // The entry is a claim about the topology, not about a call, so it attaches
      // to no arrow: nothing in the tree calls the first node, which is exactly
      // why the declaration that names it has to be re-resolved on its own.
      const entryClaim: FlowClaim = {
        expect: "present",
        matcher: "declared_pipeline",
        from: entrySymbol,
        to: entrySymbol,
        pipeline: { entry_key: pipeline.entryKey },
        evidence: [
          {
            kind: "file",
            path: pipeline.entrySpan.path,
            line_start: pipeline.entrySpan.line_start,
            line_end: pipeline.entrySpan.line_end,
            sha: ctx.sha,
          },
          {
            kind: "file",
            path: entryNode.registration.path,
            line_start: entryNode.registration.line_start,
            line_end: entryNode.registration.line_end,
            sha: ctx.sha,
          },
        ],
      };
      out.push(
        flowCandidate({
          probeId: PROBE_ID,
          prefix: PREFIX,
          sha: ctx.sha,
          title: `${pipeline.builder.name}, declared pipeline entry to terminal`,
          entryTitle: pipeline.entryKey,
          // No `request` kind: a declared topology carries no request signal, so
          // #39 classifies it `unknown` and it may fill only Flow capacity the two
          // preferred archetypes leave open - the same treatment PR 8 gave the
          // clock, message and unit families.
          entryClaims: [entryClaim],
          captionFrom: `the ${pipeline.nodes.length}-node topology ${pipeline.type.path} declares in ${pipeline.builder.name}`,
          trace,
        }),
      );
    }
    for (const cut of cuts) {
      out.push(
        absentCandidate(
          {
            probeId: PROBE_ID,
            prefix: PREFIX,
            sha: ctx.sha,
            title: `${cut.method.name}, declared pipeline not established`,
            entryTitle: cut.method.name,
            idHint: `pipeline-cut-${cut.method.name}`,
            trace: soleLandmarkTrace(cut.type, cut.method),
          },
          cut.reason,
        ),
      );
    }
    return out;
  },
};
