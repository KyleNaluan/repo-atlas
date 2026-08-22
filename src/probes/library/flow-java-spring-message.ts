/**
 * One Spring message or event subscription, traced from the method a broker
 * hands a message to (#35, PR 8).
 *
 * The judgement encoded is the same one the scheduled adapter makes and the
 * scope is deliberately narrower than it looks: what the tree establishes is the
 * SUBSCRIPTION - this method is registered against that destination - and not the
 * publisher. A Kafka topic's producer may not be in this subject at all, and even
 * the in-process `@EventListener` case would need a `publishEvent` stitch of its
 * own before an arrow could be drawn into the box. That is the same split PR 4
 * made for the Spring route, which was claimed at caption level until PR 6 had a
 * real caller to draw an arrow from; the publisher stitch is named as a follow-up
 * rather than approximated here.
 *
 * Registered separately from the clock adapter because "this subject consumes no
 * messages" and "this subject runs no batch work" are different findings, which
 * is the whole reason each entry family is its own adapter (#5, #6). On the
 * reference subject this reports the ran-and-found-nothing state: Spring is here,
 * the adapter applies, and no method carries a listener annotation.
 *
 * The one structural refusal: a listener annotation on a type the container does
 * not manage is never registered, so nothing hands that method a message. It is
 * an intention in the tree, not an execution, and it is cut by name.
 */
import { absentCandidate, flowCandidate, type CandidateInput } from "../flow/candidate.js";
import { messageEntries } from "../flow/entries.js";
import { declaresSpring } from "../flow/stereotype.js";
import { javaIndex } from "../flow/symbols.js";
import { traceFrom } from "../flow/trace.js";
import { declaredDestination } from "../flow/trigger.js";
import type { Candidate, FlowClaim, Probe } from "../types.js";

export const flowJavaSpringMessage: Probe = {
  id: "flow-java-spring-message",
  finds: "one Spring message or event listener traced through typed calls to its durable effects",
  toolchain: "java",
  applies: async (ctx) => {
    const index = await javaIndex(ctx);
    return declaresSpring(index.paths, ctx.read)
      ? { ok: true }
      : {
          ok: false,
          reason:
            "not applicable to this subject: no production Java source imports org.springframework, so it declares no listener container for a message entry to arrive through",
        };
  },
  run: async (ctx) => {
    const index = await javaIndex(ctx);
    const out: Candidate[] = [];
    for (const entry of messageEntries(index)) {
      // `@EventListener` names its event in the method's parameter type rather
      // than in an attribute, which is why the parameter is read here: the
      // subscription is what the entry box prints, and a listener whose event
      // this reader cannot name is one whose entry it cannot state.
      const parameterType = entry.method.params[0]?.type ?? null;
      const destination = declaredDestination(entry.annotation, entry.args, parameterType);
      const input: CandidateInput = {
        probeId: "flow-java-spring-message",
        prefix: "fl-msg",
        sha: ctx.sha,
        title: `${entry.type.name}.${entry.method.name} on @${entry.annotation}, message to terminal`,
        // No `request` kind: a message arriving is not a request, and #39's
        // request/response slot is reserved for a verified request signal.
        entryTitle: `${entry.type.name}, @${entry.annotation}`,
        trace: traceFrom(index, entry.type, entry.method),
      };
      if (!entry.type.bean) {
        out.push(
          absentCandidate(
            input,
            `unmanaged_listener_bean: ${entry.type.qualified}.${entry.method.name} carries @${entry.annotation}, but its declaring type carries no Spring stereotype, so no listener container ever registers it`,
          ),
        );
        continue;
      }
      if (destination === null) {
        out.push(
          absentCandidate(
            input,
            `unresolved_destination: ${entry.type.qualified}.${entry.method.name} carries @${entry.annotation}${entry.args}, which names neither a destination attribute nor an event parameter this reader can state`,
          ),
        );
        continue;
      }
      const symbol = {
        path: entry.type.path,
        name: entry.method.name,
        owner: entry.type.qualified,
        arity: entry.method.params.length,
      };
      const listenerClaim: FlowClaim = {
        expect: "present",
        matcher: "message_listener",
        from: symbol,
        to: symbol,
        trigger: {
          annotation: entry.annotation,
          attribute: destination.attribute,
          expression: destination.text,
        },
        evidence: [
          {
            kind: "file",
            path: entry.type.path,
            line_start: entry.type.line_start,
            line_end: entry.type.header_line_end,
            sha: ctx.sha,
          },
          {
            kind: "file",
            path: entry.type.path,
            line_start: entry.method.line_start,
            line_end: entry.method.line_end,
            sha: ctx.sha,
          },
        ],
      };
      out.push(
        flowCandidate({
          ...input,
          entryTitle: `${entry.type.name}, @${entry.annotation} ${destination.attribute} = ${destination.text}`,
          entryClaims: [listenerClaim],
        }),
      );
    }
    return out;
  },
};
