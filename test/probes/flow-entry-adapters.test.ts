/**
 * The three entry families that have no caller in the tree (#35, accepted design
 * section 9, PR 8): a clock, a broker, and a systemd unit.
 *
 * Every adapter here is exercised in the five states PR 8 requires of each -
 * NOT APPLICABLE, RAN EMPTY, COMPLETE, AMBIGUOUS, and BOUND EXCEEDED - plus the
 * gate-disagreement mutant for each new claim kind, which is the only assertion
 * that proves the gate re-resolves rather than echoes. The five are named in the
 * describe blocks below rather than left implicit, because the whole reason each
 * family is its own adapter is that those states must stay distinguishable in the
 * run's own report (#5, #6).
 *
 * The fixtures are real trees at real SHAs, as everywhere else in this suite: the
 * producer walks a parse index and the gate rereads the pinned blob, so a
 * hand-written candidate would exercise neither half of the guarantee.
 */
import { describe, expect, it } from "vitest";
import { runProbes } from "../../src/probes/registry.js";
import { contextFor, only, runAdapter } from "./flow-subject.js";
import { gateCandidate } from "../../src/gate/gate.js";
import { flowArchetype } from "../../src/rank/flow.js";
import { presentTenseClaims, resolveFileEvidence } from "../../src/audit/checks/evidence.js";
import { execStart, launchClassTokens } from "../../src/probes/flow/unit.js";
import type { Candidate, ProbeOutcome } from "../../src/probes/types.js";
import type { Atlas, FlowNode } from "../../src/schema/types.js";

/* ---------------------------------------------------------- fixtures */

const REPOSITORY = `package app.batch;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface CueRepository extends JpaRepository<String, String> {
  void saveCue(String day);
}
`;

const ENABLED = `package app.batch;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

@Configuration
@EnableScheduling
public class BatchConfig {
}
`;

const scheduledJob = (annotation: string) => `package app.batch;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class DailyCueJob {
  private final CueRepository cues;

  DailyCueJob(CueRepository cues) {
    this.cues = cues;
  }

  ${annotation}
  public void fire() {
    cues.saveCue("today");
  }
}
`;

/** The complete state: a bean, an enabled scheduler, and a trigger that reads. */
const SCHEDULED: Record<string, string> = {
  "src/main/java/app/batch/CueRepository.java": REPOSITORY,
  "src/main/java/app/batch/BatchConfig.java": ENABLED,
  "src/main/java/app/batch/DailyCueJob.java": scheduledJob('@Scheduled(cron = "0 0 9 * * *")'),
};

const listener = (annotation: string, params: string) => `package app.batch;

import org.springframework.context.event.EventListener;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;

@Service
public class CueListener {
  private final CueRepository cues;

  CueListener(CueRepository cues) {
    this.cues = cues;
  }

  ${annotation}
  public void onCue(${params}) {
    cues.saveCue("today");
  }
}
`;

const KAFKA: Record<string, string> = {
  "src/main/java/app/batch/CueRepository.java": REPOSITORY,
  "src/main/java/app/batch/CueListener.java": listener(
    '@KafkaListener(topics = "cue.raised")',
    "String payload",
  ),
};

const CLI_TOOL = `package app.cli;

public class Tool {
  static app.batch.CueRepository CUES;

  public static void main(String[] args) {
    CUES.saveCue(args[0]);
  }
}
`;

const unitFile = (exec: string) => `[Unit]
Description=the daily cue
# ExecStart=app.decoy.NotThis - a comment is not a directive
After=network-online.target

[Service]
Type=oneshot
${exec}
`;

/** The complete state: a unit whose ExecStart names a class this subject declares. */
const LAUNCHED: Record<string, string> = {
  "src/main/java/app/batch/CueRepository.java": REPOSITORY,
  "src/main/java/app/cli/Tool.java": CLI_TOOL,
  "deploy/cue.service": unitFile("ExecStart=/usr/bin/java -cp /opt/app.jar app.cli.Tool --once"),
};

const absentReason = (candidate: Candidate): string => {
  expect(candidate.node.confidence).toBe("absent");
  expect((candidate.node as FlowNode).steps).toHaveLength(0);
  return candidate.absent_reason ?? "";
};

const outcomeFor = (outcomes: ProbeOutcome[], id: string): ProbeOutcome =>
  outcomes.find((o) => o.probe_id === id)!;

