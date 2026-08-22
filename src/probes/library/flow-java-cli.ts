/**
 * One real Java `main`, traced from its declaration to its terminals.
 *
 * The judgement encoded: a program the subject can be started as is an entry
 * point in its own right, and the reference subject has two of them next to
 * thirteen web controllers. It is registered as its own adapter because "this
 * subject ships no runnable main" and "this subject ships no Spring" are
 * different facts, and a run that reported one number for both would hide which.
 *
 * The signature is checked against the declaration rather than matched in text:
 * a raw `main` scan over the reference subject reported four entry points where
 * two exist, because two generated harnesses carry a `main` inside a Java text
 * block. That measurement is the reason this adapter parses.
 *
 * PR 8 adds the other half of the story: what STARTS the program. A `.service`
 * unit whose `ExecStart` names a fully-qualified class this subject declares a
 * main for becomes a launch arrow into this Flow, drawn by the adapter that owns
 * the entry - exactly as PR 6 draws a TypeScript caller into the route adapter's
 * Flow rather than emitting a second telling of the same story. A unit this
 * engine could not follow is `flow-systemd-unit`'s named cut, never a silence.
 */
import { flowCandidate } from "../flow/candidate.js";
import { mainEntries } from "../flow/entries.js";
import { javaIndex } from "../flow/symbols.js";
import { traceFrom } from "../flow/trace.js";
import { declaredMains, resolveUnits } from "../flow/unit.js";
import type { Candidate, Probe } from "../types.js";

export const flowJavaCli: Probe = {
  id: "flow-java-cli",
  finds: "one runnable Java entry point traced through typed calls to its durable effects",
  toolchain: "java",
  run: async (ctx) => {
    const index = await javaIndex(ctx);
    const entries = mainEntries(index);
    // The launch half. `resolveUnits` is the one definition of what a unit
    // launches, shared with the systemd adapter and with the gate; the split
    // between the two adapters is the same as the HTTP one - the entry's owner
    // draws the arrow, and the other side reports only what it could not stitch.
    const { launches } = resolveUnits(ctx.paths, ctx.read, declaredMains(index, entries));
    const out: Candidate[] = [];
    for (const entry of entries) {
      const starting = launches.filter(
        (candidate) =>
          candidate.entry.path === entry.type.path && candidate.entry.type === entry.type.qualified,
      );
      out.push(
        flowCandidate({
          probeId: "flow-java-cli",
          prefix: "fl-cli",
          sha: ctx.sha,
          title: `${entry.type.name} run as a program, ${starting.length === 0 ? "entry" : "unit"} to terminal`,
          entryTitle: entry.type.name,
          // No `request` kind: #39 reserves the request/response slot for a
          // verified request signal, and extending that closed classification to
          // a new entry family is its own decision, not this adapter's to take.
          // A launch arrow does not change that - a timer starting a program is
          // not a request either, which is why it carries no request kind.
          // Every unit that starts this program, not the first one found: a
          // program two units start is two arrows into one story, and picking one
          // would drop the other in silence.
          launchers: starting.map((launch) => ({
            unit: launch.unit,
            path: launch.path,
            exec: launch.exec,
            target: launch.target,
          })),
          trace: traceFrom(index, entry.type, entry.method),
        }),
      );
    }
    return out;
  },
};
