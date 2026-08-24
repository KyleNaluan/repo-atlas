/**
 * One Python program the subject declares it can be started as, traced from its
 * entry function to its terminals (#52).
 *
 * The judgement encoded is `flow-java-cli`'s: a program the subject can be started
 * as is an entry point in its own right, and ftb declares seventeen of them beside
 * fourteen web routes. Two declaration shapes, and both are declarations rather
 * than text - a `[project.scripts]` entry in `pyproject.toml` naming
 * `module:function`, and an `if __name__ == "__main__":` guard whose block calls a
 * function this file declares. The guard is read off the parse tree as an
 * `if_statement`, which is what keeps the seventeen real ones separate from the
 * ones inside docstrings and README fences.
 *
 * Whether anything RUNS the program is a different question and this adapter does
 * not answer it. `flow-java-cli` handles the same shape by titling its Flow "entry
 * to terminal" rather than "unit to terminal", and #52 report 4.3 says to copy that
 * exactly. The launch half is available on ftb - eight `justfile` recipes run
 * `uv run python -m src.live.run_live` - and it is deliberately out of v1: an
 * arrow needs a caller whose derivation the GATE can also perform, and a `just`
 * recipe grammar is its own piece of work with its own gate half, exactly as the
 * systemd reader was for Java.
 *
 * This adapter also carries #52's D1 refusal, and carries it here because it owns
 * the question "how does this subject's code get started". A framework lifecycle
 * callback is a third answer to that question, and the answer v1 gives is a named
 * cut: `class X(Strategy)` plus a method named `on_bar` is the entire declaration,
 * and admitting it would assert that the framework calls the method - a contract
 * the tree does not state, which the confidence contract (#28) forbids. D1 records
 * the v2 proposal - admission on a subject-declared citation such as the
 * `subscribe_bars` inside `on_start` - as deserving its own resolution first.
 */
import { absentCandidate, flowCandidate } from "../flow/candidate.js";
import { pyFrameworkCallbacks, pyProgramEntries } from "../flow/py-entries.js";
import { pythonIndex } from "../flow/py-symbols.js";
import { pyTraceFrom, soleLandmarkTrace } from "../flow/py-trace.js";
import type { Candidate, Probe } from "../types.js";

const PROBE_ID = "flow-python-console-entry";
const PREFIX = "fl-py-cli";

export const flowPythonConsoleEntry: Probe = {
  id: PROBE_ID,
  finds: "one runnable Python entry point traced through typed calls to its durable effects",
  toolchain: "python",
  run: async (ctx) => {
    const index = await pythonIndex(ctx);
    const out: Candidate[] = [];
    for (const entry of pyProgramEntries(index, ctx.read)) {
      const started =
        entry.via === "console_script"
          ? `declared as the \`${entry.script}\` console script`
          : "declared runnable by a __main__ guard";
      out.push(
        flowCandidate({
          probeId: PROBE_ID,
          prefix: PREFIX,
          sha: ctx.sha,
          title: `${entry.type.name}.${entry.method.name} run as a program, entry to terminal`,
          entryTitle: `${entry.type.name}.${entry.method.name}`,
          // No `request` kind: #39 reserves the request/response slot for a
          // verified request signal, and extending that closed classification to
          // a new entry family is its own decision, not this adapter's to take.
          captionFrom: `${entry.type.name}.${entry.method.name}, ${started}`,
          trace: pyTraceFrom(index, entry.type, entry.method),
        }),
      );
    }
    for (const callback of pyFrameworkCallbacks(index)) {
      out.push(
        absentCandidate(
          {
            probeId: PROBE_ID,
            prefix: PREFIX,
            sha: ctx.sha,
            title: `${callback.type.name}.${callback.method.name}, entry not established`,
            entryTitle: `${callback.type.name}.${callback.method.name}`,
            idHint: `callback-${callback.method.name}`,
            trace: soleLandmarkTrace(callback.type, callback.method),
          },
          `framework_callback_unestablished: ${callback.type.path} declares ${callback.type.name}(${callback.base}).${callback.method.name}, and nothing in this subject declares what calls it`,
        ),
      );
    }
    return out;
  },
};
