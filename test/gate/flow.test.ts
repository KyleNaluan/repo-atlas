import { describe, expect, it } from "vitest";
import { gateCandidate } from "../../src/gate/gate.js";
import type { Harvest } from "../../src/harvest/types.js";
import type { Candidate, FlowClaim, ProbeContext } from "../../src/probes/types.js";
import type { FileEvidence, FlowLink, FlowNode } from "../../src/schema/types.js";

const SHA = "a".repeat(40);

const contextFor = (files: Record<string, string>): ProbeContext => ({
  harvest: {} as Harvest,
  clone: "/subject",
  sha: SHA,
  paths: Object.keys(files),
  read: (path) => files[path] ?? null,
  parse: async () => null,
});

const file = (path: string): FileEvidence => ({ kind: "file", path, sha: SHA });

const directFiles = {
  "Caller.java": [
    "class Caller {",
    "  private final Target target;",
    "  void run() { target.execute(); }",
    "}",
  ].join("\n"),
  "Target.java": "class Target { void execute() {} }\n",
};

const directLink = (over: Partial<FlowLink> = {}): FlowLink => ({
  id: "caller-target",
  from: "caller",
  to: "target",
  relation: "call",
  label: "execute()",
  evidence: [file("Caller.java")],
  ...over,
});

const directFlow = (over: Partial<FlowNode> = {}): FlowNode => ({
  type: "flow",
  id: "fl-direct",
  title: "Caller to target",
  evidence: [],
  confidence: "attested",
  interview_value: 5,
  steps: [
    { id: "caller", node: "Caller.run", evidence: file("Caller.java") },
    { id: "target", node: "Target.execute", evidence: file("Target.java") },
  ],
  links: [directLink()],
  ...over,
});

const directClaim = (over: Partial<FlowClaim> = {}): FlowClaim => ({
  link_id: "caller-target",
  expect: "present",
  matcher: "direct_call",
  from: { path: "Caller.java", owner: "Caller", name: "run", arity: 0 },
  to: { path: "Target.java", owner: "Target", name: "execute", arity: 0 },
  evidence: [file("Caller.java")],
  ...over,
});

const candidate = (
  node: FlowNode = directFlow(),
  flowClaims: FlowClaim[] = [directClaim()],
): Candidate => ({ probe_id: "flow-test", node, flow_claims: flowClaims });

const lineageFiles: Record<string, string> = {
  // Line 2-4 is the durable read; line 5-7 is the write. Every lineage claim
  // cites the exact declaration, because "this file contains a SELECT somewhere"
  // establishes nothing about the method the arrow names.
  "Record.java": [
    "class Record {",
    "  List<Row> passed() {",
    "    return jdbc.sql(\"SELECT * FROM submission WHERE outcome = 'PASSED'\").list();",
    "  }",
    "  void insert(Row row) {",
    "    jdbc.sql(\"INSERT INTO submission (id) VALUES (:id)\").update();",
    "  }",
    "}",
  ].join("\n"),
  "Learned.java": [
    "class Learned {",
    "  private final Record record;",
    "  State state() { return Criterion.evaluate(record.passed()); }",
    "}",
  ].join("\n"),
  "Criterion.java": "class Criterion { static State evaluate(List<Row> rows) { return null; } }\n",
  "Other.java": "class Other { static State derive() { return null; } }\n",
};

const span = (path: string, line_start: number, line_end: number): FileEvidence => ({
  kind: "file",
  path,
  line_start,
  line_end,
  sha: SHA,
});

const CALL_SITE = span("Learned.java", 3, 3);
const READ_DECL = span("Record.java", 2, 4);
const WRITE_DECL = span("Record.java", 5, 7);

const independenceClaim = (): FlowClaim => ({
  expect: "absent",
  matcher: "reachability",
  from: { path: "Learned.java", owner: "Learned", name: "Learned" },
  to: { path: "Other.java", owner: "Other", name: "Other" },
  evidence: [span("Learned.java", 1, 1)],
});

