/**
 * `repo-atlas probe --harvest <harvest.json> --clone <path> -o candidates.json`
 * `repo-atlas gate  --candidates <candidates.json> --clone <path> -o gated.json`
 *
 * Probes propose; the gate confirms; the rank stage accepts or deletes. Neither
 * of these commands decides what survives (#2, #5).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROBES, runProbes, treeContext } from "../probes/registry.js";
import { gate } from "../gate/gate.js";
import type { Candidate, ProbeOutcome } from "../probes/types.js";
import type { Harvest } from "../harvest/types.js";

const flag = (argv: string[], ...names: string[]): string | undefined => {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};

const PROBE_USAGE = `usage: repo-atlas probe --harvest <harvest.json> --clone <path> [-o <candidates.json>]

Runs the probe library over a harvest and a local clone at the pinned SHA, and
emits candidate nodes. Probes are pure deterministic functions: no network, no
model calls. A probe that finds nothing emits nothing; a probe that does not
apply to this subject's toolchain says so by name rather than passing silently.`;

const GATE_USAGE = `usage: repo-atlas gate --candidates <candidates.json> --clone <path> [-o <gated.json>]

Resolves each candidate's claims against the tree at the pinned SHA. The gate
overturns the record in BOTH directions: a stated decision is not evidence of
implementation, and an open ticket is not evidence of absence. A confirmed
contradiction becomes a divergence edge rather than being dropped.`;

export interface CandidateFile {
  subject_sha: string;
  outcomes: ProbeOutcome[];
}

export const probeCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(PROBE_USAGE);
    return 0;
  }
  const harvestPath = flag(argv, "--harvest");
  const clone = flag(argv, "--clone");
  if (harvestPath === undefined || clone === undefined) {
    console.error(PROBE_USAGE);
    return 64;
  }
  const harvest = JSON.parse(readFileSync(harvestPath, "utf8")) as Harvest;
  const ctx = treeContext(harvest, resolve(clone));
  const outcomes = await runProbes(ctx);

  const output = resolve(flag(argv, "-o", "--out") ?? "out/candidates.json");
  mkdirSync(dirname(output), { recursive: true });
  const file: CandidateFile = { subject_sha: harvest.subject.sha, outcomes };
  writeFileSync(output, `${JSON.stringify(file, null, 2)}\n`, "utf8");

  const ran = outcomes.filter((o) => o.status === "ran");
  const total = ran.reduce((sum, o) => sum + (o.status === "ran" ? o.candidates.length : 0), 0);
  console.log(`probed ${harvest.subject.owner}/${harvest.subject.repo} at ${harvest.subject.sha} -> ${output}`);
  console.log(`  ${PROBES.length} probes: ${ran.length} ran, ${outcomes.length - ran.length} not applicable`);
  for (const o of outcomes) {
    console.log(
      o.status === "ran"
        ? `  ran   ${o.probe_id.padEnd(28)} ${o.candidates.length} candidate${o.candidates.length === 1 ? "" : "s"}`
        : `  n/a   ${o.probe_id.padEnd(28)} ${o.reason}`,
    );
  }
  console.log(`  ${total} candidate${total === 1 ? "" : "s"} for the gate`);
  return 0;
};

export const gateCommand = async (argv: string[]): Promise<number> => {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(GATE_USAGE);
    return 0;
  }
  const candidatesPath = flag(argv, "--candidates");
  const harvestPath = flag(argv, "--harvest");
  const clone = flag(argv, "--clone");
  if (candidatesPath === undefined || harvestPath === undefined || clone === undefined) {
    console.error(GATE_USAGE);
    return 64;
  }
  const file = JSON.parse(readFileSync(candidatesPath, "utf8")) as CandidateFile;
  const harvest = JSON.parse(readFileSync(harvestPath, "utf8")) as Harvest;
  const ctx = treeContext(harvest, resolve(clone));

  const candidates: Candidate[] = file.outcomes.flatMap((o) =>
    o.status === "ran" ? o.candidates : [],
  );
  const gated = gate(ctx, candidates);

  const output = resolve(flag(argv, "-o", "--out") ?? "out/gated.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ subject_sha: harvest.subject.sha, gated }, null, 2)}\n`, "utf8");

  const by = (v: string) => gated.filter((g) => g.verdict === v).length;
  console.log(`gated ${candidates.length} candidates at ${harvest.subject.sha} -> ${output}`);
  console.log(`  confirmed  ${by("confirmed")}`);
  console.log(`  overturned ${by("overturned")} (the record and the tree disagree; kept as divergence edges)`);
  console.log(`  unresolved ${by("unresolved")} (nothing in the tree settles it; demoted, never admitted as checked)`);
  for (const g of gated.filter((x) => x.verdict !== "confirmed")) {
    console.log(`  ${g.verdict.padEnd(10)} ${g.probe_id}: ${g.finding}`);
  }
  return 0;
};
