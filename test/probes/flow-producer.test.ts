/**
 * The Java/Spring Flow producer: entry inventory and simple typed traces (#35,
 * accepted design section 9, PR 4).
 *
 * Every fixture here is a small real repository, and every assertion is one of
 * the two things this phase promises. Either a chain the tree establishes end to
 * end survives the PR 2 gate with one independently resolved claim per arrow, or
 * the candidate is `absent` and says which resolution failed. There is no third
 * outcome: a shortened diagram is the failure this producer exists to avoid.
 *
 * The mutant fixtures from section 10 that apply to this phase are the absent
 * ones - unresolvable dispatch, same-arity overload, cycle before a terminal,
 * trace bound, undeclared repository method - plus the gate disagreement at the
 * bottom, which is the only assertion that proves the gate is a check rather
 * than an echo of the producer.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROBES, runProbes, treeContext } from "../../src/probes/registry.js";
import { gateCandidate } from "../../src/gate/gate.js";
import { javaIndex } from "../../src/probes/flow/symbols.js";
import { httpEntries, mainEntries } from "../../src/probes/flow/entries.js";
import { normalizedRoute } from "../../src/probes/flow/route.js";
import { presentTenseClaims, resolveFileEvidence } from "../../src/audit/checks/evidence.js";
import type { Candidate, ProbeContext, ProbeOutcome } from "../../src/probes/types.js";
import type { Atlas, FlowNode } from "../../src/schema/types.js";
import type { Harvest } from "../../src/harvest/types.js";

/* ---------------------------------------------------------- fixtures */