const lineageCandidate = (
  over: {
    link?: Partial<FlowLink>;
    claim?: Partial<FlowClaim>;
    caption?: string;
    extra?: FlowClaim[];
  } = {},
): Candidate => {
  const link: FlowLink = {
    id: "record-learned",
    from: "record",
    to: "learned",
    relation: "read",
    kind: "response",
    label: "passed(...) where outcome = 'PASSED'",
    evidence: [CALL_SITE, READ_DECL],
    ...over.link,
  };
  const node: FlowNode = {
    type: "flow",
    id: "fl-record",
    title: "One record, its derivations",
    ...(over.caption === undefined ? {} : { caption: over.caption }),
    evidence: [],
    confidence: "attested",
    interview_value: 0,
    steps: [
      { id: "record", node: "Record", detail: "passed()\\linsert(Row)", evidence: READ_DECL },
      { id: "learned", node: "Learned", detail: "state()", evidence: CALL_SITE },
      { id: "criterion", node: "Criterion", detail: "evaluate(List)", evidence: file("Criterion.java") },
    ],
    links: [
      link,
      {
        id: "learned-criterion",
        from: "learned",
        to: "criterion",
        relation: "call",
        label: "evaluate(...)",
        evidence: [CALL_SITE],
      },
    ],
  };
  const claims: FlowClaim[] = [
    {
      link_id: "record-learned",
      expect: "present",
      matcher: "data_lineage",
      from: { path: "Learned.java", owner: "Learned", name: "state", arity: 0 },
      to: { path: "Record.java", owner: "Record", name: "passed", arity: 0 },
      evidence: [CALL_SITE, READ_DECL],
      ...over.claim,
    },
    {
      link_id: "learned-criterion",
      expect: "present",
      matcher: "direct_call",
      from: { path: "Learned.java", owner: "Learned", name: "state", arity: 0 },
      to: { path: "Criterion.java", owner: "Criterion", name: "evaluate", arity: 1 },
      evidence: [CALL_SITE],
    },
    ...(over.extra ?? []),
  ];
  return { probe_id: "flow-java-shared-state", node, flow_claims: claims };
};

