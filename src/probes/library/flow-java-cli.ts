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
 */
import { flowCandidate } from "../flow/candidate.js";
import { mainEntries } from "../flow/entries.js";
import { javaIndex } from "../flow/symbols.js";
import { traceFrom } from "../flow/trace.js";
import type { Candidate, Probe } from "../types.js";

export const flowJavaCli: Probe = {
  id: "flow-java-cli",
  finds: "one runnable Java entry point traced through typed calls to its durable effects",
  toolchain: "java",
  run: async (ctx) => {
    const index = await javaIndex(ctx);
    const out: Candidate[] = [];
    for (const entry of mainEntries(index)) {
      out.push(
        flowCandidate({
          probeId: "flow-java-cli",
          prefix: "fl-cli",
          sha: ctx.sha,
          title: `${entry.type.name} run as a program, entry to terminal`,
          entryTitle: entry.type.name,
          // No `request` kind: #39 reserves the request/response slot for a
          // verified request signal, and extending that closed classification to
          // a new entry family is its own decision, not this adapter's to take.
          trace: traceFrom(index, entry.type, entry.method),
        }),
      );
    }
    return out;
  },
};