const buildTree = (files: Record<string, string>): { path: string; sha: string } => {
  const path = mkdtempSync(join(tmpdir(), "repo-atlas-flow-"));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), contents, "utf8");
  }
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.email", "flow@test.invalid"]);
  git(["config", "user.name", "flow test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "subject"]);
  return { path, sha: git(["rev-parse", "HEAD"]).trim() };
};

const contextFor = (files: Record<string, string>): ProbeContext => {
  const tree = buildTree(files);
  const harvest = {
    harvest_version: "1.0.0",
    subject: {
      owner: "o",
      repo: "r",
      url: "https://example.invalid/o/r",
      branch: "main",
      sha: tree.sha,
      read_on: "2026-08-21",
      visibility: "public",
    },
    issues: [],
    scale: { files: 0, lines: 0, commits: 1, first_commit: null, last_commit: null, days: null },
    density: {
      closed_issues_with_resolution_comment: { value: 0, of: 0 },
      comment_to_body_ratio: { value: 0 },
      source_files_citing_issues: { value: 0, of: 0 },
      adr_directory: { value: false },
    },
    sources: [],
    private_split: { declared: false, readable_at_harvest: false },
    memory_files: [],
  } as unknown as Harvest;
  return treeContext(harvest, tree.path);
};

const runAdapter = async (id: string, ctx: ProbeContext): Promise<Candidate[]> => {
  const probe = PROBES.find((p) => p.id === id)!;
  const applies = probe.applies ? await probe.applies(ctx) : { ok: true as const };
  return applies.ok ? probe.run(ctx) : [];
};

const only = <T>(list: T[]): T => {
  expect(list).toHaveLength(1);
  return list[0]!;
};

/* ------------------------------------------------------ the fixtures */

const CONTROLLER = `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/attempts")
public class AttemptController {
  private final AttemptService attempts;

  AttemptController(AttemptService attempts) {
    this.attempts = attempts;
  }

  @PostMapping("/{id}/submit")
  public RunResponse submit(@PathVariable UUID id, @RequestBody RunRequest request) {
    Attempt saved = attempts.submit(id, request);
    return RunResponse.of(saved);
  }
}
`;

const SERVICE = `package app.web;

public class AttemptService {
  private final AttemptRepository attempts;

  AttemptService(AttemptRepository attempts) {
    this.attempts = attempts;
  }

  public Attempt submit(UUID id, RunRequest request) {
    Attempt attempt = new Attempt(id, request.code());
    return attempts.saveAttempt(attempt);
  }
}
`;

const REPOSITORY = `package app.web;

import org.springframework.data.jpa.repository.JpaRepository;

public interface AttemptRepository extends JpaRepository<Attempt, UUID> {
  Attempt saveAttempt(Attempt attempt);
}
`;

const RESPONSE = `package app.web;

public class RunResponse {
  private final Attempt attempt;

  private RunResponse(Attempt attempt) {
    this.attempt = attempt;
  }

  public static RunResponse of(Attempt attempt) {
    return new RunResponse(attempt);
  }
}
`;

const LINEAR: Record<string, string> = {
  "src/main/java/app/web/AttemptController.java": CONTROLLER,
  "src/main/java/app/web/AttemptService.java": SERVICE,
  "src/main/java/app/web/AttemptRepository.java": REPOSITORY,
  "src/main/java/app/web/RunResponse.java": RESPONSE,
};

/* ---------------------------------------------------- entry inventory */

describe("Spring entry inventory", () => {
  it("composes the class-level prefix with each method mapping, verb by verb", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/Routes.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/attempts")
public class Routes {
  @GetMapping("/{id}")
  public String one(String id) { return id; }

  @PutMapping
  public String replace(String body) { return body; }

  @RequestMapping(method = RequestMethod.DELETE, path = "/{id}")
  public String drop(String id) { return id; }

  @RequestMapping("/any")
  public String any() { return "any"; }
}
`,
    });
    const entries = httpEntries(await javaIndex(ctx));
    expect(entries.map((e) => `${e.protocol.method} ${e.protocol.path}`).sort()).toEqual([
      "DELETE /api/v1/attempts/{}",
      "GET /api/v1/attempts/{}",
      "PUT /api/v1/attempts",
    ]);
    // The multi-verb @RequestMapping is deliberately absent: it names no single
    // verb, and a route claim naming one the annotation never named would be the
    // engine asserting what it did not read.
    expect(entries.some((e) => e.method.name === "any")).toBe(false);
  });

  it("reads a controller as a controller only where the annotation says so", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/Plain.java": `package app.web;

import org.springframework.web.bind.annotation.GetMapping;

public class Plain {
  @GetMapping("/plain")
  public String hello() { return "hello"; }
}
`,
    });
    expect(httpEntries(await javaIndex(ctx))).toHaveLength(0);
  });

  it("counts a real main and refuses one written inside a text block", async () => {
    const ctx = contextFor({
      "src/main/java/app/cli/Tool.java": `package app.cli;

public class Tool {
  public static void main(String[] args) {
    System.out.println(args.length);
  }
}
`,
      "src/main/java/app/cli/Harness.java": `package app.cli;

public class Harness {
  static final String GENERATED = """
    public class Solution {
      public static void main(String[] args) {
        System.out.println("generated");
      }
    }
    """;

  static String sourceOf() { return GENERATED; }
}
`,
      "src/main/java/app/cli/NotMain.java": `package app.cli;

public class NotMain {
  public static void main(String arg) {}
  static void main(String[] args) {}
}
`,
    });
    const mains = mainEntries(await javaIndex(ctx));
    expect(mains.map((m) => m.type.name)).toEqual(["Tool"]);
  });

  it("normalises a route the same way the gate does", () => {
    expect(normalizedRoute("/api//attempts/{id}/")).toBe("/api/attempts/{}");
    expect(normalizedRoute("api/${base}/x?q=1")).toBe("/api/{}/x");
    expect(normalizedRoute("/")).toBe("/");
  });
});

/* ------------------------------------------------- the verified chain */

describe("a controller -> service -> repository -> response path", () => {
  it("proposes the whole chain, and the gate resolves every arrow", async () => {
    const ctx = contextFor(LINEAR);
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;

    expect(flow.confidence).toBe("verified");
    expect(flow.title).toContain("POST /api/attempts/{}/submit");
    expect(flow.steps.map((s) => s.id)).toEqual([
      "attemptcontroller-submit",
      "attemptservice-submit",
      "attemptrepository-saveattempt",
      "runresponse-of",
    ]);
    expect(flow.links!.map((l) => l.relation).sort()).toEqual(["call", "return", "write"]);
    // Every arrow carries its own citation and its own atomic claim: a chain is
    // a set of relationship claims, so evidence lives on the links (#37).
    for (const link of flow.links!) expect(link.evidence.length, link.id).toBeGreaterThan(0);
    expect(candidate.flow_claims!.filter((c) => c.link_id !== undefined)).toHaveLength(3);
    // Plus the route itself, which is a claim about the tree the gate re-derives.
    const route = only(candidate.flow_claims!.filter((c) => c.link_id === undefined));
    expect(route.matcher).toBe("spring_route");
    expect(route.from.protocol).toEqual({ method: "POST", path: "/api/attempts/{}/submit" });

    const gated = gateCandidate(ctx, candidate);
    expect(gated.verdict, gated.finding).toBe("confirmed");
    expect(gated.node.confidence).toBe("verified");
  }, 60_000);

  it("scores nothing and claims no entry kind it did not read", async () => {
    const ctx = contextFor(LINEAR);
    const flow = only(await runAdapter("flow-java-spring-http", ctx)).node as FlowNode;
    // The producer proposes; the scorer judges. A candidate that arrived with a
    // value would be a second ranker (#2, #9).
    expect(flow.interview_value).toBe(0);
    expect(flow.steps[0]!.kind).toBe("request");
    expect(flow.steps.filter((s) => s.kind === "response").map((s) => s.id)).toEqual([
      "runresponse-of",
    ]);
  }, 60_000);

  it("resolves a receiver through a field, a local and a static type name", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/MixedController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class MixedController {
  private final AttemptService injected;

  MixedController(AttemptService injected) {
    this.injected = injected;
  }

  @GetMapping("/mixed")
  public String read() {
    AttemptService local = injected;
    String first = local.lookup();
    String second = Formatter.render(first);
    return Echo.of(second);
  }
}
`,
      "src/main/java/app/web/AttemptService.java": `package app.web;

public class AttemptService {
  private final AttemptRepository attempts;

  AttemptService(AttemptRepository attempts) {
    this.attempts = attempts;
  }

  public String lookup() {
    return attempts.findLatest().toString();
  }
}
`,
      "src/main/java/app/web/AttemptRepository.java": `package app.web;

import org.springframework.data.jpa.repository.JpaRepository;

public interface AttemptRepository extends JpaRepository<Attempt, UUID> {
  Attempt findLatest();
}
`,
      "src/main/java/app/web/Formatter.java": `package app.web;

public class Formatter {
  public static String render(String value) {
    return value.trim();
  }
}
`,
      "src/main/java/app/web/Echo.java": `package app.web;

public class Echo {
  public static String of(String value) {
    return value;
  }
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    // The local-typed receiver and the repository read are both on the retained
    // path; the static helper that goes nowhere is not drawn as an ending.
    expect(flow.steps.map((s) => s.id)).toEqual([
      "mixedcontroller-read",
      "attemptservice-lookup",
      "attemptrepository-findlatest",
      "echo-of",
    ]);
    expect(flow.links!.find((l) => l.to === "attemptrepository-findlatest")!.relation).toBe("read");
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("traces a write-only program path from a real main", async () => {
    const ctx = contextFor({
      "src/main/java/app/cli/Importer.java": `package app.cli;

public class Importer {
  public static void main(String[] args) {
    new Importer(new ContentRepository()).load(args[0]);
  }

  private final ContentRepository content;

  Importer(ContentRepository content) {
    this.content = content;
  }

  void load(String path) {
    content.saveContent(path);
  }
}
`,
      "src/main/java/app/cli/ContentRepository.java": `package app.cli;

public class ContentRepository {
  public void saveContent(String path) {}
}
`,
    });
    const candidate = only(await runAdapter("flow-java-cli", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    expect(flow.links!.map((l) => l.relation)).toEqual(["call", "write"]);
    // A program is not an HTTP request, and #39 reserves the request/response
    // slot for a verified request signal, so this entry claims no kind.
    expect(flow.steps[0]!.kind).toBeUndefined();
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("resolves a shared method name by the receiver's declared type", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/PayController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class PayController {
  private final Ledger ledger;

  PayController(Ledger ledger) {
    this.ledger = ledger;
  }

  @PostMapping("/pay")
  public String pay(String amount) {
    return ledger.record(amount);
  }
}
`,
      "src/main/java/app/web/Ledger.java": `package app.web;

public class Ledger {
  private final PaymentRepository payments;

  Ledger(PaymentRepository payments) {
    this.payments = payments;
  }

  public String record(String amount) {
    return payments.savePayment(amount);
  }
}
`,
      "src/main/java/app/audit/Journal.java": `package app.audit;

public class Journal {
  public String record(String amount) {
    throw new UnsupportedOperationException("never on the traced path");
  }
}
`,
      "src/main/java/app/web/PaymentRepository.java": `package app.web;

public class PaymentRepository {
  public String savePayment(String amount) { return amount; }
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    // Two subject types declare `record(String)`. A name-only call graph would
    // link both; the receiver's declared type establishes exactly one.
    expect(flow.steps.map((s) => s.node)).toEqual([
      "POST /pay",
      "Ledger",
      "PaymentRepository",
    ]);
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("keeps two handlers that share a method name apart, route by route", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/ListController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class ListController {
  @GetMapping("/lessons")
  public String list() { return "lessons"; }

  @GetMapping("/lessons/{id}")
  public String list(String id) { return id; }
}
`,
    });
    const candidates = await runAdapter("flow-java-spring-http", ctx);
    expect(candidates.map((c) => c.node.title).sort()).toEqual([
      "GET /api/lessons, entry to terminal",
      "GET /api/lessons/{}, entry to terminal",
    ]);
    // Two candidates, two element ids: an id collision would break the audit's
    // node lookups, so the overload discriminator is minted into the id.
    expect(new Set(candidates.map((c) => c.node.id)).size).toBe(2);
  }, 60_000);

  it("picks the overload the call site takes, by arity", async () => {
    const ctx = contextFor({
      ...LINEAR,
      "src/main/java/app/web/AttemptService.java": `package app.web;

public class AttemptService {
  private final AttemptRepository attempts;

  AttemptService(AttemptRepository attempts) {
    this.attempts = attempts;
  }

  public Attempt submit(UUID id) {
    return attempts.saveAttempt(new Attempt(id));
  }

  public Attempt submit(UUID id, RunRequest request) {
    Attempt attempt = new Attempt(id, request.code());
    return attempts.saveAttempt(attempt);
  }
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    const service = flow.steps.find((s) => s.id === "attemptservice-submit")!;
    expect(service.detail).toBe("submit(UUID, RunRequest)");
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("keeps a nested type's fields out of the type that encloses it", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/InboxController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class InboxController {
  private final InboxService attempts;

  InboxController(InboxService attempts) {
    this.attempts = attempts;
  }

  @PostMapping("/inbox")
  public String receive(@RequestBody String body) {
    note.write(body);
    return attempts.store(body);
  }

  static class Cursor {
    private final long attempts;
    private final NoteRepository note;

    Cursor(long attempts, NoteRepository note) {
      this.attempts = attempts;
      this.note = note;
    }
  }
}
`,
      "src/main/java/app/web/InboxService.java": `package app.web;

public class InboxService {
  private final InboxRepository repository;

  InboxService(InboxRepository repository) {
    this.repository = repository;
  }

  public String store(String body) {
    return repository.saveMessage(body);
  }
}
`,
      "src/main/java/app/web/InboxRepository.java": `package app.web;

import org.springframework.data.jpa.repository.JpaRepository;

public interface InboxRepository extends JpaRepository<String, String> {
  String saveMessage(String body);
}
`,
      "src/main/java/app/web/NoteRepository.java": `package app.web;

public class NoteRepository {
  void write(String body) {}
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    // `findAll` walks the whole subtree, so before the scope fix the nested Cursor
    // leaked both its fields into InboxController. Mode 1: `Cursor.attempts` (a
    // long) conflicts with the real injected `attempts` and deletes it, so
    // `attempts.store(body)` resolves foreign and the controller->service branch
    // drops in silence - the whole Flow vanishing rather than quarantining. Mode 2:
    // `Cursor.note` types the `note.write(body)` receiver the outer method does not
    // have, drawing a write arrow into NoteRepository that is not this method's.
    // The fixed producer keeps the real chain and never traces `note`.
    expect(flow.confidence).toBe("verified");
    expect(flow.steps.map((s) => s.id)).toEqual([
      "inboxcontroller-receive",
      "inboxservice-store",
      "inboxrepository-savemessage",
    ]);
    expect(flow.steps.some((s) => s.id.includes("note"))).toBe(false);
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

});

/* ------------------------------------------- what it refuses to draw */

describe("what the resolver cannot prove stays absent", () => {
  const absentReason = (candidate: Candidate): string => {
    expect(candidate.node.confidence).toBe("absent");
    expect((candidate.node as FlowNode).steps).toHaveLength(0);
    return candidate.absent_reason ?? "";
  };

  it("cuts a story at a polymorphic dispatch instead of picking an implementation", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/GradeController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class GradeController {
  private final GraderRegistry registry;

  GradeController(GraderRegistry registry) {
    this.registry = registry;
  }

  @PostMapping("/grade")
  public String grade(String exercise) {
    return registry.graderFor(exercise).grade(exercise);
  }
}
`,
      "src/main/java/app/web/GraderRegistry.java": `package app.web;

public class GraderRegistry {
  private final AttemptRepository attempts;

  GraderRegistry(AttemptRepository attempts) {
    this.attempts = attempts;
  }

  public Grader graderFor(String exercise) {
    attempts.findLatest();
    return null;
  }
}
`,
      "src/main/java/app/web/Grader.java": `package app.web;

public interface Grader {
  String grade(String exercise);
}
`,
      "src/main/java/app/web/TestCaseGrader.java": `package app.web;

public class TestCaseGrader implements Grader {
  public String grade(String exercise) { return "PASSED"; }
}
`,
      "src/main/java/app/web/AttemptRepository.java": `package app.web;

import org.springframework.data.jpa.repository.JpaRepository;

public interface AttemptRepository extends JpaRepository<Attempt, UUID> {
  Attempt findLatest();
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    // The registry branch DOES reach a repository read, so a producer willing to
    // draw what it could resolve would have rendered a plausible partial story.
    // The dispatch is on a retained landmark, so the whole Flow is cut instead.
    expect(absentReason(candidate)).toContain("unresolved_dispatch");
    expect(absentReason(candidate)).toContain("Grader.grade");
    expect(gateCandidate(ctx, candidate).node.confidence).toBe("absent");
  }, 60_000);

  it("names the producer's reason in the gate finding, rather than one generic refusal", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/EmptyController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class EmptyController {
  @GetMapping("/ping")
  public String ping() {
    return "pong";
  }
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    expect(absentReason(candidate)).toContain("no_terminal_reached");
    const gated = gateCandidate(ctx, candidate);
    expect(gated.node.confidence).toBe("absent");
    // #6: absence is never communicated by silence, and "I could not type a
    // receiver" and "nothing here reaches a terminal" are different findings.
    expect(gated.finding).toContain("no_terminal_reached");
  }, 60_000);

  it("refuses a same-arity overload it cannot pick", async () => {
    const ctx = contextFor({
      ...LINEAR,
      "src/main/java/app/web/AttemptService.java": `package app.web;

public class AttemptService {
  private final AttemptRepository attempts;

  AttemptService(AttemptRepository attempts) {
    this.attempts = attempts;
  }

  public Attempt submit(UUID id, String code) {
    return attempts.saveAttempt(new Attempt(id));
  }

  public Attempt submit(UUID id, RunRequest request) {
    Attempt attempt = new Attempt(id, request.code());
    return attempts.saveAttempt(attempt);
  }
}
`,
    });
    expect(absentReason(only(await runAdapter("flow-java-spring-http", ctx)))).toContain(
      "ambiguous_overload",
    );
  }, 60_000);

  it("refuses a repository method the repository does not declare", async () => {
    const ctx = contextFor({
      ...LINEAR,
      "src/main/java/app/web/AttemptRepository.java": `package app.web;

import org.springframework.data.jpa.repository.JpaRepository;

public interface AttemptRepository extends JpaRepository<Attempt, UUID> {
}
`,
      "src/main/java/app/web/AttemptService.java": SERVICE.replace("saveAttempt", "save"),
    });
    // `save` is inherited from a framework supertype: nothing in the tree
    // declares it, so nothing in the tree can establish the arrow either.
    expect(absentReason(only(await runAdapter("flow-java-spring-http", ctx)))).toContain(
      "unprovable_data_access",
    );
  }, 60_000);

  it("stops where the gate's own receiver resolution stops, and names it", async () => {
    const ctx = contextFor({
      "src/main/java/app/cli/Importer.java": `package app.cli;

public class Importer {
  public static void main(String[] args) {
    Holder.CONTENT.saveContent(args[0]);
  }
}
`,
      "src/main/java/app/cli/Holder.java": `package app.cli;

public class Holder {
  static final ContentRepository CONTENT = new ContentRepository();
}
`,
      "src/main/java/app/cli/ContentRepository.java": `package app.cli;

public class ContentRepository {
  public void saveContent(String path) {}
}
`,
    });
    // The producer could type this receiver through the field's declaration in
    // another file. It declines, because the gate re-resolves a receiver from
    // the CALLING file: tracing further would propose an arrow the gate cannot
    // check, and a real chain would come back as a confusing quarantine instead
    // of a named limit. Producer and gate fail closed on the same line, which is
    // the same rule that leaves closed_dispatch unresolved in this phase.
    const reason = absentReason(only(await runAdapter("flow-java-cli", ctx)));
    expect(reason).toContain("unresolved_receiver_type");
    expect(reason).toContain("Holder.CONTENT");
  }, 60_000);

  it("names a chained receiver whose inherited accessor leads to a durable write", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/WorkController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class WorkController {
  private final WorkService service;

  WorkController(WorkService service) {
    this.service = service;
  }

  @PostMapping("/work")
  public String work() {
    service.gateway().persist();
    return service.report();
  }
}
`,
      "src/main/java/app/web/BaseService.java": `package app.web;

public class BaseService {
  protected final WorkRepository repository;

  BaseService(WorkRepository repository) {
    this.repository = repository;
  }

  WorkRepository gateway() {
    return repository;
  }
}
`,
      "src/main/java/app/web/WorkService.java": `package app.web;

public class WorkService extends BaseService {
  WorkService(WorkRepository repository) {
    super(repository);
  }

  String report() {
    return "done";
  }
}
`,
      "src/main/java/app/web/WorkRepository.java": `package app.web;

public class WorkRepository {
  void persist() {}
}
`,
    });
    // `gateway()` is inherited from WorkService's supertype, so the chain DOES
    // type to WorkRepository and the `.persist()` branch reaches a durable write.
    // Before the fix the accessor typed only against WorkService's own methods,
    // found nothing, and the write was dropped SILENTLY while `report()` still
    // reached a terminal - a verified Flow missing a durable write the gate never
    // re-resolves, because it re-resolves emitted claims, not omitted edges. The
    // chained receiver is now named rather than traced: the gate types a receiver
    // only from named declarations in the calling file, so tracing it would only
    // return the whole chain as a confusing quarantine at the gate.
    const reason = absentReason(only(await runAdapter("flow-java-spring-http", ctx)));
    expect(reason).toMatch(/^unresolved_receiver_type:/);
    expect(reason).toContain("gateway");
  }, 60_000);

  it("names a chained accessor it cannot type, rather than dropping its branch", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/PickController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class PickController {
  private final PickService service;

  PickController(PickService service) {
    this.service = service;
  }

  @PostMapping("/pick")
  public String pick(@RequestBody String key) {
    service.pick(key).persist();
    return service.report();
  }
}
`,
      "src/main/java/app/web/PickService.java": `package app.web;

public class PickService {
  PickRepository pick(String key) {
    return null;
  }

  PickRepository pick(Long key) {
    return null;
  }

  String report() {
    return "done";
  }
}
`,
      "src/main/java/app/web/PickRepository.java": `package app.web;

public class PickRepository {
  void persist() {}
}
`,
    });
    // Two same-arity `pick` overloads, and the argument's type resolves to
    // neither, so the accessor's return type is not established. The `report()`
    // branch independently reaches a terminal, so before the fix this receiver
    // fell through as foreign and the candidate came back VERIFIED with the
    // `.persist()` write missing. It is now named and the whole Flow quarantined:
    // an untypeable subject-owned receiver is a gap, not a silent skip.
    const reason = absentReason(only(await runAdapter("flow-java-spring-http", ctx)));
    expect(reason).toMatch(/^unresolved_receiver_type:/);
    expect(reason).toContain("PickService.pick");
  }, 60_000);

  it("names a direct call inherited from a subject supertype, but traces it when the receiver's own type declares it", async () => {
    // The base-service pattern: a controller calls, through a field typed as the
    // subtype, a method the subtype INHERITS from a subject-owned base class.
    // `declaredMethod` follows subject-owned supertypes, so the producer CAN
    // resolve the call - and before the fix it drew the edge and traced on into a
    // durable write, emitting a verified Flow. But the gate re-types a receiver
    // only from the declarations in the calling file: it searches for a
    // `BaseReportService` variable, the field is a `ReportService`, and the arrow
    // to the supertype-owned method never re-resolves. The verified Flow came back
    // OVERTURNED - a real chain as a confusing quarantine - which is the exact
    // divergence the "resolve no further than the gate can re-resolve" rule names.
    const inherited = contextFor({
      "src/main/java/app/web/ReportController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class ReportController {
  private final ReportService service;

  ReportController(ReportService service) {
    this.service = service;
  }

  @PostMapping("/report")
  public String report() {
    service.record();
    return "ok";
  }
}
`,
      "src/main/java/app/web/BaseReportService.java": `package app.web;

public class BaseReportService {
  protected final ReportRepository repository;

  BaseReportService(ReportRepository repository) {
    this.repository = repository;
  }

  void record() {
    repository.save();
  }
}
`,
      "src/main/java/app/web/ReportService.java": `package app.web;

public class ReportService extends BaseReportService {
  ReportService(ReportRepository repository) {
    super(repository);
  }
}
`,
      "src/main/java/app/web/ReportRepository.java": `package app.web;

public class ReportRepository {
  void save() {}
}
`,
    });
    const reason = absentReason(only(await runAdapter("flow-java-spring-http", inherited)));
    expect(reason).toMatch(/^unresolved_receiver_type:/);
    expect(reason).toContain("record");
    expect(reason).toContain("ReportService");
    expect(reason).toContain("BaseReportService");

    // The honest counterpart pins the limit rather than merely pinning a failure:
    // move `record()` onto ReportService's OWN type and the same call site is a
    // traced edge the gate confirms. Nothing about the receiver or the terminal
    // changed - only whether the declaration the producer resolved is one the gate
    // can independently re-resolve from the calling file.
    const owned = contextFor({
      "src/main/java/app/web/ReportController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class ReportController {
  private final ReportService service;

  ReportController(ReportService service) {
    this.service = service;
  }

  @PostMapping("/report")
  public String report() {
    service.record();
    return "ok";
  }
}
`,
      "src/main/java/app/web/ReportService.java": `package app.web;

public class ReportService {
  private final ReportRepository repository;

  ReportService(ReportRepository repository) {
    this.repository = repository;
  }

  void record() {
    repository.save();
  }
}
`,
      "src/main/java/app/web/ReportRepository.java": `package app.web;

public class ReportRepository {
  void save() {}
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", owned));
    expect((candidate.node as FlowNode).confidence).toBe("verified");
    expect(gateCandidate(owned, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("cuts a cycle rather than following it, and says the recursion is why", async () => {
    const ctx = contextFor({
      "src/main/java/app/cli/Loop.java": `package app.cli;

public class Loop {
  public static void main(String[] args) {
    step(args.length);
  }

  static int step(int n) {
    return bounce(n);
  }

  static int bounce(int n) {
    return step(n - 1);
  }
}
`,
    });
    const reason = absentReason(only(await runAdapter("flow-java-cli", ctx)));
    expect(reason).toContain("cycle_before_terminal");
    expect(reason).toContain("reach no terminal");
  }, 60_000);

  it("stops at the path bound rather than drawing a clipped story", async () => {
    const chain: Record<string, string> = {
      "src/main/java/app/cli/Deep.java": `package app.cli;

public class Deep {
  public static void main(String[] args) {
    Step0.run();
  }
}
`,
    };
    const depth = 20;
    for (let i = 0; i < depth; i += 1) {
      chain[`src/main/java/app/cli/Step${i}.java`] = `package app.cli;

public class Step${i} {
  static Terminal TERMINAL;

  public static void run() {
    ${i + 1 < depth ? `Step${i + 1}.run();` : "TERMINAL.writeRun();"}
  }
}
`;
    }
    chain["src/main/java/app/cli/Terminal.java"] = `package app.cli;

import org.springframework.data.jpa.repository.JpaRepository;

public interface Terminal extends JpaRepository<String, String> {
  void writeRun();
}
`;
    const reason = absentReason(only(await runAdapter("flow-java-cli", contextFor(chain))));
    expect(reason).toContain("trace_bound_before_terminal");
  }, 60_000);
});

/* ------------------------------------------------------- stable ids */

describe("the ids it mints", () => {
  const SELECTOR_SAFE = /^[A-Za-z][A-Za-z0-9_-]*$/;

  it("are selector-safe and do not move between runs over the same tree", async () => {
    const ctx = contextFor(LINEAR);
    const first = only(await runAdapter("flow-java-spring-http", ctx));
    const second = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = first.node as FlowNode;

    // A node id is used verbatim as the rendered element id, and the audit's
    // G1/G2/E1 checks resolve nodes by `querySelector("#id")`.
    expect(flow.id).toMatch(SELECTOR_SAFE);
    for (const step of flow.steps) expect(step.id, step.id).toMatch(SELECTOR_SAFE);
    for (const link of flow.links!) expect(link.id, link.id).toMatch(SELECTOR_SAFE);
    // Derived from the entry declaration rather than from the traced contents,
    // so a subject that gains a helper does not renumber the section's anchors.
    expect(second.node.id).toBe(flow.id);
    expect(JSON.stringify(second.node)).toBe(JSON.stringify(flow));
  }, 60_000);
});

/* --------------------------------------------- the gate is a check */

describe("the gate re-resolves the producer's claims rather than echoing them", () => {
  it("quarantines the whole Flow when one arrow no longer resolves", async () => {
    const ctx = contextFor(LINEAR);
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));

    // The same graph, against a tree where the service call was replaced. Every
    // other arrow still resolves, and the Flow is still cut whole: one broken
    // middle arrow invalidates the story on both sides.
    const moved = contextFor({
      ...LINEAR,
      "src/main/java/app/web/AttemptController.java": CONTROLLER.replace(
        "Attempt saved = attempts.submit(id, request);",
        "Attempt saved = new Attempt(id);",
      ),
    });
    const repinned = JSON.parse(
      JSON.stringify(candidate).replaceAll(ctx.sha, moved.sha),
    ) as Candidate;
    const gated = gateCandidate(moved, repinned);
    expect(gated.node.confidence).toBe("absent");
    expect(gated.finding).toContain("quarantined atomically");
  }, 60_000);

  it("quarantines a route whose declared verb no longer matches", async () => {
    const ctx = contextFor(LINEAR);
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const moved = contextFor({
      ...LINEAR,
      "src/main/java/app/web/AttemptController.java": CONTROLLER.replace(
        '@PostMapping("/{id}/submit")',
        '@PutMapping("/{id}/submit")',
      ),
    });
    const repinned = JSON.parse(
      JSON.stringify(candidate).replaceAll(ctx.sha, moved.sha),
    ) as Candidate;
    expect(gateCandidate(moved, repinned).node.confidence).toBe("absent");
  }, 60_000);
});

