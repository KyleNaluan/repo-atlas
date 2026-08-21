/** Flow-specific advisory mutant: the arrow says execute, its citation says cancel. */
import type { FlowNode } from "../../src/schema/types.js";

export const STALE_FLOW_LINK: FlowNode = {
  type: "flow",
  id: "fl-stale-model-mutant",
  title: "a stale link",
  caption: "A request crosses one service seam.",
  evidence: [],
  confidence: "verified",
  interview_value: 4,
  steps: [
    {
      id: "caller",
      node: "Caller.run",
      detail: "starts the operation",
      evidence: { kind: "command", cmd: "show caller", output_excerpt: "Caller.run" },
    },
    {
      id: "target",
      node: "Target.execute",
      detail: "finishes the operation",
      evidence: { kind: "command", cmd: "show target", output_excerpt: "Target.execute" },
    },
  ],
  links: [
    {
      id: "caller-target",
      from: "caller",
      to: "target",
      relation: "call",
      label: "execute()",
      evidence: [{ kind: "command", cmd: "show call", output_excerpt: "caller.cancel()" }],
    },
  ],
};