describe("the atomic Flow gate", () => {
  it("promotes a complete direct-call chain to verified", () => {
    const result = gateCandidate(contextFor(directFiles), candidate());
    expect(result.verdict).toBe("confirmed");
    expect(result.node.confidence).toBe("verified");
    expect(result.finding).toContain("1 links independently resolved");
  });

  it("quarantines the whole Flow when one cited call names a different target", () => {
    const files: Record<string, string> = {
      ...directFiles,
      "Caller.java": directFiles["Caller.java"].replace("target.execute()", "target.cancel()"),
    };
    const flow = directFlow({
      steps: [
        { id: "caller", node: "Caller.run", evidence: file("Caller.java") },
        { id: "target", node: "Target.execute", evidence: file("Target.java") },
        { id: "terminal", node: "Terminal.done", evidence: file("Terminal.java") },
      ],
      links: [
        directLink(),
        {
          id: "target-terminal",
          from: "target",
          to: "terminal",
          relation: "call",
          label: "done()",
          evidence: [file("Target.java")],
        },
      ],
    });
    files["Target.java"] = "class Target { Terminal terminal; void execute() { terminal.done(); } }\n";
    files["Terminal.java"] = "class Terminal { void done() {} }\n";
    const claims = [
      directClaim(),
      directClaim({
        link_id: "target-terminal",
        from: { path: "Target.java", owner: "Target", name: "execute", arity: 0 },
        to: { path: "Terminal.java", owner: "Terminal", name: "done", arity: 0 },
        evidence: [file("Target.java")],
      }),
    ];

    const result = gateCandidate(contextFor(files), candidate(flow, claims));
    expect(result.verdict).toBe("overturned");
    expect(result.node.type).toBe("flow");
    expect(result.node.confidence).toBe("absent");
    expect(result.node.type === "flow" && result.node.links).toHaveLength(2);
    expect(result.finding).toContain("link caller-target");
  });

  it("does not resolve a same-name call through an unrelated receiver type", () => {
    const files = {
      ...directFiles,
      "Caller.java": [
        "class Caller {",
        "  private final Target target;",
        "  private final Other other;",
        "  void run() { other.execute(); }",
        "}",
      ].join("\n"),
      "Other.java": "class Other { void execute() {} }\n",
    };
    const result = gateCandidate(contextFor(files), candidate());
    expect(result.verdict).toBe("overturned");
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("does not resolve");
  });

  it("quarantines rather than partially rendering a Flow with a missing claim", () => {
    const result = gateCandidate(contextFor(directFiles), candidate(directFlow(), []));
    expect(result.verdict).toBe("unresolved");
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("no atomic claim");
  });

  it("resolves every call site an arrow was drawn over, not just the first", () => {
    // PR 6 draws ONE arrow for one relationship exercised several times, so an
    // arrow may carry several atomic claims. The guarantee is unchanged and is
    // checked rather than assumed: each cited call site is independently
    // re-resolved, and one that names a different target quarantines the Flow
    // exactly as it would have when it was an arrow of its own.
    const files = {
      "Caller.java": [
        "class Caller {",
        "  private final Target target;",
        "  void run() { target.execute(); }",
        "  void again() { target.missing(); }",
        "}",
      ].join("\n"),
      "Target.java": "class Target { void execute() {} }\n",
    };
    const evidence = [
      { ...file("Caller.java"), line_start: 3, line_end: 3 },
      { ...file("Caller.java"), line_start: 4, line_end: 4 },
    ];
    const flow = directFlow({ links: [directLink({ label: "execute(), missing()", evidence })] });
    const claims = [
      directClaim({ evidence: [evidence[0]!] }),
      directClaim({
        from: { path: "Caller.java", owner: "Caller", name: "again", arity: 0 },
        to: { path: "Target.java", owner: "Target", name: "missing", arity: 0 },
        evidence: [evidence[1]!],
      }),
    ];
    const result = gateCandidate(contextFor(files), candidate(flow, claims));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("caller-target");
  });

  it("refuses an arrow that cites a call site no claim resolves", () => {
    // The other half of the same rule. An arrow drawn over three call sites and
    // claimed over two would assert a call nothing re-resolved, which is the
    // "verified, not asserted" failure the whole gate exists to prevent.
    const evidence = [
      { ...file("Caller.java"), line_start: 3, line_end: 3 },
      { ...file("Caller.java"), line_start: 4, line_end: 4 },
    ];
    const flow = directFlow({ links: [directLink({ evidence })] });
    const result = gateCandidate(
      contextFor(directFiles),
      candidate(flow, [directClaim({ evidence: [evidence[0]!] })]),
    );
    expect(result.verdict).toBe("unresolved");
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("differs from the evidence the gate was asked to resolve");
  });

  it("rejects dangling endpoints and duplicate ids before resolving claims", () => {
    const flow = directFlow({
      links: [directLink({ to: "ghost" }), directLink({ from: "target" })],
    });
    const result = gateCandidate(contextFor(directFiles), candidate(flow));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toMatch(/missing step|duplicated/);
  });

  it("requires a matcher whose semantics agree with the typed relation", () => {
    const flow = directFlow({ links: [directLink({ relation: "write" })] });
    const result = gateCandidate(contextFor(directFiles), candidate(flow));
    expect(result.verdict).toBe("overturned");
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("cannot establish relation write");
  });

  it("does not admit legacy calls_next input as a newly verified candidate", () => {
    const flow = directFlow({
      links: undefined,
      steps: [
        {
          id: "caller",
          node: "Caller.run",
          calls_next: ["target"],
          evidence: file("Caller.java"),
        },
        { id: "target", node: "Target.execute", evidence: file("Target.java") },
      ],
    });
    const result = gateCandidate(contextFor(directFiles), candidate(flow, []));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("legacy calls_next");
  });

  it("promotes a data-lineage arrow drawn from the record to its reader", () => {
    // The ONE reversed arrow in the engine. The claim names the reader as `from`
    // and the record's read as `to` - the opposite of the arrow it is attached to -
    // and the gate checks endpoint agreement in that declared order.
    const result = gateCandidate(contextFor(lineageFiles), lineageCandidate());
    expect(result.verdict).toBe("confirmed");
    expect(result.node.confidence).toBe("verified");
  });

  it("refuses a lineage arrow whose named read writes no SELECT", () => {
    // A method name proves nothing about durable storage, so the gate re-reads the
    // declaration the claim cites: this one is the record's INSERT.
    const result = gateCandidate(
      contextFor(lineageFiles),
      lineageCandidate({
        link: { label: "insert(...)", evidence: [CALL_SITE, WRITE_DECL] },
        claim: {
          to: { path: "Record.java", owner: "Record", name: "insert", arity: 1 },
          evidence: [CALL_SITE, WRITE_DECL],
        },
      }),
    );
    expect(result.verdict).toBe("overturned");
    expect(result.finding).toContain("writes no SELECT");
  });

  it("refuses a lineage arrow labelled with a predicate its SQL does not write", () => {
    // A lineage label carries literal SQL predicates, and a predicate is a claim
    // about what the reader can see - the whole insight this archetype exists to
    // carry - so the label is checked against the SQL the arrow cites.
    const result = gateCandidate(
      contextFor(lineageFiles),
      lineageCandidate({
        link: { label: "passed(...) where outcome = 'FAILED'", evidence: [CALL_SITE, READ_DECL] },
      }),
    );
    expect(result.verdict).toBe("overturned");
    expect(result.finding).toContain("does not write");
  });

  it("accepts a label predicate whose SQL omits the spaces around the operator", () => {
    // Both sides go through `literalPredicates`, so `outcome='PASSED'` in the SQL
    // and `outcome = 'PASSED'` on the label are the same predicate by construction -
    // no substring match that a third normalization could drift from.
    const unspaced: Record<string, string> = {
      ...lineageFiles,
      "Record.java": lineageFiles["Record.java"]!.replace("outcome = 'PASSED'", "outcome='PASSED'"),
    };
    const result = gateCandidate(contextFor(unspaced), lineageCandidate());
    expect(result.verdict).toBe("confirmed");
    expect(result.node.confidence).toBe("verified");
  });

  it("refuses a lineage claim whose endpoints run the way the arrow does", () => {
    // Swapping the claim to match the arrow's direction is exactly the mistake the
    // declared orientation exists to catch: it would assert that the record calls
    // the reader.
    const result = gateCandidate(
      contextFor(lineageFiles),
      lineageCandidate({
        claim: {
          from: { path: "Record.java", owner: "Record", name: "passed", arity: 0 },
          to: { path: "Learned.java", owner: "Learned", name: "state", arity: 0 },
        },
      }),
    );
    expect(result.verdict).not.toBe("confirmed");
    expect(result.node.confidence).toBe("absent");
  });

  it("confirms a closed negative when the symbol graph cannot reach the other derivation", () => {
    const result = gateCandidate(
      contextFor(lineageFiles),
      lineageCandidate({
        caption: "No derivation drawn here reaches another.",
        extra: [independenceClaim()],
      }),
    );
    expect(result.verdict).toBe("confirmed");
    expect(result.node.confidence).toBe("verified");
  });

  it("refuses the closed negative when the reader can reach the other derivation", () => {
    // THE MUTANT THAT MATTERS: one cross-branch reference, and the negative is no
    // longer closed. It is `unresolved` rather than `contradicted` because an
    // over-approximation that reaches something has not proved a read exists - only
    // that it cannot rule one out - and the whole Flow is quarantined either way.
    const files = {
      ...lineageFiles,
      // On the SAME line, so every cited span still points where it did: the
      // mutant is one cross-branch reference, not a shifted file.
      "Learned.java": lineageFiles["Learned.java"]!.replace(
        "private final Record record;",
        "private final Record record; private final Other other;",
      ),
    };
    const result = gateCandidate(
      contextFor(files),
      lineageCandidate({
        caption: "No derivation drawn here reaches another.",
        extra: [independenceClaim()],
      }),
    );
    expect(result.verdict).toBe("unresolved");
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("reaches Other");
  });

  it("refuses a POSITIVE reachability claim, which has no closed proof", () => {
    const result = gateCandidate(
      contextFor(lineageFiles),
      lineageCandidate({ extra: [{ ...independenceClaim(), expect: "present" as const }] }),
    );
    expect(result.verdict).toBe("unresolved");
    expect(result.finding).toContain("absence only");
  });

  it("refuses a closed_dispatch claim that carries no set to re-resolve", () => {
    // PR 5 gives `closed_dispatch` a resolver, and the resolver's whole job is the
    // SET rather than the target: a claim with no declared type and no member
    // count states nothing the gate could re-enumerate, so it resolves nothing.
    const flow = directFlow({ links: [directLink({ relation: "dispatch" })] });
    const claim = directClaim({ matcher: "closed_dispatch" });
    const result = gateCandidate(contextFor(directFiles), candidate(flow, [claim]));
    expect(result.verdict).toBe("unresolved");
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("implementation count");
  });

  it("requires a closed absent claim for a negative caption", () => {
    const flow = directFlow({ caption: "The target never calls a runner." });
    const result = gateCandidate(contextFor(directFiles), candidate(flow));
    expect(result.verdict).toBe("unresolved");
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("negative claim");
  });
});

