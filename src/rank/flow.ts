/**
 * Mechanical Flow shape facts shared by scoring and ranking.
 *
 * The scorer needs enough of the verified graph to judge interview value, while
 * rank needs to keep the two complementary slots #39 chose from collapsing into
 * two near-identical request routes. Neither operation reads evidence: evidence
 * is settled by the gate, and ranking may only describe the topology it receives.
 */
import type { FlowNode, FlowRelation, FlowStep } from "../schema/types.js";

export type FlowArchetype = "request_response" | "shared_state_lineage";

/**
 * A Flow's classification for scoring and slotting. The two `FlowArchetype`
 * values are the preferred slots #39 reserves; `unknown` is a Flow whose entry
 * neither slot describes - a raw call graph, or one of PR 8's caller-less entry
 * families. It may claim neither preferred slot, and the score projection carries
 * the reason by name rather than leaving "unknown" to be interpreted.
 */
export type FlowClass = FlowArchetype | "unknown";

interface TopologyLink {
  from: string;
  to: string;
  relation: FlowRelation | "legacy";
  kind?: FlowStep["kind"];
  label?: string;
}

const topologyLinks = (flow: FlowNode): TopologyLink[] => {
  if (flow.links !== undefined) {
    return flow.links.map((link) => ({
      from: link.from,
      to: link.to,
      relation: link.relation,
      ...(link.kind === undefined ? {} : { kind: link.kind }),
      ...(link.label === undefined ? {} : { label: link.label }),
    }));
  }

  return flow.steps.flatMap((step) =>
    (step.calls_next ?? []).map((to) => ({
      from: step.id,
      to,
      relation: "legacy" as const,
      ...(step.kind === undefined ? {} : { kind: step.kind }),
      ...(step.edge_label === undefined ? {} : { label: step.edge_label }),
    })),
  );
};

const rootsAndTerminals = (flow: FlowNode, links: TopologyLink[]) => {
  const incoming = new Set(links.map((link) => link.to));
  const outgoing = new Set(links.map((link) => link.from));
  const project = (step: FlowStep) => ({
    id: step.id,
    title: step.node,
    ...(step.kind === undefined ? {} : { kind: step.kind }),
  });
  return {
    roots: flow.steps.filter((step) => !incoming.has(step.id)).map(project),
    terminals: flow.steps.filter((step) => !outgoing.has(step.id)).map(project),
  };
};

/**
 * Classify only from graph structure. A request signal takes precedence: a Flow
 * with an HTTP/request entry is request/response even when it also fans out over
 * shared state, so the lineage slot is reserved for Flows whose story is the
 * lineage itself. Absent a request signal, a read fan-out (or the legacy bridge's
 * three-way reference fan-out) marks shared-state lineage.
 *
 * What is left has no verified entry signal. A legacy `calls_next` Flow is the
 * reference submission-walkthrough shape, so the legacy bridge still reads it as
 * request/response. But a modern links-based Flow with neither a request signal
 * nor a read fan-out - a raw call graph, or an entry family this closed set has
 * no slot for - shows no entry the topology supports, so it is `unknown` rather
 * than a default request: it may not claim an entry kind the evidence does not
 * establish. Rank then lets it fill only Flow-section capacity the two preferred
 * archetypes leave genuinely open, and never displace one.
 *
 * The request signal is the `request` KIND, not the `transport` relation (#35,
 * PR 8). Those were the same thing while HTTP was the only boundary a Flow
 * crossed; a systemd unit launching a program crosses one too, and a timer
 * firing is not a request. Reading the relation as a request signal would have
 * given a cron job the request/response slot #39 reserves for a verified request
 * signal - which is why the producer stamps `kind: "request"` on an HTTP
 * transport arrow and leaves a launch arrow without one.
 */
export const flowArchetype = (flow: FlowNode): FlowClass => {
  const links = topologyLinks(flow);
  const requestSignal =
    flow.steps.some((step) => step.kind === "request") ||
    links.some((link) => link.kind === "request");
  const fanOut = new Map<string, TopologyLink[]>();
  for (const link of links) fanOut.set(link.from, [...(fanOut.get(link.from) ?? []), link]);
  const readFanOut =
    !requestSignal &&
    [...fanOut.values()].some(
      (outgoing) => outgoing.length >= 2 && outgoing.every((link) => link.relation === "read"),
    );
  const legacyThreeWayFanOut =
    flow.links === undefined &&
    !requestSignal &&
    [...fanOut.values()].some((outgoing) => outgoing.length >= 3);
  if (readFanOut || legacyThreeWayFanOut) return "shared_state_lineage";
  if (requestSignal) return "request_response";
  return flow.links === undefined ? "request_response" : "unknown";
};

/** The scorer-facing entry label for each class; `unknown` asserts no entry. */
const ENTRY_KIND: Record<FlowClass, string> = {
  request_response: "request",
  shared_state_lineage: "durable_shared_state",
  unknown: "unknown",
};

/**
 * Why a Flow is unclassified, said rather than left blank (#35, PR 8).
 *
 * `unknown` is not one thing. A raw call graph is unclassified because its
 * topology shows no entry at all; a clock trigger, a message subscription and a
 * unit launch are unclassified because #39's archetype set is CLOSED at two and
 * none of them is a request - a different fact, and one a reader of the score
 * projection should not have to infer from a bare "unknown". Extending that set
 * is a budget decision, not a classifier's to take, so the honest move is to name
 * the reason. Both branches are read off the same topology the classifier used.
 */
const unclassifiedReason = (flow: FlowNode, links: TopologyLink[]): string =>
  links.some((link) => link.relation === "transport")
    ? "the Flow crosses a process boundary that is not a request, so it claims neither of the two archetypes reserved by the Flow budget"
    : flow.steps.length > 1
      ? "no request signal and no read fan-out in the topology: the entry family this Flow starts from has no slot in the closed archetype set"
      : "the topology carries no entry signal at all";

const BOUNDARY_RELATIONS = new Set<FlowRelation>([
  "transport",
  "dispatch",
  "read",
  "write",
  "side_effect",
]);

/** The evidence-free Flow projection handed to the comparative model scorer. */
export const flowScoringProjection = (flow: FlowNode): Record<string, unknown> => {
  const links = topologyLinks(flow);
  const { roots, terminals } = rootsAndTerminals(flow, links);
  const archetype = flowArchetype(flow);
  const boundaryLinks = links.filter(
    (link) => link.relation !== "legacy" && BOUNDARY_RELATIONS.has(link.relation),
  );
  return {
    caption: flow.caption ?? "",
    archetype,
    entry_kind: ENTRY_KIND[archetype],
    ...(archetype === "unknown" ? { unclassified_reason: unclassifiedReason(flow, links) } : {}),
    steps: flow.steps.map((step) => ({
      id: step.id,
      title: step.node,
      ...(step.detail === undefined ? {} : { detail: step.detail }),
      ...(step.kind === undefined ? {} : { kind: step.kind }),
    })),
    links,
    roots,
    terminals,
    architectural_boundaries: {
      count: boundaryLinks.length,
      relations: [...new Set(boundaryLinks.map((link) => link.relation))],
    },
  };
};
