/**
 * One Spring clock trigger, traced from the method it fires to its terminals
 * (#35, PR 8).
 *
 * The judgement encoded: an execution story does not need an outside caller to
 * be a story. A `@Scheduled` method is reached because the container decided to,
 * and what the tree establishes about that is the annotation - so the annotation
 * is the entry, and everything after it resolves through the same declarations
 * every other adapter walks.
 *
 * It is registered separately from the route, CLI and message adapters because
 * "this subject runs no batch work" is a different finding from "it declares no
 * route", and a run that reported one number for both would hide which (#5, #6).
 * On the reference subject this is exactly the state it reports: Spring is here,
 * the adapter applies, and it finds no clock trigger at all.
 *
 * Two refusals are structural rather than fastidious, and both are the subject's
 * own wiring rather than a heuristic:
 *
 * - A `@Scheduled` method on a type the container does not manage is never
 *   called. Spring reads the annotation off beans, so a plain class carrying one
 *   declares an intention, not an execution.
 * - Spring Boot autoconfigures message listener containers, but it does NOT
 *   enable scheduling. A subject that never writes `@EnableScheduling` runs none
 *   of its `@Scheduled` methods, and a figure drawn from one would assert an
 *   execution that does not happen. The enabling declaration is CITED, not
 *   assumed, so the gate re-resolves it from the blob like everything else.
 */
import { absentCandidate, flowCandidate, type CandidateInput } from "../flow/candidate.js";
import { schedulingEnabledBy, scheduledEntries } from "../flow/entries.js";
import { declaresSpring } from "../flow/stereotype.js";
import { javaIndex } from "../flow/symbols.js";
import { traceFrom } from "../flow/trace.js";
import {
  declaredTrigger,
  ENABLE_SCHEDULING_ANNOTATION,
  SCHEDULED_ANNOTATION,
} from "../flow/trigger.js";
import type { Candidate, FlowClaim, Probe } from "../types.js";

export const flowJavaSpringScheduled: Probe = {
  id: "flow-java-spring-scheduled",
  finds: "one Spring @Scheduled method traced through typed calls to its durable effects",
  toolchain: "java",
  applies: async (ctx) => {
    const index = await javaIndex(ctx);
    return declaresSpring(index.paths, ctx.read)
      ? { ok: true }
      : {
          ok: false,
          reason:
            "not applicable to this subject: no production Java source imports org.springframework, so it declares no Spring clock trigger to trace",
        };
  },
  run: async (ctx) => {
    const index = await javaIndex(ctx);
    const enabler = schedulingEnabledBy(index);
    const out: Candidate[] = [];
    for (const entry of scheduledEntries(index)) {
      const trigger = declaredTrigger(entry.args);
      const input: CandidateInput = {
        probeId: "flow-java-spring-scheduled",
        prefix: "fl-cron",
        sha: ctx.sha,
        title: `${entry.type.name}.${entry.method.name} on a schedule, trigger to terminal`,
        // No `request` kind, deliberately. #39 reserves the request/response
        // archetype for a verified request signal, and a timer firing is not a
        // request; extending that closed set is a decision this adapter does not
        // get to take on its own (PR 4 decision 4, for the same reason).
        entryTitle: `${entry.type.name}, @${SCHEDULED_ANNOTATION}`,
        trace: traceFrom(index, entry.type, entry.method),
      };
      if (!entry.type.bean) {
        out.push(
          absentCandidate(
            input,
            `unmanaged_scheduled_bean: ${entry.type.qualified}.${entry.method.name} carries @${SCHEDULED_ANNOTATION}, but its declaring type carries no Spring stereotype, so the container never reads the annotation`,
          ),
        );
        continue;
      }
      if (trigger === null) {
        out.push(
          absentCandidate(
            input,
            `unresolved_trigger: ${entry.type.qualified}.${entry.method.name} carries @${SCHEDULED_ANNOTATION}${entry.args} , which declares none of cron, fixedDelay or fixedRate, so this reader cannot state when it runs`,
          ),
        );
        continue;
      }
      if (enabler === null) {
        out.push(
          absentCandidate(
            input,
            `scheduling_not_enabled: ${entry.type.qualified}.${entry.method.name} declares @${SCHEDULED_ANNOTATION} ${trigger.attribute} = ${trigger.text}, but no type in this subject declares @${ENABLE_SCHEDULING_ANNOTATION} and Spring Boot does not enable scheduling on its own`,
          ),
        );
        continue;
      }
      // The trigger is a claim about the tree, so the gate re-derives it rather
      // than taking the producer's word: the method's own span carries the
      // annotation, the type header carries the stereotype that makes the
      // container read it, and the enabling declaration is the third thing the
      // figure depends on and the easiest to forget.
      const symbol = {
        path: entry.type.path,
        name: entry.method.name,
        owner: entry.type.qualified,
        arity: entry.method.params.length,
      };
      const triggerClaim: FlowClaim = {
        expect: "present",
        matcher: "scheduled_trigger",
        from: symbol,
        to: symbol,
        trigger: {
          annotation: SCHEDULED_ANNOTATION,
          attribute: trigger.attribute,
          expression: trigger.text,
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
          {
            kind: "file",
            path: enabler.path,
            line_start: enabler.line_start,
            line_end: enabler.header_line_end,
            sha: ctx.sha,
          },
        ],
      };
      out.push(
        flowCandidate({
          ...input,
          entryTitle: `${entry.type.name}, @${SCHEDULED_ANNOTATION} ${trigger.attribute} = ${trigger.text}`,
          entryClaims: [triggerClaim],
        }),
      );
    }
    return out;
  },
};
