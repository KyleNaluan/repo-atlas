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
    // The local-typed receiver still resolves - the repository read reached
    // through it is on the retained path - but the service reached through a
    // LOCAL is not a member the controller HOLDS, so it folds into the caller's
    // box rather than standing alone; its method is still named in that box's
    // detail so the arrow it makes keeps a named endpoint. The static helper that
    // goes nowhere is not drawn as an ending.
    expect(flow.steps.map((s) => s.id)).toEqual([
      "mixedcontroller-read",
      "attemptrepository-findlatest",
      "echo-of",
    ]);
    expect(flow.steps[0]!.detail).toContain("AttemptService.lookup()");
    expect(flow.links!.find((l) => l.to === "attemptrepository-findlatest")!.relation).toBe("read");
    // The read claim is re-resolved from lookup's OWN source, not the folded box.
    expect(candidate.flow_claims!.find((c) => c.matcher === "data_access")!.from.name).toBe(
      "lookup",
    );
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
    // `main` and `load` are two methods of ONE component, so they are one box and
    // the arrow between them is not drawn (#35, PR 5's landmark compression). The
    // arrow that crosses into the repository is the story.
    expect(flow.steps.map((s) => s.id)).toEqual(["importer-main", "contentrepository-savecontent"]);
    expect(flow.links!.map((l) => l.relation)).toEqual(["write"]);
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

  it("cuts a story at an OPEN implementation set instead of picking one", async () => {
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

import org.springframework.stereotype.Component;

@Component
public class TestCaseGrader implements Grader {
  public String grade(String exercise) { return "PASSED"; }
}
`,
      // A second implementation the container does NOT manage: no stereotype, no
      // sealed base, no shared guard or key. Nothing in the tree closes the set,
      // so PR 5's closed-set resolution declines it exactly as PR 4 declined every
      // interface - a set that might be missing a member is worse than an open one.
      "src/main/java/app/web/AnswerKeyGrader.java": `package app.web;

public class AnswerKeyGrader implements Grader {
  public String grade(String exercise) { return "FAILED"; }
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

  it("names a lambda parameter it types from the injected collection, rather than drawing an edge the gate cannot re-read", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/NotifyController.java": `package app.web;

import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
public class NotifyController {
  private final List<Handler> handlers;
  private final AuditRepository audit;

  NotifyController(List<Handler> handlers, AuditRepository audit) {
    this.handlers = handlers;
    this.audit = audit;
  }

  @PostMapping("/notify")
  public String notify(@RequestBody String event) {
    handlers.forEach(h -> h.handle(event));
    return audit.saveEvent(event);
  }
}
`,
      "src/main/java/app/web/Handler.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class Handler {
  void handle(String event) {}
}
`,
      "src/main/java/app/web/AuditRepository.java": `package app.web;

import org.springframework.stereotype.Repository;

@Repository
public class AuditRepository {
  public String saveEvent(String value) { return value; }
}
`,
    });
    // `h` is a lambda parameter the injected `List<Handler>` element type lets this
    // phase RECOGNISE, but the gate re-types a receiver only from the declarations
    // in the calling file, and a lambda parameter has none there - it is bound by
    // the call site's functional interface. Drawing an edge through it would be a
    // real chain returning as a confusing quarantine (the gate overturns it), so
    // the call is named as a gap instead. `saveEvent` reaches a durable write, so
    // the entry does reach a terminal: without the blind mark this Flow would come
    // back VERIFIED with the forEach drawn, then be overturned at the gate. The
    // named cut is the honest form, and it pins both halves of the invariant.
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const reason = absentReason(candidate);
    expect(reason).toMatch(/^unresolved_receiver_type:/);
    expect(reason).toContain("calls handle on `h`");
    expect(reason).toContain("lambda parameter");
    expect(gateCandidate(ctx, candidate).node.confidence).toBe("absent");
  }, 60_000);

  it("traces a direct call inherited from a subject supertype, and the gate re-resolves the inheritance itself", async () => {
    // The base-service pattern: a controller calls, through a field typed as the
    // subtype, a method the subtype INHERITS from a subject-owned base class.
    // PR 4 named this as a limit and drew no arrow, because the gate re-typed a
    // receiver only from the declarations in the calling file: it searched for a
    // `BaseReportService` variable, found a `ReportService` field, and overturned
    // a real chain. PR 5 makes the gate subtype-aware instead - the claim says
    // which type the call was WRITTEN on beside the type that declares the target,
    // and the gate re-derives the `extends` relation from the blob rather than
    // believing it. The reference subject needs exactly this (`Exercise.id()`
    // declared on the sealed `Content` it implements), so it is in scope here.
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
    const viaBase = only(await runAdapter("flow-java-spring-http", inherited));
    expect((viaBase.node as FlowNode).confidence).toBe("verified");
    // The claim names both types: where the target is declared, and what the
    // caller's source actually writes. The gate needs the second to re-type the
    // receiver and the first to find the declaration.
    const inheritedClaim = viaBase.flow_claims!.find((c) => c.to?.name === "record")!;
    expect(inheritedClaim.to!.owner).toContain("BaseReportService");
    expect(inheritedClaim.to!.receiver).toContain("ReportService");
    expect(gateCandidate(inherited, viaBase).verdict).toBe("confirmed");

    // The counterpart: move `record()` onto ReportService's OWN type and the same
    // call site is the same traced edge. Nothing about the receiver or the
    // terminal changed, and neither does the outcome.
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

  it("traces a durable write on a local declared inside a lambda, but names one out of scope", async () => {
    // Scoping locals to the method-body-minus-nested-scopes excluded a local
    // declared inside a lambda from the receiver map, while the walk still traces
    // the invocations inside that lambda. A `repo.saveAttempt(item)` on such a
    // local then fell through as foreign and was dropped SILENTLY: the write
    // vanished from a Flow that still reached a terminal through the response and
    // rendered verified - a durable write missing from a confident picture, which
    // the gate never re-resolves because it re-resolves emitted claims, not
    // omitted edges. The receiver is now resolved from the call site's own scope
    // chain, so the write is traced.
    const inLambda = contextFor({
      "src/main/java/app/web/ImportController.java": `package app.web;

import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
public class ImportController {
  private final AttemptRepository repository;

  ImportController(AttemptRepository repository) {
    this.repository = repository;
  }

  @PostMapping("/import")
  public RunResponse importAll(@RequestBody List<Attempt> items) {
    items.forEach(item -> {
      AttemptRepository repo = repository;
      repo.saveAttempt(item);
    });
    return RunResponse.of(items);
  }
}
`,
      "src/main/java/app/web/AttemptRepository.java": REPOSITORY,
      "src/main/java/app/web/RunResponse.java": RESPONSE,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", inLambda));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    const write = flow.links!.find((l) => l.to === "attemptrepository-saveattempt");
    expect(write, "the durable write inside the lambda must be traced").toBeDefined();
    expect(write!.relation).toBe("write");
    // The gate re-resolves it too: `typedReceivers` finds the `AttemptRepository
    // repo` declaration by scanning the whole calling file, so it re-types a
    // lambda-local receiver as readily as a method-level one. Typing these reopens
    // none of the producer/gate divergence the other named limits exist for.
    expect(gateCandidate(inLambda, candidate).verdict).toBe("confirmed");

    // The counterpart pins that the scope check actually restricts rather than
    // resolving everything method-wide again: an identifier whose local is
    // declared in a SIBLING lambda is out of scope at the call site. It is neither
    // typed wrongly (the pre-scope over-collection) nor dropped in silence (the
    // regression); it fails closed by name, so a subject-shaped identifier
    // receiver always ends in a resolved edge or a named gap.
    const outOfScope = contextFor({
      "src/main/java/app/web/SplitController.java": `package app.web;

import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
public class SplitController {
  private final AttemptRepository repository;

  SplitController(AttemptRepository repository) {
    this.repository = repository;
  }

  @PostMapping("/split")
  public String split(@RequestBody List<Attempt> first, List<Attempt> second) {
    first.forEach(a -> {
      AttemptRepository repo = repository;
      repo.saveAttempt(a);
    });
    second.forEach(b -> repo.saveAttempt(b));
    return "ok";
  }
}
`,
      "src/main/java/app/web/AttemptRepository.java": REPOSITORY,
    });
    const reason = absentReason(only(await runAdapter("flow-java-spring-http", outOfScope)));
    expect(reason).toMatch(/^unresolved_receiver_type:/);
    expect(reason).toContain("repo");
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

  // The producer's localAccessor() rule admits ONE chained receiver: a bare
  // accessor declared in the calling file, called with no receiver of its own
  // (`svc().record(...)`), because the file states that accessor's return type
  // and the gate re-reads exactly that. The gate must re-resolve it for a
  // CONCRETE target the same way it already does for a dispatch, so a real chain
  // is not traced-then-overturned. Both `verified` AND `confirmed` are the point:
  // the bug produced verified-then-quarantined.
  it("re-resolves a direct_call written on a local accessor to a bean", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/AccessorController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class AccessorController {
  private final AttemptService service;

  AccessorController(AttemptService service) {
    this.service = service;
  }

  @PostMapping("/accessor")
  public String submit(String body) {
    return svc().record(body);
  }

  private AttemptService svc() {
    return service;
  }
}
`,
      "src/main/java/app/web/AttemptService.java": `package app.web;

import org.springframework.stereotype.Service;

@Service
public class AttemptService {
  private final AttemptRepository attempts;

  AttemptService(AttemptRepository attempts) {
    this.attempts = attempts;
  }

  public String record(String body) {
    return attempts.saveAttempt(body).toString();
  }
}
`,
      "src/main/java/app/web/AttemptRepository.java": `package app.web;

import org.springframework.data.jpa.repository.JpaRepository;

public interface AttemptRepository extends JpaRepository<Attempt, UUID> {
  Attempt saveAttempt(String body);
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    const direct = candidate.flow_claims!.find((c) => c.matcher === "direct_call")!;
    expect(direct.from.name).toBe("submit");
    expect(direct.to!.name).toBe("record");
    const gated = gateCandidate(ctx, candidate);
    expect(gated.verdict, gated.finding).toBe("confirmed");
    expect(gated.node.confidence).toBe("verified");
  }, 60_000);

  it("re-resolves a data_access written on a local accessor to a repository", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/RepoController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class RepoController {
  private final AttemptRepository attempts;

  RepoController(AttemptRepository attempts) {
    this.attempts = attempts;
  }

  @PostMapping("/repo")
  public String submit(String body) {
    return repo().saveAttempt(body).toString();
  }

  private AttemptRepository repo() {
    return attempts;
  }
}
`,
      "src/main/java/app/web/AttemptRepository.java": `package app.web;

import org.springframework.data.jpa.repository.JpaRepository;

public interface AttemptRepository extends JpaRepository<Attempt, UUID> {
  Attempt saveAttempt(String body);
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    expect((candidate.node as FlowNode).confidence).toBe("verified");
    const data = candidate.flow_claims!.find((c) => c.matcher === "data_access")!;
    expect(data.from.name).toBe("submit");
    expect(data.to!.name).toBe("saveAttempt");
    const gated = gateCandidate(ctx, candidate);
    expect(gated.verdict, gated.finding).toBe("confirmed");
    expect(gated.node.confidence).toBe("verified");
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

/* ------------------------------- closed-set dispatch (#35, PR 5) */

describe("dispatch through an interface the subject's own wiring closes", () => {
  const SPRING_CONTROLLER = `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class CatalogController {
  private final CatalogService service;

  CatalogController(CatalogService service) {
    this.service = service;
  }

  @GetMapping("/api/items/{id}")
  public String get(@PathVariable String id) {
    return service.title(id);
  }
}
`;

  const SERVICE = `package app.web;

import org.springframework.stereotype.Service;

@Service
public class CatalogService {
  private final Catalog catalog;

  CatalogService(Catalog catalog) {
    this.catalog = catalog;
  }

  public String title(String id) {
    return catalog.byId(id);
  }
}
`;

  const CATALOG = `package app.web;

public interface Catalog {
  String byId(String id);
}
`;

  const REPOSITORY = `package app.web;

import org.springframework.stereotype.Repository;

@Repository
public class ItemRepository {
  public String findTitle(String id) { return id; }
}
`;

  it("resolves a sole implementation, because Spring has nothing to choose between", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/CatalogController.java": SPRING_CONTROLLER,
      "src/main/java/app/web/CatalogService.java": SERVICE,
      "src/main/java/app/web/Catalog.java": CATALOG,
      "src/main/java/app/web/FileCatalog.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class FileCatalog implements Catalog {
  private final ItemRepository items;

  FileCatalog(ItemRepository items) {
    this.items = items;
  }

  public String byId(String id) {
    return items.findTitle(id);
  }
}
`,
      "src/main/java/app/web/ItemRepository.java": REPOSITORY,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    // The arrow is a dispatch, not a call: what it asserts is that the set the
    // call can reach is closed at one, which is a claim about the whole tree.
    const dispatch = flow.links!.find((l) => l.relation === "dispatch")!;
    expect(dispatch.label).toContain("byId");
    expect(dispatch.evidence).toHaveLength(2);
    const claim = candidate.flow_claims!.find((c) => c.link_id === dispatch.id)!;
    expect(claim.matcher).toBe("closed_dispatch");
    expect(claim.dispatch!.via).toBe("sole_implementation");
    expect(claim.dispatch!.member_count).toBe(1);
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("keeps a multi-implementation set with no guard OPEN when nothing closes it", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/CatalogController.java": SPRING_CONTROLLER,
      "src/main/java/app/web/CatalogService.java": SERVICE,
      "src/main/java/app/web/Catalog.java": CATALOG,
      // One bean and one plain class: the container manages only half the set, so
      // the tree does not say what a call through `Catalog` can reach.
      "src/main/java/app/web/FileCatalog.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class FileCatalog implements Catalog {
  public String byId(String id) { return id; }
}
`,
      "src/main/java/app/web/MemoryCatalog.java": `package app.web;

public class MemoryCatalog implements Catalog {
  public String byId(String id) { return id; }
}
`,
      "src/main/java/app/web/ItemRepository.java": REPOSITORY,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    expect(candidate.node.confidence).toBe("absent");
    expect(candidate.absent_reason).toMatch(/^unresolved_dispatch:/);
    expect(candidate.absent_reason).toContain("no Spring stereotype");
    expect(gateCandidate(ctx, candidate).node.confidence).toBe("absent");
  }, 60_000);

  it("picks each branch of a supports()-guarded registry over a sealed hierarchy", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/GradeController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class GradeController {
  private final GraderRegistry graders;

  GradeController(GraderRegistry graders) {
    this.graders = graders;
  }

  @PostMapping("/api/grade")
  public String grade(@RequestBody String body) {
    return graders.grade(new Exercise(new Grading.TestCases()), body);
  }
}
`,
      "src/main/java/app/web/GraderRegistry.java": `package app.web;

import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class GraderRegistry {
  private final List<Grader> graders;

  GraderRegistry(List<Grader> graders) {
    this.graders = List.copyOf(graders);
  }

  public String grade(Exercise exercise, String submission) {
    return graderFor(exercise).grade(exercise, submission);
  }

  private Grader graderFor(Exercise exercise) {
    return graders.stream().filter(grader -> grader.supports(exercise)).findFirst().orElseThrow();
  }
}
`,
      "src/main/java/app/web/Grading.java": `package app.web;

public sealed interface Grading permits Grading.TestCases, Grading.AnswerKey {
  record TestCases() implements Grading {}
  record AnswerKey() implements Grading {}
}
`,
      "src/main/java/app/web/Exercise.java": `package app.web;

public record Exercise(Grading grading) {}
`,
      "src/main/java/app/web/Grader.java": `package app.web;

public interface Grader {
  boolean supports(Exercise exercise);
  String grade(Exercise exercise, String submission);
}
`,
      "src/main/java/app/web/TestCaseGrader.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class TestCaseGrader implements Grader {
  private final ResultRepository results;

  TestCaseGrader(ResultRepository results) {
    this.results = results;
  }

  public boolean supports(Exercise exercise) {
    return exercise.grading() instanceof Grading.TestCases;
  }

  public String grade(Exercise exercise, String submission) {
    return results.saveResult(submission);
  }
}
`,
      "src/main/java/app/web/AnswerKeyGrader.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class AnswerKeyGrader implements Grader {
  private final ResultRepository results;

  AnswerKeyGrader(ResultRepository results) {
    this.results = results;
  }

  public boolean supports(Exercise exercise) {
    return exercise.grading() instanceof Grading.AnswerKey;
  }

  public String grade(Exercise exercise, String submission) {
    return results.saveResult(submission);
  }
}
`,
      "src/main/java/app/web/ResultRepository.java": `package app.web;

import org.springframework.stereotype.Repository;

@Repository
public class ResultRepository {
  public String saveResult(String value) { return value; }
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    // Both branches are drawn, each labelled by the permitted record its own
    // `supports()` tests for. Picking the "obvious" one would assert an execution
    // the tree never states; drawing neither would lose the seam entirely.
    const dispatches = flow.links!.filter((l) => l.relation === "dispatch");
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((l) => l.label).sort().join(" ")).toContain("Grading.AnswerKey");
    expect(dispatches.map((l) => l.label).sort().join(" ")).toContain("Grading.TestCases");
    for (const link of dispatches) {
      const claim = candidate.flow_claims!.find((c) => c.link_id === link.id)!;
      expect(claim.dispatch!.via).toBe("sealed_guard");
      expect(claim.dispatch!.member_count).toBe(2);
    }
    // The guard call itself is dispatch machinery, not a step of the story: the
    // figure shows what the registry routes to, not how it decided.
    expect(flow.steps.map((s) => s.node)).not.toContain("supports");
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("names each branch of a keyed registry by the literal key its bean declares", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/RunController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class RunController {
  private final RunnerRegistry runners;

  RunController(RunnerRegistry runners) {
    this.runners = runners;
  }

  @PostMapping("/api/run")
  public String run(@RequestBody String body) {
    Runner runner = runners.forLanguage("java");
    return runner.execute(body);
  }
}
`,
      "src/main/java/app/web/RunnerRegistry.java": `package app.web;

import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class RunnerRegistry {
  private final List<Runner> runners;

  RunnerRegistry(List<Runner> runners) {
    this.runners = List.copyOf(runners);
  }

  public Runner forLanguage(String id) {
    return runners.get(0);
  }
}
`,
      "src/main/java/app/web/Runner.java": `package app.web;

public interface Runner {
  String languageId();
  String execute(String submission);
}
`,
      "src/main/java/app/web/JavaRunner.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class JavaRunner implements Runner {
  private final RunRepository runs;

  JavaRunner(RunRepository runs) {
    this.runs = runs;
  }

  public String languageId() { return "java"; }

  public String execute(String submission) {
    return runs.saveRun(submission);
  }
}
`,
      "src/main/java/app/web/PythonRunner.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class PythonRunner implements Runner {
  private final RunRepository runs;

  PythonRunner(RunRepository runs) {
    this.runs = runs;
  }

  public String languageId() { return "python" ; }

  public String execute(String submission) {
    return runs.saveRun(submission);
  }
}
`,
      "src/main/java/app/web/RunRepository.java": `package app.web;

import org.springframework.stereotype.Repository;

@Repository
public class RunRepository {
  public String saveRun(String value) { return value; }
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    const dispatches = flow.links!.filter((l) => l.relation === "dispatch");
    expect(dispatches).toHaveLength(2);
    const labels = dispatches.map((l) => l.label).join(" ");
    expect(labels).toContain('"java"');
    // PythonRunner writes `return "python" ;` with a space before the semicolon.
    // The producer reads the key off the AST and is formatting-agnostic, so the
    // gate must be too: an exact `return "python";` substring check would miss
    // this and contradict a genuine branch, quarantining the whole Flow. The
    // `confirmed` assertion below is what would fail if the gate went exact.
    expect(labels).toContain('"python"');
    for (const link of dispatches) {
      expect(candidate.flow_claims!.find((c) => c.link_id === link.id)!.dispatch!.via).toBe("keyed_registry");
    }
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("MUTANT: an implementation added since the trace contradicts the closed set", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/CatalogController.java": SPRING_CONTROLLER,
      "src/main/java/app/web/CatalogService.java": SERVICE,
      "src/main/java/app/web/Catalog.java": CATALOG,
      "src/main/java/app/web/FileCatalog.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class FileCatalog implements Catalog {
  private final ItemRepository items;

  FileCatalog(ItemRepository items) {
    this.items = items;
  }

  public String byId(String id) {
    return items.findTitle(id);
  }
}
`,
      "src/main/java/app/web/ItemRepository.java": REPOSITORY,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");

    // The mutant is the whole point of a closed-set claim: nothing about the
    // drawn arrow's own two endpoints changed, and the target still exists. A
    // gate that only re-found the target would confirm a picture that is now
    // false, because the call can reach a second implementation.
    const grown = contextFor({
      "src/main/java/app/web/CatalogController.java": SPRING_CONTROLLER,
      "src/main/java/app/web/CatalogService.java": SERVICE,
      "src/main/java/app/web/Catalog.java": CATALOG,
      "src/main/java/app/web/FileCatalog.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class FileCatalog implements Catalog {
  private final ItemRepository items;

  FileCatalog(ItemRepository items) {
    this.items = items;
  }

  public String byId(String id) {
    return items.findTitle(id);
  }
}
`,
      "src/main/java/app/web/MemoryCatalog.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class MemoryCatalog implements Catalog {
  public String byId(String id) { return id; }
}
`,
      "src/main/java/app/web/ItemRepository.java": REPOSITORY,
    });
    const repinned = JSON.parse(
      JSON.stringify(candidate).replaceAll(ctx.sha, grown.sha),
    ) as Candidate;
    const gated = gateCandidate(grown, repinned);
    expect(gated.node.confidence).toBe("absent");
    expect(gated.finding).toContain("not the 1 this arrow closed the set at");
  }, 60_000);

  it("resolves a member that inherits the dispatched method from an abstract base", async () => {
    // Two @Component subclasses close the set, but NEITHER declares byId - they
    // inherit it from an abstract intermediate. The producer's methodOn() follows
    // supertypes, so the arrow's target file is that abstract base, which the set
    // deliberately excludes as a waypoint. A gate that required the target's file
    // to be one of the concrete implementations would contradict a real chain and
    // quarantine the whole Flow, so it re-derives the base as a supertype of a
    // member from source instead.
    const ctx = contextFor({
      "src/main/java/app/web/CatalogController.java": SPRING_CONTROLLER,
      "src/main/java/app/web/CatalogService.java": SERVICE,
      "src/main/java/app/web/Catalog.java": CATALOG,
      "src/main/java/app/web/BaseCatalog.java": `package app.web;

public abstract class BaseCatalog implements Catalog {
  private final ItemRepository items;

  BaseCatalog(ItemRepository items) {
    this.items = items;
  }

  public String byId(String id) {
    return items.findTitle(id);
  }
}
`,
      "src/main/java/app/web/FileCatalog.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class FileCatalog extends BaseCatalog {
  FileCatalog(ItemRepository items) {
    super(items);
  }
}
`,
      "src/main/java/app/web/MemoryCatalog.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class MemoryCatalog extends BaseCatalog {
  MemoryCatalog(ItemRepository items) {
    super(items);
  }
}
`,
      "src/main/java/app/web/ItemRepository.java": REPOSITORY,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    const dispatch = flow.links!.find((l) => l.relation === "dispatch")!;
    expect(dispatch.label).toContain("byId");
    const claim = candidate.flow_claims!.find((c) => c.link_id === dispatch.id)!;
    expect(claim.dispatch!.member_count).toBe(2);
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("confirms a labelled dispatch whose method is inherited from an abstract base", async () => {
    // The dispatched byId() is declared on an abstract intermediate that both
    // @Component catalogs inherit without overriding, so the arrow's target file is
    // that abstract base - but each branch's `instanceof` guard lives in its own
    // concrete implementation, not the base. A gate that validated the sealed_guard
    // labels only against the arrow's target file (as it did before) would find
    // neither guard there, contradict a genuine branch, and quarantine the whole
    // Flow. The `verified` + `confirmed` pairing is the point: the producer draws
    // this either way, so a test checking only the producer would pass while the
    // gate overturned it.
    const ctx = contextFor({
      "src/main/java/app/web/CatalogController.java": SPRING_CONTROLLER,
      "src/main/java/app/web/CatalogService.java": SERVICE,
      "src/main/java/app/web/Catalog.java": `package app.web;

public interface Catalog {
  boolean supports(Grading grading);
  String byId(String id);
}
`,
      "src/main/java/app/web/Grading.java": `package app.web;

public sealed interface Grading permits Grading.ByKey, Grading.ByName {
  record ByKey() implements Grading {}
  record ByName() implements Grading {}
}
`,
      "src/main/java/app/web/AbstractCatalog.java": `package app.web;

public abstract class AbstractCatalog implements Catalog {
  private final ItemRepository items;

  AbstractCatalog(ItemRepository items) {
    this.items = items;
  }

  public String byId(String id) {
    return items.findTitle(id);
  }
}
`,
      "src/main/java/app/web/FileCatalog.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class FileCatalog extends AbstractCatalog {
  FileCatalog(ItemRepository items) {
    super(items);
  }

  public boolean supports(Grading grading) {
    return grading instanceof Grading.ByKey;
  }
}
`,
      "src/main/java/app/web/MemoryCatalog.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class MemoryCatalog extends AbstractCatalog {
  MemoryCatalog(ItemRepository items) {
    super(items);
  }

  public boolean supports(Grading grading) {
    return grading instanceof Grading.ByName;
  }
}
`,
      "src/main/java/app/web/ItemRepository.java": REPOSITORY,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    const dispatches = flow.links!.filter((l) => l.relation === "dispatch");
    expect(dispatches.length).toBeGreaterThan(0);
    const labels = dispatches.map((l) => l.label).join(" ");
    expect(labels).toContain("Grading.ByKey");
    expect(labels).toContain("Grading.ByName");
    for (const link of dispatches) {
      const claim = candidate.flow_claims!.find((c) => c.link_id === link.id)!;
      expect(claim.dispatch!.via).toBe("sealed_guard");
      expect(claim.dispatch!.member_count).toBe(2);
    }
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("confirms a closed set whose beans are @ControllerAdvice / @RestControllerAdvice", async () => {
    // The producer's bean check and the gate's stereotype check are two readings
    // of one list, and they had drifted: the gate's regex omitted ControllerAdvice
    // and its `@Controller\b` could not match `@ControllerAdvice` anyway. So a set
    // the producer counted as container-managed (every member a bean) was one the
    // gate reported as unmanaged, contradicting a real closed_set arrow and
    // quarantining the whole Flow. The verified + confirmed pairing is the point:
    // the producer draws this either way, so a producer-only test would pass while
    // the gate overturned it.
    const ctx = contextFor({
      "src/main/java/app/web/CatalogController.java": SPRING_CONTROLLER,
      "src/main/java/app/web/CatalogService.java": SERVICE,
      "src/main/java/app/web/Catalog.java": CATALOG,
      "src/main/java/app/web/FileCatalog.java": `package app.web;

import org.springframework.web.bind.annotation.ControllerAdvice;

@ControllerAdvice
public class FileCatalog implements Catalog {
  private final ItemRepository items;

  FileCatalog(ItemRepository items) {
    this.items = items;
  }

  public String byId(String id) {
    return items.findTitle(id);
  }
}
`,
      "src/main/java/app/web/MemoryCatalog.java": `package app.web;

import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class MemoryCatalog implements Catalog {
  private final ItemRepository items;

  MemoryCatalog(ItemRepository items) {
    this.items = items;
  }

  public String byId(String id) {
    return items.findTitle(id.trim());
  }
}
`,
      "src/main/java/app/web/ItemRepository.java": REPOSITORY,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    const dispatches = flow.links!.filter((l) => l.relation === "dispatch");
    expect(dispatches).toHaveLength(2);
    for (const link of dispatches) {
      const claim = candidate.flow_claims!.find((c) => c.link_id === link.id)!;
      expect(claim.dispatch!.via).toBe("closed_set");
      expect(claim.dispatch!.member_count).toBe(2);
    }
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("confirms a sealed_guard whose instanceof names the type by its full package", async () => {
    // The producer normalises the guard type through qualifiedTypeName, which drops
    // lowercase package segments, so `instanceof app.web.Grading.TestCases` becomes
    // the label `Grading.TestCases`. A gate that required that label immediately
    // after `instanceof` would be defeated by the intervening `app.web.` and report
    // the branch missing, contradicting a genuine guard. The gate strips the same
    // optional package path the producer does, so the two derivations agree.
    const ctx = contextFor({
      "src/main/java/app/web/GradeController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class GradeController {
  private final GraderRegistry graders;

  GradeController(GraderRegistry graders) {
    this.graders = graders;
  }

  @PostMapping("/api/grade")
  public String grade(@RequestBody String body) {
    return graders.grade(new Exercise(new Grading.TestCases()), body);
  }
}
`,
      "src/main/java/app/web/GraderRegistry.java": `package app.web;

import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class GraderRegistry {
  private final List<Grader> graders;

  GraderRegistry(List<Grader> graders) {
    this.graders = List.copyOf(graders);
  }

  public String grade(Exercise exercise, String submission) {
    return graderFor(exercise).grade(exercise, submission);
  }

  private Grader graderFor(Exercise exercise) {
    return graders.stream().filter(grader -> grader.supports(exercise)).findFirst().orElseThrow();
  }
}
`,
      "src/main/java/app/web/Grading.java": `package app.web;

public sealed interface Grading permits Grading.TestCases, Grading.AnswerKey {
  record TestCases() implements Grading {}
  record AnswerKey() implements Grading {}
}
`,
      "src/main/java/app/web/Exercise.java": `package app.web;

public record Exercise(Grading grading) {}
`,
      "src/main/java/app/web/Grader.java": `package app.web;

public interface Grader {
  boolean supports(Exercise exercise);
  String grade(Exercise exercise, String submission);
}
`,
      "src/main/java/app/web/TestCaseGrader.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class TestCaseGrader implements Grader {
  private final ResultRepository results;

  TestCaseGrader(ResultRepository results) {
    this.results = results;
  }

  public boolean supports(Exercise exercise) {
    return exercise.grading() instanceof app.web.Grading.TestCases;
  }

  public String grade(Exercise exercise, String submission) {
    return results.saveResult(submission);
  }
}
`,
      "src/main/java/app/web/AnswerKeyGrader.java": `package app.web;

import org.springframework.stereotype.Component;

@Component
public class AnswerKeyGrader implements Grader {
  private final ResultRepository results;

  AnswerKeyGrader(ResultRepository results) {
    this.results = results;
  }

  public boolean supports(Exercise exercise) {
    return exercise.grading() instanceof app.web.Grading.AnswerKey;
  }

  public String grade(Exercise exercise, String submission) {
    return results.saveResult(submission);
  }
}
`,
      "src/main/java/app/web/ResultRepository.java": `package app.web;

import org.springframework.stereotype.Repository;

@Repository
public class ResultRepository {
  public String saveResult(String value) { return value; }
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    const dispatches = flow.links!.filter((l) => l.relation === "dispatch");
    expect(dispatches).toHaveLength(2);
    const labels = dispatches.map((l) => l.label).join(" ");
    expect(labels).toContain("Grading.TestCases");
    expect(labels).toContain("Grading.AnswerKey");
    for (const link of dispatches) {
      expect(candidate.flow_claims!.find((c) => c.link_id === link.id)!.dispatch!.via).toBe("sealed_guard");
    }
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);
});

/* ---------------------- boundary link kinds and compression (#35, PR 5) */

describe("the boundaries a story crosses, and the boxes it draws", () => {
  const ctxFor = () =>
    contextFor({
      "src/main/java/app/web/OrderController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class OrderController {
  private final OrderService orders;

  OrderController(OrderService orders) {
    this.orders = orders;
  }

  @PostMapping("/api/orders")
  public String place(@RequestBody String body) {
    return orders.place(body);
  }
}
`,
      "src/main/java/app/web/OrderService.java": `package app.web;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class OrderService {
  private final OrderRepository orders;
  private final Archiver archiver;

  OrderService(OrderRepository orders, Archiver archiver) {
    this.orders = orders;
    this.archiver = archiver;
  }

  @Transactional
  public String place(String body) {
    String id = Ids.next(body);
    orders.insert(id);
    archiver.archive(id);
    return id;
  }
}
`,
      // A static helper the service uses: an implementation detail of the service,
      // not a component beside it, so it belongs inside the service's box.
      "src/main/java/app/web/Ids.java": `package app.web;

public final class Ids {
  private Ids() {}

  static String next(String seed) {
    return seed.trim();
  }
}
`,
      "src/main/java/app/web/Archiver.java": `package app.web;

import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.stereotype.Component;

@Component
public class Archiver {
  public void archive(String id) {
    try {
      Files.writeString(Path.of("/tmp", id), id);
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }
}
`,
      "src/main/java/app/web/OrderRepository.java": `package app.web;

import org.springframework.stereotype.Repository;

@Repository
public class OrderRepository {
  public void insert(String id) {}
}
`,
    });

  it("names the transaction, the persistence write and the side effect beside the path", async () => {
    const ctx = ctxFor();
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");

    // The static id helper is not a box of its own: it is an implementation
    // detail of the component that calls it, and the subject's own wiring is what
    // says so - nothing holds it and nothing injects it. (It reaches no terminal
    // either, so pruning removes it from the story before compression sees it -
    // the two rules agree here rather than either one carrying the case alone.)
    expect(flow.steps.map((s) => s.node)).toEqual([
      "POST /api/orders",
      "OrderService",
      "OrderRepository",
      "Archiver",
    ]);
    const service = flow.steps.find((s) => s.node === "OrderService")!;
    // Spring's own declaration that this runs in a transaction, read rather than
    // inferred from the method's name.
    expect(service.detail).toContain("@Transactional");

    const byRelation = new Map(flow.links!.map((l) => [l.relation, l]));
    expect(byRelation.get("write")!.to).toBe("orderrepository-insert");
    // Writing the filesystem leaves the program, so it is a side effect drawn as
    // an aside - the same distinction the hand-made reference draws between the
    // graded path and the best-effort commit beside it.
    expect(byRelation.get("side_effect")!.to).toBe("archiver-archive");
    expect(byRelation.get("side_effect")!.kind).toBe("aside");
    expect(flow.steps.find((s) => s.node === "Archiver")!.kind).toBe("aside");
    expect(flow.steps.find((s) => s.node === "Archiver")!.detail).toContain("leaves the process");

    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);

  it("MUTANT: a compressed box that stops naming an arrow's endpoint is refused", async () => {
    // Compression is only honest while the gate can still match each claim to the
    // box it points at. `stepNamesSymbol` is that check, and it is why a box lists
    // the methods arrows actually touch rather than the first three it reached.
    const ctx = ctxFor();
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");

    const blinded = {
      ...candidate,
      node: {
        ...flow,
        steps: flow.steps.map((step) =>
          step.node === "OrderService" ? { ...step, node: "Box", detail: "does things" } : step,
        ),
      },
    } as Candidate;
    const gated = gateCandidate(ctx, blinded);
    expect(gated.node.confidence).toBe("absent");
    expect(gated.finding).toContain("do not agree with the rendered endpoint steps");
  }, 60_000);

  // A collaborator the handler CONSTRUCTS as a local (`new RepDeriver()`) is a
  // new-ed value builder, not a member the type holds, so it folds into the box
  // that builds it rather than standing beside it. Compression stays honest: the
  // folded helper's method is named in the calling box's detail, and the arrow it
  // makes is re-resolved from that method's own source. `heldReceiver` is narrowed
  // to a declared field, a constructor-injected member, or a method parameter -
  // the three the caller is HANDED - and an in-scope local is not one of them.
  it("folds a locally constructed helper into the box that builds it", async () => {
    const ctx = contextFor({
      "src/main/java/app/web/BuilderController.java": `package app.web;

import org.springframework.web.bind.annotation.*;

@RestController
public class BuilderController {
  private final OrderRepository orders;

  BuilderController(OrderRepository orders) {
    this.orders = orders;
  }

  @PostMapping("/build")
  public String place(@RequestBody String body) {
    RepDeriver deriver = new RepDeriver(orders);
    return deriver.derive(body);
  }
}
`,
      "src/main/java/app/web/RepDeriver.java": `package app.web;

public class RepDeriver {
  private final OrderRepository orders;

  RepDeriver(OrderRepository orders) {
    this.orders = orders;
  }

  String derive(String seed) {
    orders.insert(seed);
    return seed;
  }
}
`,
      "src/main/java/app/web/OrderRepository.java": `package app.web;

import org.springframework.stereotype.Repository;

@Repository
public class OrderRepository {
  public void insert(String id) {}
}
`,
    });
    const candidate = only(await runAdapter("flow-java-spring-http", ctx));
    const flow = candidate.node as FlowNode;
    expect(flow.confidence).toBe("verified");
    // The new-ed helper does not stand alone: no box carries its type.
    expect(flow.steps.map((s) => s.node)).toEqual(["POST /build", "OrderRepository"]);
    // Its method is named in the box that built it, so the write arrow leaving
    // that box still has a nameable endpoint.
    expect(flow.steps.find((s) => s.node === "POST /build")!.detail).toContain(
      "RepDeriver.derive(String)",
    );
    // And that write is re-resolved from derive's OWN source, not the folded box.
    expect(candidate.flow_claims!.find((c) => c.matcher === "data_access")!.from.name).toBe(
      "derive",
    );
    expect(gateCandidate(ctx, candidate).verdict).toBe("confirmed");
  }, 60_000);
});
