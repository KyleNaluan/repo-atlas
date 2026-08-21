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
 * Classify only from graph structure. New shared-state Flows carry read fan-out;
 * the legacy bridge recognises the reference fixture's three-way fan-out when no
 * request signal exists. Every other currently-supported Flow belongs to the
 * request/response slot. Later adapter families can extend this closed mapping
 * when their own budget decision lands.
 */
export const flowArchetype = (flow: FlowNode): FlowArchetype => {
  const links = topologyLinks(flow);
  const requestSignal =
    flow.steps.some((step) => step.kind === "request") ||
    links.some((link) => link.kind === "request" || link.relation === "transport");
  const fanOut = new Map<string, TopologyLink[]>();
  for (const link of links) fanOut.set(link.from, [...(fanOut.get(link.from) ?? []), link]);
  const readFanOut = [...fanOut.values()].some(
    (outgoing) => outgoing.length >= 2 && outgoing.every((link) => link.relation === "read"),
  );
  const legacyThreeWayFanOut =
    flow.links === undefined &&
    !requestSignal &&
    [...fanOut.values()].some((outgoing) => outgoing.length >= 3);
  return readFanOut || legacyThreeWayFanOut ? "shared_state_lineage" : "request_response";
};

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
    entry_kind: archetype === "shared_state_lineage" ? "durable_shared_state" : "request",
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