const repinned = (candidate: Candidate, from: string, to: string): Candidate =>
  JSON.parse(JSON.stringify(candidate).replaceAll(from, to)) as Candidate;

/** A verified Flow, or the reason it was not; both are outcomes this suite asserts. */
const gated = (files: Record<string, string>, adapter: string) =>
  (async () => {
    const ctx = contextFor(files);
    const candidate = only(await runAdapter(adapter, ctx));
    return { ctx, candidate, result: gateCandidate(ctx, candidate) };
  })();

/* --------------------------------------------- the clock trigger */

describe("a Spring clock trigger, when the subject's own wiring starts it", () => {
  it("COMPLETE: traces the scheduled method and the gate re-resolves the trigger", async () => {
    const { candidate, result } = await gated(SCHEDULED, "flow-java-spring-scheduled");
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    // The entry box prints the trigger, so the trigger is part of what is claimed.
    expect(flow.steps[0]!.node).toBe('DailyCueJob, @Scheduled cron = 0 0 9 * * *');
    const claim = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "scheduled_trigger"));
    expect(claim.link_id).toBeUndefined();
    expect(claim.trigger).toEqual({
      annotation: "Scheduled",
      attribute: "cron",
      expression: "0 0 9 * * *",
    });
    // The enabling declaration is CITED, in the file that carries it, because a
    // subject that never writes @EnableScheduling runs none of these methods.
    expect(claim.evidence.map((e) => e.path)).toContain("src/main/java/app/batch/BatchConfig.java");
    expect(result.node.confidence).toBe("verified");
    expect(result.verdict).toBe("confirmed");
    // And the durable write at the end is a real terminal, not a stopping point.
    expect((result.node as FlowNode).links!.some((l) => l.relation === "write")).toBe(true);
  }, 60_000);

  it("classifies as unknown rather than claiming #39's request/response slot", async () => {
    const { result } = await gated(SCHEDULED, "flow-java-spring-scheduled");
    // A timer firing is not a request. The closed archetype set is #39's and this
    // adapter does not get to extend it, so the honest answer is `unknown` - which
    // rank admits only into capacity the two preferred archetypes leave open.
    expect(flowArchetype(result.node as FlowNode)).toBe("unknown");
  }, 60_000);

  it("RAN EMPTY: a Spring subject that declares no clock trigger", async () => {
    const ctx = contextFor({
      "src/main/java/app/batch/CueRepository.java": REPOSITORY,
      "src/main/java/app/batch/BatchConfig.java": ENABLED,
    });
    const outcome = outcomeFor((await runProbes(ctx)).outcomes, "flow-java-spring-scheduled");
    expect(outcome.status).toBe("ran");
    expect(outcome.status === "ran" && outcome.candidates).toHaveLength(0);
  }, 60_000);

  it("NOT APPLICABLE: a plain-Java subject runs no Spring, which is a different finding", async () => {
    const ctx = contextFor({ "src/main/java/app/cli/Tool.java": CLI_TOOL });
    const outcome = outcomeFor((await runProbes(ctx)).outcomes, "flow-java-spring-scheduled");
    expect(outcome.status).toBe("not_applicable");
    expect(outcome.status === "not_applicable" && outcome.reason).toContain("org.springframework");
  }, 60_000);

  it("AMBIGUOUS: names the annotation nothing enables, rather than drawing it", async () => {
    // Spring Boot autoconfigures the listener containers but NOT scheduling. A
    // @Scheduled method in a subject with no @EnableScheduling never runs, and a
    // figure drawn from it would assert an execution that does not happen.
    const files = { ...SCHEDULED };
    delete files["src/main/java/app/batch/BatchConfig.java"];
    const reason = absentReason(only(await runAdapter("flow-java-spring-scheduled", contextFor(files))));
    expect(reason).toContain("scheduling_not_enabled");
    expect(reason).toContain("EnableScheduling");
  }, 60_000);

  it("AMBIGUOUS: names a trigger on a type the container does not manage", async () => {
    const reason = absentReason(
      only(
        await runAdapter(
          "flow-java-spring-scheduled",
          contextFor({
            ...SCHEDULED,
            "src/main/java/app/batch/DailyCueJob.java": scheduledJob(
              '@Scheduled(cron = "0 0 9 * * *")',
            ).replace("@Service\n", ""),
          }),
        ),
      ),
    );
    expect(reason).toContain("unmanaged_scheduled_bean");
  }, 60_000);

  it("AMBIGUOUS: names a @Scheduled that declares no expression at all", async () => {
    const reason = absentReason(
      only(
        await runAdapter(
          "flow-java-spring-scheduled",
          contextFor({
            ...SCHEDULED,
            "src/main/java/app/batch/DailyCueJob.java": scheduledJob("@Scheduled"),
          }),
        ),
      ),
    );
    expect(reason).toContain("unresolved_trigger");
  }, 60_000);

  it("reads fixedDelay as readily as cron, because both are how a subject writes one", async () => {
    const { candidate } = await gated(
      {
        ...SCHEDULED,
        "src/main/java/app/batch/DailyCueJob.java": scheduledJob("@Scheduled(fixedDelay = 60000)"),
      },
      "flow-java-spring-scheduled",
    );
    const claim = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "scheduled_trigger"));
    expect(claim.trigger).toEqual({
      annotation: "Scheduled",
      attribute: "fixedDelay",
      expression: "60000",
    });
  }, 60_000);

  it("BOUND EXCEEDED: stops at the path bound rather than drawing a clipped job", async () => {
    const chain: Record<string, string> = {
      "src/main/java/app/batch/BatchConfig.java": ENABLED,
      "src/main/java/app/batch/DailyCueJob.java": `package app.batch;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class DailyCueJob {
  @Scheduled(cron = "0 0 9 * * *")
  public void fire() {
    Step0.run();
  }
}
`,
    };
    const depth = 20;
    for (let i = 0; i < depth; i += 1) {
      chain[`src/main/java/app/batch/Step${i}.java`] = `package app.batch;

public class Step${i} {
  static CueRepository CUES;

  public static void run() {
    ${i + 1 < depth ? `Step${i + 1}.run();` : 'CUES.saveCue("today");'}
  }
}
`;
    }
    chain["src/main/java/app/batch/CueRepository.java"] = REPOSITORY;
    const reason = absentReason(
      only(await runAdapter("flow-java-spring-scheduled", contextFor(chain))),
    );
    expect(reason).toContain("trace_bound_before_terminal");
  }, 60_000);

  it("MUTANT: a trigger whose expression moved under it quarantines the whole Flow", async () => {
    const ctx = contextFor(SCHEDULED);
    const candidate = only(await runAdapter("flow-java-spring-scheduled", ctx));
    const moved = contextFor({
      ...SCHEDULED,
      "src/main/java/app/batch/DailyCueJob.java": scheduledJob('@Scheduled(cron = "0 0 3 * * *")'),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("quarantined atomically");
    expect(result.finding).toContain("cron = 0 0 3 * * *");
  }, 60_000);

  it("MUTANT: the enabling declaration disappearing quarantines the whole Flow", async () => {
    const ctx = contextFor(SCHEDULED);
    const candidate = only(await runAdapter("flow-java-spring-scheduled", ctx));
    const moved = contextFor({
      ...SCHEDULED,
      "src/main/java/app/batch/BatchConfig.java": ENABLED.replace("@EnableScheduling\n", ""),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("EnableScheduling");
  }, 60_000);

  it("MUTANT: a bean that stops being one quarantines the whole Flow", async () => {
    const ctx = contextFor(SCHEDULED);
    const candidate = only(await runAdapter("flow-java-spring-scheduled", ctx));
    const moved = contextFor({
      ...SCHEDULED,
      // Commented out rather than deleted, so every other line keeps its number
      // and the ONLY thing that moved is the stereotype: a mutant that shifted
      // the file would be caught by the first citation to slip, proving nothing
      // about the check it is aimed at.
      "src/main/java/app/batch/DailyCueJob.java": scheduledJob(
        '@Scheduled(cron = "0 0 9 * * *")',
      ).replace("@Service\n", "//Service\n"),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("container-managed bean");
  }, 60_000);
});

/* ------------------------------------------- the message subscription */

describe("a Spring message subscription, claimed without claiming its publisher", () => {
  it("COMPLETE: traces the listener and the gate re-resolves the destination", async () => {
    const { candidate, result } = await gated(KAFKA, "flow-java-spring-message");
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    expect(flow.steps[0]!.node).toBe("CueListener, @KafkaListener topics = cue.raised");
    const claim = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "message_listener"));
    expect(claim.trigger).toEqual({
      annotation: "KafkaListener",
      attribute: "topics",
      expression: "cue.raised",
    });
    expect(result.node.confidence).toBe("verified");
    expect(flowArchetype(result.node as FlowNode)).toBe("unknown");
  }, 60_000);

  it("reads a listener whose header parameter carries its own parenthesized comma", async () => {
    // The gate re-resolves the method's arity by rereading the blob; a parameter
    // annotation with an internal comma (`@Header(name = "trace", ...)`) must be
    // read whole, or the gate miscounts and quarantines a Flow the producer drew.
    const { candidate, result } = await gated(
      {
        "src/main/java/app/batch/CueRepository.java": REPOSITORY,
        "src/main/java/app/batch/CueListener.java": `package app.batch;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Service;

@Service
public class CueListener {
  private final CueRepository cues;

  CueListener(CueRepository cues) {
    this.cues = cues;
  }

  @KafkaListener(topics = "cue.raised")
  public void onCue(@Header(name = "trace", required = false) String trace, String payload) {
    cues.saveCue("today");
  }
}
`,
      },
      "flow-java-spring-message",
    );
    const claim = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "message_listener"));
    expect(claim.trigger).toEqual({
      annotation: "KafkaListener",
      attribute: "topics",
      expression: "cue.raised",
    });
    expect(result.node.confidence).toBe("verified");
  }, 60_000);

  it("reads a listener whose header parameter annotation carries a bracket inside a string", async () => {
    // The gate balances the parameter list over a length-preserving mask, so a `)`
    // inside a string an annotation declares (`@Header("a)b")`) cannot end the list
    // early. Reading the raw span would truncate at that quote, miscount the arity,
    // and quarantine a Flow the producer drew off the parse tree.
    const { candidate, result } = await gated(
      {
        "src/main/java/app/batch/CueRepository.java": REPOSITORY,
        "src/main/java/app/batch/CueListener.java": `package app.batch;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Service;

@Service
public class CueListener {
  private final CueRepository cues;

  CueListener(CueRepository cues) {
    this.cues = cues;
  }

  @KafkaListener(topics = "cue.raised")
  public void onCue(@Header("a)b") String trace, String payload) {
    cues.saveCue("today");
  }
}
`,
      },
      "flow-java-spring-message",
    );
    const claim = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "message_listener"));
    expect(claim.trigger).toEqual({
      annotation: "KafkaListener",
      attribute: "topics",
      expression: "cue.raised",
    });
    expect(result.node.confidence).toBe("verified");
  }, 60_000);

  it("types an @EventListener whose event parameter carries its own parenthesized comma", async () => {
    // The producer reads the event off the structured parameter type; the gate
    // rereads it off the span. A parameter annotation with an internal comma must
    // not truncate the gate's read, or the two derivations disagree on the event.
    const { candidate, result } = await gated(
      {
        "src/main/java/app/batch/CueRepository.java": REPOSITORY,
        "src/main/java/app/batch/CueRaised.java": `package app.batch;

public record CueRaised(String day) {
}
`,
        "src/main/java/app/batch/CueListener.java": `package app.batch;

import org.springframework.context.event.EventListener;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Service;

@Service
public class CueListener {
  private final CueRepository cues;

  CueListener(CueRepository cues) {
    this.cues = cues;
  }

  @EventListener
  public void onCue(@Header(name = "trace", required = false) CueRaised event) {
    cues.saveCue("today");
  }
}
`,
      },
      "flow-java-spring-message",
    );
    const claim = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "message_listener"));
    expect(claim.trigger).toEqual({
      annotation: "EventListener",
      attribute: "parameter",
      expression: "CueRaised",
    });
    expect(result.node.confidence).toBe("verified");
  }, 60_000);

  it("types an @EventListener from the parameter it subscribes through", async () => {
    // The event is the method's parameter type, which is the only place the tree
    // writes it down. A listener whose event cannot be named is cut instead.
    const { candidate, result } = await gated(
      {
        "src/main/java/app/batch/CueRepository.java": REPOSITORY,
        "src/main/java/app/batch/CueRaised.java": `package app.batch;

public record CueRaised(String day) {
}
`,
        "src/main/java/app/batch/CueListener.java": listener("@EventListener", "CueRaised event"),
      },
      "flow-java-spring-message",
    );
    const claim = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "message_listener"));
    expect(claim.trigger).toEqual({
      annotation: "EventListener",
      attribute: "parameter",
      expression: "CueRaised",
    });
    expect(result.node.confidence).toBe("verified");
  }, 60_000);

  it("RAN EMPTY: a Spring subject that subscribes to nothing", async () => {
    const ctx = contextFor({ "src/main/java/app/batch/CueRepository.java": REPOSITORY });
    const outcome = outcomeFor((await runProbes(ctx)).outcomes, "flow-java-spring-message");
    expect(outcome.status).toBe("ran");
    expect(outcome.status === "ran" && outcome.candidates).toHaveLength(0);
  }, 60_000);

  it("NOT APPLICABLE: no Spring means no listener container to arrive through", async () => {
    const ctx = contextFor({ "src/main/java/app/cli/Tool.java": CLI_TOOL });
    const outcome = outcomeFor((await runProbes(ctx)).outcomes, "flow-java-spring-message");
    expect(outcome.status).toBe("not_applicable");
    expect(outcome.status === "not_applicable" && outcome.reason).toContain("listener container");
  }, 60_000);

  it("AMBIGUOUS: names a listener on a type no container registers", async () => {
    const reason = absentReason(
      only(
        await runAdapter(
          "flow-java-spring-message",
          contextFor({
            ...KAFKA,
            "src/main/java/app/batch/CueListener.java": listener(
              '@KafkaListener(topics = "cue.raised")',
              "String payload",
            ).replace("@Service\n", ""),
          }),
        ),
      ),
    );
    expect(reason).toContain("unmanaged_listener_bean");
  }, 60_000);

  it("AMBIGUOUS: names an @EventListener whose event it cannot state", async () => {
    const reason = absentReason(
      only(
        await runAdapter(
          "flow-java-spring-message",
          contextFor({
            ...KAFKA,
            "src/main/java/app/batch/CueListener.java": listener("@EventListener", ""),
          }),
        ),
      ),
    );
    expect(reason).toContain("unresolved_destination");
  }, 60_000);

  it("BOUND EXCEEDED: stops at the path bound rather than drawing a clipped listener", async () => {
    const chain: Record<string, string> = {
      "src/main/java/app/batch/CueRepository.java": REPOSITORY,
      "src/main/java/app/batch/CueListener.java": `package app.batch;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;

@Service
public class CueListener {
  @KafkaListener(topics = "cue.raised")
  public void onCue(String payload) {
    Step0.run();
  }
}
`,
    };
    const depth = 20;
    for (let i = 0; i < depth; i += 1) {
      chain[`src/main/java/app/batch/Step${i}.java`] = `package app.batch;

public class Step${i} {
  static CueRepository CUES;

  public static void run() {
    ${i + 1 < depth ? `Step${i + 1}.run();` : 'CUES.saveCue("today");'}
  }
}
`;
    }
    const reason = absentReason(only(await runAdapter("flow-java-spring-message", contextFor(chain))));
    expect(reason).toContain("trace_bound_before_terminal");
  }, 60_000);

  it("MUTANT: a topic that moved under the listener quarantines the whole Flow", async () => {
    const ctx = contextFor(KAFKA);
    const candidate = only(await runAdapter("flow-java-spring-message", ctx));
    const moved = contextFor({
      ...KAFKA,
      "src/main/java/app/batch/CueListener.java": listener(
        '@KafkaListener(topics = "cue.lowered")',
        "String payload",
      ),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("cue.lowered");
  }, 60_000);
});