/* --------------------------------------------- adapters and absence */

describe("each adapter reports its own applicability by name", () => {
  const outcomeFor = (outcomes: ProbeOutcome[], id: string): ProbeOutcome =>
    outcomes.find((o) => o.probe_id === id)!;

  it("is registered separately, so one entry family cannot answer for another", () => {
    expect(PROBES.map((p) => p.id)).toContain("flow-java-spring-http");
    expect(PROBES.map((p) => p.id)).toContain("flow-java-cli");
  });

  it("says a plain-Java subject runs no Spring, rather than reporting no routes", async () => {
    const ctx = contextFor({
      "src/main/java/app/cli/Tool.java": `package app.cli;

public class Tool {
  public static void main(String[] args) {
    System.out.println(args.length);
  }
}
`,
    });
    const { outcomes } = await runProbes(ctx);
    const http = outcomeFor(outcomes, "flow-java-spring-http");
    expect(http.status).toBe("not_applicable");
    expect(http.status === "not_applicable" && http.reason).toContain("org.springframework");
    // The CLI adapter DID apply here: it ran and found the one real main.
    const cli = outcomeFor(outcomes, "flow-java-cli");
    expect(cli.status).toBe("ran");
  }, 120_000);

  it("distinguishes an adapter that ran and found nothing from one that did not apply", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/Service.java": `package app.web;

import org.springframework.stereotype.Service;

@Service
public class Service {
  public String hello() { return "hello"; }
}
`,
    });
    const { outcomes } = await runProbes(ctx);
    const http = outcomeFor(outcomes, "flow-java-spring-http");
    // Spring is here, so the adapter applies; it declares no route, so it ran
    // and produced nothing. Those are different findings and read differently.
    expect(http.status).toBe("ran");
    expect(http.status === "ran" && http.candidates).toHaveLength(0);
    const cli = outcomeFor(outcomes, "flow-java-cli");
    expect(cli.status).toBe("ran");
    expect(cli.status === "ran" && cli.candidates).toHaveLength(0);
  }, 120_000);
});

/* ------------------------------------- the audit reads what it emits */

describe("a produced Flow satisfies the audit's static evidence gates", () => {
  it("resolves every citation and establishes every rendered relationship", async () => {
    const ctx = contextFor(LINEAR);
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const atlas = {
      schema_version: "1.1.0",
      generated_at: "2026-08-21T00:00:00Z",
      profile: "interview",
      rubric_version: "interview-v1",
      subject: {
        owner: "o",
        repo: "r",
        url: "https://example.invalid/o/r",
        branch: "main",
        sha: ctx.sha,
        read_on: "2026-08-21",
        visibility: "public",
      },
      synopsis: { statement: "s", evidence: [] },
      shape: { tree: "t", evidence: [] },
      nodes: [{ ...(candidate.node as FlowNode), interview_value: 4 }],
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
    } as unknown as Atlas;
    const auditCtx = { artifact: "", atlas, clone: ctx.clone };

    const [l1, l2] = resolveFileEvidence(auditCtx);
    expect(l1.outcome, JSON.stringify(l1.findings)).toBe("passed");
    expect(l2.outcome, JSON.stringify(l2.findings)).toBe("passed");
    const e2 = presentTenseClaims(auditCtx);
    expect(e2.outcome, JSON.stringify(e2.findings)).toBe("passed");
  }, 60_000);
});
