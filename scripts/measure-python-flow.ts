/**
 * Measure what the Python Flow producer yields on one subject, and print the
 * fixture `test/run/parity.test.ts` asserts (#52, D5).
 *
 * The Java producer is measured against a pinned subject with a regenerating
 * command, and #52's D5 pins BOTH Python subjects because they test different
 * halves: futures-trading-bot exercises the tracer, and data-science-agent
 * exercises the declared-pipeline adapter, which nothing else reaches. The cost is
 * one extra fixture and one extra clone; the alternative is that half the adapter
 * has no parity test.
 *
 * ftb is private, so its fixture is self-contained committed JSON and regenerating
 * it requires access - the same constraint the Java fixture already carries, since
 * that one needs a swe-prep clone.
 *
 *   npx tsx scripts/measure-python-flow.ts <clone> > test/fixtures/<name>.flow-producer.json
 *
 * Nothing here reaches a model or the network: it drives the real registered
 * adapters and the real gate over a local clone at its own HEAD.
 */
import { execFileSync } from "node:child_process";
import { gateFlowCandidate } from "../src/gate/flow.js";
import { pyHttpEntries, pyFrameworkCallbacks, pyPipelines, pyProgramEntries } from "../src/probes/flow/py-entries.js";
import { pythonIndex } from "../src/probes/flow/py-symbols.js";
import { PROBES, treeContext } from "../src/probes/registry.js";
import { clampConfidenceToReading, type ProbeContext } from "../src/probes/types.js";
import { flowArchetype } from "../src/rank/flow.js";
import { narrativeDepth } from "../src/render/diagram.js";
import type { Harvest } from "../src/harvest/types.js";
import type { FlowNode } from "../src/schema/types.js";

const clone = process.argv[2];
if (clone === undefined) {
  console.error("usage: measure-python-flow <clone path>");
  process.exit(2);
}
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
const ctx: ProbeContext = treeContext(
  { subject: { sha } } as unknown as Harvest,
  clone,
);

const index = await pythonIndex(ctx);
const http = pyHttpEntries(index);
const pipelines = pyPipelines(index);

interface Verified {
  title: string;
  steps: number;
  links: number;
  narrative_depth: number;
  archetype: string;
  components: string[];
}

const adapters: Record<string, unknown>[] = [];
let verifiedTotal = 0;
let candidateTotal = 0;
for (const probe of PROBES.filter((p) => p.id.startsWith("flow-python"))) {
  const applies = probe.applies ? await probe.applies(ctx) : { ok: true as const };
  if (!applies.ok) {
    adapters.push({ probe_id: probe.id, status: "not_applicable", reason: applies.reason });
    continue;
  }
  const candidates = clampConfidenceToReading(probe, await probe.run(ctx));
  const verified: Verified[] = [];
  const cut: Record<string, number> = {};
  const overturned: string[] = [];
  for (const candidate of candidates) {
    const flow = candidate.node as FlowNode;
    const result = gateFlowCandidate(ctx, candidate);
    if (result.verdict === "confirmed") {
      verified.push({
        title: flow.title,
        steps: flow.steps.length,
        links: flow.links?.length ?? 0,
        narrative_depth: narrativeDepth(flow),
        archetype: flowArchetype(flow),
        components: flow.steps.map((step) => step.node),
      });
      continue;
    }
    // A candidate the PRODUCER proposed absent carries its own kind token; one the
    // GATE overturned is a producer/gate disagreement and is listed in full,
    // because that is the number the whole "resolves no further than the gate can
    // re-resolve" rule exists to keep at zero.
    if (candidate.absent_reason !== undefined) {
      const kind = candidate.absent_reason.split(":")[0]!;
      cut[kind] = (cut[kind] ?? 0) + 1;
      continue;
    }
    overturned.push(`${flow.title}: ${result.finding}`);
  }
  verifiedTotal += verified.length;
  candidateTotal += candidates.length;
  adapters.push({
    probe_id: probe.id,
    status: "ran",
    candidates: candidates.length,
    verified_by_the_gate: verified.sort((a, b) => a.title.localeCompare(b.title)),
    cut_by_reason: Object.fromEntries(Object.entries(cut).sort()),
    overturned_by_the_gate: overturned.sort(),
  });
}

console.log(
  JSON.stringify(
    {
      note: "What the Python Flow producer yields on this subject, measured rather than asserted (#52, D5).",
      regenerate: `npx tsx scripts/measure-python-flow.ts <clone> > test/fixtures/<subject>.flow-producer.json`,
      subject_sha: sha,
      entry_inventory: {
        production_python_files: index.paths.length,
        modules: index.modules.size,
        classes: [...index.classesByPath.values()].flat().length,
        fastapi_routes_with_a_literal_path: http.entries.length,
        fastapi_routes_refused: http.cuts.length,
        program_entries: pyProgramEntries(index, ctx.read).length,
        declared_langgraph_topologies: pipelines.pipelines.length,
        declared_langgraph_topologies_refused: pipelines.cuts.length,
        framework_callbacks_refused: pyFrameworkCallbacks(index).length,
      },
      survival: {
        candidates: candidateTotal,
        verified_by_the_gate: verifiedTotal,
        overturned_by_the_gate: adapters.reduce(
          (total, adapter) => total + ((adapter["overturned_by_the_gate"] as string[] | undefined)?.length ?? 0),
          0,
        ),
      },
      adapters,
    },
    null,
    2,
  ),
);