/* ------------------------------------------------ the systemd unit */

describe("a systemd unit, stitched to the program its ExecStart launches", () => {
  it("COMPLETE: the CLI adapter draws the launch arrow and the gate re-resolves both ends", async () => {
    const { candidate, result } = await gated(LAUNCHED, "flow-java-cli");
    const flow = candidate.node as FlowNode;
    expect(flow.title).toContain("unit to terminal");
    // The unit is a BOX, at the same granularity every other box uses, and the
    // arrow is the ExecStart line rather than a narrated deployment step.
    expect(flow.steps[0]!.node).toBe("cue.service");
    // The command verbatim, wrapped at a token boundary rather than shortened:
    // `rankdir=LR` lays a long line out as width, and hiding half the directive
    // the arrow's claim rests on is the trade PR 6 refused for edge labels.
    expect(flow.steps[0]!.detail!.split("\\l").join(" ")).toBe(
      "ExecStart=/usr/bin/java -cp /opt/app.jar app.cli.Tool --once",
    );
    const link = only(flow.links!.filter((l) => l.from === flow.steps[0]!.id));
    expect(link.relation).toBe("transport");
    // NOT a request kind: #39 reserves the request/response archetype for a
    // verified request signal, and a unit starting a program is not one.
    expect(link.kind).toBeUndefined();
    const claim = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "process_launch"));
    expect(claim.launch).toEqual({ target: "app.cli.Tool" });
    expect(claim.evidence.map((e) => e.path).sort()).toEqual([
      "deploy/cue.service",
      "src/main/java/app/cli/Tool.java",
    ]);
    expect(result.node.confidence).toBe("verified");
    expect(flowArchetype(result.node as FlowNode)).toBe("unknown");
  }, 60_000);

  it("emits nothing of its own for a unit it stitched, so one program is one story", async () => {
    const ctx = contextFor(LAUNCHED);
    const outcome = outcomeFor((await runProbes(ctx)).outcomes, "flow-systemd-unit");
    expect(outcome.status).toBe("ran");
    expect(outcome.status === "ran" && outcome.candidates).toHaveLength(0);
  }, 60_000);

  it("RAN EMPTY: a subject whose only unit is a timer starts no program itself", async () => {
    const ctx = contextFor({
      "src/main/java/app/cli/Tool.java": CLI_TOOL,
      "deploy/cue.timer": "[Timer]\nOnCalendar=*-*-* 09:00\n",
    });
    const outcome = outcomeFor((await runProbes(ctx)).outcomes, "flow-systemd-unit");
    expect(outcome.status).toBe("ran");
    expect(outcome.status === "ran" && outcome.candidates).toHaveLength(0);
  }, 60_000);

  it("NOT APPLICABLE: a subject that declares no unit file at all", async () => {
    const ctx = contextFor({ "src/main/java/app/cli/Tool.java": CLI_TOOL });
    const outcome = outcomeFor((await runProbes(ctx)).outcomes, "flow-systemd-unit");
    expect(outcome.status).toBe("not_applicable");
    expect(outcome.status === "not_applicable" && outcome.reason).toContain("systemd unit file");
  }, 60_000);

  it("AMBIGUOUS: refuses a bare class name, because a word in a command line is a program", async () => {
    const reason = absentReason(
      only(
        await runAdapter(
          "flow-systemd-unit",
          contextFor({ ...LAUNCHED, "deploy/cue.service": unitFile("ExecStart=/usr/bin/java Tool") }),
        ),
      ),
    );
    expect(reason).toContain("ambiguous_exec_target");
    expect(reason).toContain("app.cli.Tool");
  }, 60_000);

  it("names a wrapper script rather than following one - the reference subject's own shape", async () => {
    // swe-prep's one unit runs `__REPO_PATH__/scripts/daily-cue.sh`: an
    // install-time placeholder in front of a shell script. Neither half is
    // followable, and the cut says so instead of the run going quiet.
    const reason = absentReason(
      only(
        await runAdapter(
          "flow-systemd-unit",
          contextFor({
            ...LAUNCHED,
            "deploy/cue.service": unitFile("ExecStart=__REPO_PATH__/scripts/daily-cue.sh"),
          }),
        ),
      ),
    );
    expect(reason).toContain("unresolved_exec_target");
    expect(reason).toContain("daily-cue.sh");
  }, 60_000);

  it("names a unit that declares no ExecStart at all", async () => {
    const reason = absentReason(
      only(
        await runAdapter(
          "flow-systemd-unit",
          contextFor({ ...LAUNCHED, "deploy/cue.service": "[Unit]\nDescription=nothing\n" }),
        ),
      ),
    );
    expect(reason).toContain("no_exec_start");
  }, 60_000);

  it("BOUND EXCEEDED: a launched program whose trace hits the bound is cut whole", async () => {
    const chain: Record<string, string> = {
      "deploy/cue.service": unitFile("ExecStart=/usr/bin/java app.cli.Deep"),
      "src/main/java/app/cli/Deep.java": `package app.cli;

public class Deep {
  public static void main(String[] args) {
    Step0.run();
  }
}
`,
      "src/main/java/app/batch/CueRepository.java": REPOSITORY,
    };
    const depth = 20;
    for (let i = 0; i < depth; i += 1) {
      chain[`src/main/java/app/cli/Step${i}.java`] = `package app.cli;

public class Step${i} {
  static app.batch.CueRepository CUES;

  public static void run() {
    ${i + 1 < depth ? `Step${i + 1}.run();` : 'CUES.saveCue("today");'}
  }
}
`;
    }
    const ctx = contextFor(chain);
    expect(absentReason(only(await runAdapter("flow-java-cli", ctx)))).toContain(
      "trace_bound_before_terminal",
    );
    // And the systemd adapter still emits nothing for that unit: it resolved the
    // launch, so the story - including its failure - belongs to the entry's owner.
    const outcome = outcomeFor((await runProbes(ctx)).outcomes, "flow-systemd-unit");
    expect(outcome.status === "ran" && outcome.candidates).toHaveLength(0);
  }, 60_000);

  it("draws every unit that starts one program, rather than the first one found", async () => {
    // A program two units start is two arrows into one story. Picking one would
    // drop the other in silence, which is the one thing #6 forbids everywhere
    // else in this producer - and the systemd adapter would report neither,
    // because both resolved.
    const { candidate, result } = await gated(
      {
        ...LAUNCHED,
        "deploy/cue-once.service": unitFile("ExecStart=/usr/bin/java app.cli.Tool --backfill"),
      },
      "flow-java-cli",
    );
    const flow = candidate.node as FlowNode;
    expect(flow.steps.slice(0, 2).map((step) => step.node).sort()).toEqual([
      "cue-once.service",
      "cue.service",
    ]);
    expect((candidate.flow_claims ?? []).filter((c) => c.matcher === "process_launch")).toHaveLength(2);
    expect(flow.caption).toContain("cue-once.service and cue.service");
    // Both arrows are independently re-resolved; neither rides in on the other.
    expect(result.node.confidence).toBe("verified");
  }, 60_000);

  it("keeps the unit box's element id distinct from a traced box that slugs the same", async () => {
    // Every step id is used verbatim as a rendered element id, so a duplicate is
    // invalid HTML and breaks the audit checks that resolve nodes by id.
    const { candidate } = await gated(
      { ...LAUNCHED, "deploy/Tool-main.service": unitFile("ExecStart=/usr/bin/java app.cli.Tool") },
      "flow-java-cli",
    );
    const flow = candidate.node as FlowNode;
    expect(new Set(flow.steps.map((step) => step.id)).size).toBe(flow.steps.length);
    expect(new Set(flow.links!.map((link) => link.id)).size).toBe(flow.links!.length);
  }, 60_000);

  it("MUTANT: an ExecStart that moved to another program quarantines the whole Flow", async () => {
    const ctx = contextFor(LAUNCHED);
    const candidate = only(await runAdapter("flow-java-cli", ctx));
    const moved = contextFor({
      ...LAUNCHED,
      "src/main/java/app/cli/Other.java": CLI_TOOL.replace("class Tool", "class Other"),
      "deploy/cue.service": unitFile("ExecStart=/usr/bin/java -cp /opt/app.jar app.cli.Other --once"),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("app.cli.Tool");
  }, 60_000);

  it("MUTANT: a launch arrow whose main declaration is gone quarantines the whole Flow", async () => {
    const ctx = contextFor(LAUNCHED);
    const candidate = only(await runAdapter("flow-java-cli", ctx));
    const moved = contextFor({
      ...LAUNCHED,
      "src/main/java/app/cli/Tool.java": CLI_TOOL.replace(
        "public static void main(String[] args)",
        "public static void run(String[] args)",
      ),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
  }, 60_000);

  it("reads the unit the way systemd does: a comment is not a directive", async () => {
    // The fixture's `[Unit]` section carries a commented ExecStart naming a decoy
    // class. Both the producer and the gate read through `execStart`, and neither
    // may take it - a directive outside `[Service]`, behind a `#`, starts nothing.
    const directive = execStart(unitFile("ExecStart=/usr/bin/java app.cli.Tool"))!;
    expect(directive.command).toBe("/usr/bin/java app.cli.Tool");
    expect(launchClassTokens(directive.command)).toEqual(["app.cli.Tool"]);
    expect(execStart("[Unit]\nExecStart=/usr/bin/java app.decoy.NotThis\n")).toBeNull();
  });

  it("joins a continued ExecStart, because a wrapped command is one command", async () => {
    const directive = execStart(
      "[Service]\nExecStart=/usr/bin/java \\\n  -cp /opt/app.jar \\\n  app.cli.Tool\n",
    )!;
    expect(directive.line_start).toBe(2);
    expect(directive.line_end).toBe(4);
    expect(launchClassTokens(directive.command)).toEqual(["app.cli.Tool"]);
  });
});

/* --------------------------------- what the audit reads back out of them */

describe("the audit's static evidence gates read every new entry family", () => {
  const atlasWith = (flow: FlowNode, sha: string, clone: string): Atlas =>
    ({
      schema_version: "1.1.0",
      generated_at: "2026-08-22T00:00:00Z",
      profile: "interview",
      rubric_version: "interview-v1",
      subject: {
        owner: "o",
        repo: "r",
        url: "https://example.invalid/o/r",
        branch: "main",
        sha,
        read_on: "2026-08-22",
        visibility: "public",
      },
      synopsis: { statement: "s", evidence: [] },
      shape: { tree: "t", evidence: [] },
      nodes: [{ ...flow, interview_value: 4 }],
      record: {
        sources: [],
        density_signals: {},
        section_presence: {},
        confidence_ledger: { verified: 1, attested: 0, absent_cut: 0 },
        absent_cuts: [],
        deletions: [],
        budgets: {},
        audit: { status: "not_run" as const },
      },
      clone,
    }) as unknown as Atlas;

  it.each([
    ["a clock-triggered Flow", SCHEDULED, "flow-java-spring-scheduled"],
    ["a message-triggered Flow", KAFKA, "flow-java-spring-message"],
    ["a unit-launched Flow", LAUNCHED, "flow-java-cli"],
  ])(
    "resolves every citation and establishes every rendered relationship: %s",
    async (_what, files, adapter) => {
      const { ctx, result } = await gated(files as Record<string, string>, adapter as string);
      expect(result.node.confidence).toBe("verified");
      const auditCtx = {
        artifact: "",
        atlas: atlasWith(result.node as FlowNode, ctx.sha, ctx.clone),
        clone: ctx.clone,
      };
      const [l1, l2] = resolveFileEvidence(auditCtx);
      expect(l1.outcome, JSON.stringify(l1.findings)).toBe("passed");
      expect(l2.outcome, JSON.stringify(l2.findings)).toBe("passed");
      // E2 is the one that reads the RELATIONSHIP: a launch arrow has to cite an
      // ExecStart that names the program the arrow lands on, which is the same
      // shape as the HTTP transport check beside it.
      const e2 = presentTenseClaims(auditCtx);
      expect(e2.outcome, JSON.stringify(e2.findings)).toBe("passed");
    },
    60_000,
  );

  it("MUTANT: E2 refuses a launch arrow citing an ExecStart that starts something else", async () => {
    const { ctx, result } = await gated(LAUNCHED, "flow-java-cli");
    const flow = result.node as FlowNode;
    // The arrow now lands on a box that names nothing the ExecStart launches.
    const broken: FlowNode = {
      ...flow,
      steps: flow.steps.map((step) =>
        step.id === flow.links!.find((l) => l.from === flow.steps[0]!.id)!.to
          ? { ...step, node: "Elsewhere", detail: "elsewhere(String[] args)" }
          : step,
      ),
    };
    const e2 = presentTenseClaims({
      artifact: "",
      atlas: atlasWith(broken, ctx.sha, ctx.clone),
      clone: ctx.clone,
    });
    expect(e2.outcome).toBe("failed");
    expect(JSON.stringify(e2.findings)).toContain("ExecStart");
  }, 60_000);

  it("E2 PASSES a launch arrow whose ExecStart wraps the class onto a continuation line", async () => {
    // The cited evidence span covers the whole `\`-continued directive, and the
    // fully-qualified class lands on a continuation line. E2 reads the command
    // through `execStartInSpan`, which joins continuations the same way the gate
    // does, so the wrapped directive resolves rather than being read one line
    // deep - the drift the reused reader closes.
    const wrapped: Record<string, string> = {
      ...LAUNCHED,
      "deploy/cue.service": unitFile(
        "ExecStart=/usr/bin/java \\\n  -cp /opt/app.jar \\\n  app.cli.Tool --once",
      ),
    };
    const { ctx, result } = await gated(wrapped, "flow-java-cli");
    expect(result.node.confidence).toBe("verified");
    const e2 = presentTenseClaims({
      artifact: "",
      atlas: atlasWith(result.node as FlowNode, ctx.sha, ctx.clone),
      clone: ctx.clone,
    });
    expect(e2.outcome, JSON.stringify(e2.findings)).toBe("passed");
  }, 60_000);
});