describe("Flow relationship resolvers", () => {
  it("confirms an exact frontend-to-Spring method and path", () => {
    const files = {
      "client.ts": [
        "function submitForm(id: string) {",
        '  return apiFetch(`/api/orders/${id}`, { method: "POST" });',
        "}",
      ].join("\n"),
      // The declaration that closes `apiFetch` as an HTTP client of this subject.
      // The gate re-derives that from the cited span rather than recognising the
      // name, so a wrapper that rewrote the path could not smuggle a route through.
      "api.ts": [
        "export async function apiFetch(path: string, init?: RequestInit) {",
        "  const url = `${API_BASE_URL}${path}`",
        "  return fetch(url, init)",
        "}",
      ].join("\n"),
      "Controller.java": [
        '@RequestMapping("/api")',
        "class Controller {",
        '  @PostMapping("/orders/{id}")',
        "  void submit() {}",
        "}",
      ].join("\n"),
    };
    const evidence = [file("client.ts"), file("api.ts"), file("Controller.java")];
    const flow = directFlow({
      steps: [
        { id: "caller", node: "submitForm", evidence: file("client.ts") },
        { id: "target", node: "Controller.submit", evidence: file("Controller.java") },
      ],
      links: [
        directLink({ relation: "transport", label: "POST /api/orders/{id}", evidence }),
      ],
    });
    const protocol = { method: "POST" as const, path: "/api/orders/{id}" };
    const claim = directClaim({
      matcher: "spring_route",
      from: { path: "client.ts", name: "submitForm", protocol },
      to: { path: "Controller.java", owner: "Controller", name: "submit", protocol },
      evidence,
    });
    expect(gateCandidate(contextFor(files), candidate(flow, [claim])).node.confidence).toBe(
      "verified",
    );
  });

  it("quarantines a path match when the Spring HTTP method is wrong", () => {
    const files = {
      "client.ts": 'function request() { return apiFetch("/api/orders", { method: "POST" }); }\n',
      // Declared and cited so the ONLY disagreement left is the verb: without it
      // the quarantine would be about an unrecognised callee and would prove
      // nothing about method matching.
      "api.ts": [
        "export async function apiFetch(path: string, init?: RequestInit) {",
        "  return fetch(path, init)",
        "}",
      ].join("\n"),
      "Controller.java": '@RequestMapping("/api")\nclass Controller { @GetMapping("/orders") void submit() {} }\n',
    };
    const evidence = [file("client.ts"), file("api.ts"), file("Controller.java")];
    const flow = directFlow({
      steps: [
        { id: "caller", node: "request", evidence: file("client.ts") },
        { id: "target", node: "Controller.submit", evidence: file("Controller.java") },
      ],
      links: [directLink({ relation: "transport", label: "POST /api/orders", evidence })],
    });
    const protocol = { method: "POST" as const, path: "/api/orders" };
    const claim = directClaim({
      matcher: "spring_route",
      from: { path: "client.ts", name: "request", protocol },
      to: { path: "Controller.java", owner: "Controller", name: "submit", protocol },
      evidence,
    });
    const result = gateCandidate(contextFor(files), candidate(flow, [claim]));
    expect(result.verdict).toBe("overturned");
    expect(result.node.confidence).toBe("absent");
  });

  it("refuses a transport arrow whose callee is not a client this subject closes", () => {
    // The narrow adapter's whole closure rule, re-derived on the gate's side. A
    // helper the subject never declares as a fetch client could be rewriting the
    // path, so the literal at the call site is not established to be the route -
    // and an arrow drawn on a probable contract is what the atomic rule forbids.
    const files = {
      "client.ts": 'function request() { return post("/api/orders"); }\n',
      "Controller.java":
        '@RequestMapping("/api")\nclass Controller { @GetMapping("/orders") void submit() {} }\n',
    };
    const evidence = [file("client.ts"), file("Controller.java")];
    const protocol = { method: "GET" as const, path: "/api/orders" };
    const flow = directFlow({
      steps: [
        { id: "caller", node: "request", evidence: file("client.ts") },
        { id: "target", node: "Controller.submit", evidence: file("Controller.java") },
      ],
      links: [directLink({ relation: "transport", label: "GET /api/orders", evidence })],
    });
    const claim = directClaim({
      matcher: "spring_route",
      from: { path: "client.ts", name: "request", protocol },
      to: { path: "Controller.java", owner: "Controller", name: "submit", protocol },
      evidence,
    });
    const result = gateCandidate(contextFor(files), candidate(flow, [claim]));
    expect(result.verdict).toBe("overturned");
    expect(result.node.confidence).toBe("absent");
  });

  it("refuses a transport arrow whose cited call builds its URL at run time", () => {
    // A path assembled from an expression is not a route this engine can match,
    // and the gate says so from the cited span alone - so a producer that
    // resolved one anyway could not get it past this check.
    const files = {
      "client.ts": 'function request(id: string) { return fetch("/api/orders/" + id); }\n',
      "Controller.java":
        '@RequestMapping("/api")\nclass Controller { @GetMapping("/orders/{id}") void submit() {} }\n',
    };
    const evidence = [file("client.ts"), file("Controller.java")];
    const protocol = { method: "GET" as const, path: "/api/orders/{}" };
    const flow = directFlow({
      steps: [
        { id: "caller", node: "request", evidence: file("client.ts") },
        { id: "target", node: "Controller.submit", evidence: file("Controller.java") },
      ],
      links: [directLink({ relation: "transport", label: "GET /api/orders/{}", evidence })],
    });
    const claim = directClaim({
      matcher: "spring_route",
      from: { path: "client.ts", name: "request", protocol },
      to: { path: "Controller.java", owner: "Controller", name: "submit", protocol },
      evidence,
    });
    expect(gateCandidate(contextFor(files), candidate(flow, [claim])).node.confidence).toBe(
      "absent",
    );
  });

  it("refuses a transport arrow whose cited call writes a relative URL literal", () => {
    // The claim's protocol names the absolute route, but the cited span writes a
    // relative literal that resolves against the page URL rather than the subject's
    // route table. The gate tests the literal before normalizing it, so it refuses
    // the arrow rather than echoing a producer that admitted one.
    const files = {
      "client.ts": 'function request() { return fetch("api/orders"); }\n',
      "Controller.java":
        '@RequestMapping("/api")\nclass Controller { @GetMapping("/orders") void submit() {} }\n',
    };
    const evidence = [file("client.ts"), file("Controller.java")];
    const protocol = { method: "GET" as const, path: "/api/orders" };
    const flow = directFlow({
      steps: [
        { id: "caller", node: "request", evidence: file("client.ts") },
        { id: "target", node: "Controller.submit", evidence: file("Controller.java") },
      ],
      links: [directLink({ relation: "transport", label: "GET /api/orders", evidence })],
    });
    const claim = directClaim({
      matcher: "spring_route",
      from: { path: "client.ts", name: "request", protocol },
      to: { path: "Controller.java", owner: "Controller", name: "submit", protocol },
      evidence,
    });
    expect(gateCandidate(contextFor(files), candidate(flow, [claim])).node.confidence).toBe(
      "absent",
    );
  });

  it("refuses a transport arrow whose cited call hands fetch an options variable", () => {
    // `fetch(url)` with no options is a GET by specification, which both halves
    // may read. `fetch(url, init)` states the method somewhere else entirely, so
    // neither half may assume one.
    const files = {
      "client.ts": 'function request(init: RequestInit) { return fetch("/api/orders", init); }\n',
      "Controller.java":
        '@RequestMapping("/api")\nclass Controller { @GetMapping("/orders") void submit() {} }\n',
    };
    const evidence = [file("client.ts"), file("Controller.java")];
    const protocol = { method: "GET" as const, path: "/api/orders" };
    const flow = directFlow({
      steps: [
        { id: "caller", node: "request", evidence: file("client.ts") },
        { id: "target", node: "Controller.submit", evidence: file("Controller.java") },
      ],
      links: [directLink({ relation: "transport", label: "GET /api/orders", evidence })],
    });
    const claim = directClaim({
      matcher: "spring_route",
      from: { path: "client.ts", name: "request", protocol },
      to: { path: "Controller.java", owner: "Controller", name: "submit", protocol },
      evidence,
    });
    expect(gateCandidate(contextFor(files), candidate(flow, [claim])).node.confidence).toBe(
      "absent",
    );
  });

  it("confirms a typed repository write", () => {
    const files = {
      "Service.java": "class Service { Repo repo; void run() { repo.save(entity); } }\n",
      "Repo.java": "interface Repo { void save(Entity entity); }\n",
    };
    const flow = directFlow({
      steps: [
        { id: "caller", node: "Service.run", evidence: file("Service.java") },
        { id: "target", node: "Repo.save", evidence: file("Repo.java") },
      ],
      links: [directLink({ relation: "write", label: "save()", evidence: [file("Service.java")] })],
    });
    const claim = directClaim({
      matcher: "data_access",
      from: { path: "Service.java", owner: "Service", name: "run", arity: 0 },
      to: { path: "Repo.java", owner: "Repo", name: "save", arity: 1 },
      evidence: [file("Service.java")],
    });
    expect(gateCandidate(contextFor(files), candidate(flow, [claim])).node.confidence).toBe(
      "verified",
    );
  });
});
