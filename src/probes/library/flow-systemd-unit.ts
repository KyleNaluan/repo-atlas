/**
 * The systemd half of a program's story (#35, PR 8, accepted design 5.2).
 *
 * Registered separately from the Java adapters for the reason #5 gives one level
 * up and #6 gives everywhere: "this subject ships no unit files", "it ships units
 * and every one of them starts a program this engine traced", and "it ships a
 * timer whose command this engine could not follow" are three different findings,
 * and silence would make them read alike.
 *
 * What it emits is only half of what it finds, exactly as the TypeScript client
 * adapter does. A unit whose `ExecStart` it can pin becomes a LAUNCH ARROW into
 * the `main` it starts, drawn by `flow-java-cli`, which owns that entry - one
 * story per program, told from what starts it, rather than a second telling
 * competing for #39's budget. What it emits here is the other half: every unit
 * whose program this engine could NOT follow, as an `absent` cut with a
 * kind-tokened reason, because a scheduled job nothing can trace is exactly the
 * absence #6 refuses to communicate by saying nothing.
 *
 * `toolchain` is `any` on purpose. A unit file is not source in any language, so
 * the toolchain test cannot answer for it; the applicability question this
 * adapter has to answer is "does this subject declare unit files at all", and it
 * answers that itself.
 */
import { javaIndex } from "../flow/symbols.js";
import { mainEntries } from "../flow/entries.js";
import { declaredMains, resolveUnits, UNIT_PATH } from "../flow/unit.js";
import { shortHash, slug } from "../id.js";
import type { Candidate, Probe, ProbeContext } from "../types.js";
import type { FlowNode } from "../../schema/types.js";

/**
 * The subject's declared mains, or an empty inventory on a subject with no Java.
 *
 * A units-only subject is a real subject and this adapter still has something
 * true to say about it: every unit it declares runs a program this engine cannot
 * follow, which is a finding rather than a reason to go quiet.
 */
const mainsIn = async (ctx: ProbeContext): Promise<Map<string, { path: string; type: string }>> => {
  if (!ctx.paths.some((path) => path.endsWith(".java"))) return new Map();
  const index = await javaIndex(ctx);
  return declaredMains(index, mainEntries(index));
};

export const flowSystemdUnit: Probe = {
  id: "flow-systemd-unit",
  finds: "one systemd unit stitched to the subject-owned program its ExecStart launches",
  toolchain: "any",
  applies: (ctx) =>
    ctx.paths.some((path) => UNIT_PATH.test(path))
      ? { ok: true }
      : {
          ok: false,
          reason:
            "not applicable to this subject: it declares no systemd unit file, so there is no unit half of a program's story to stitch",
        },
  run: async (ctx) => {
    const { gaps } = resolveUnits(ctx.paths, ctx.read, await mainsIn(ctx));
    return gaps.map((gap): Candidate => {
      const node: FlowNode = {
        type: "flow",
        id: `fl-unit-${slug(gap.unit)}-${shortHash(`${gap.path}#${gap.kind}`)}`,
        title: `${gap.unit} starts a program, unit to terminal`,
        evidence: [
          {
            kind: "file",
            path: gap.path,
            // With no ExecStart there is no directive to point at, so the unit
            // file itself is what was read. Citing a line span that does not
            // exist would be worse than citing the file.
            ...(gap.exec === null
              ? {}
              : { line_start: gap.exec.line_start, line_end: gap.exec.line_end }),
            sha: ctx.sha,
          },
        ],
        confidence: "absent",
        interview_value: 0,
        probe_id: "flow-systemd-unit",
        steps: [],
      };
      return { probe_id: "flow-systemd-unit", node, absent_reason: `${gap.kind}: ${gap.detail}` };
    });
  },
};
