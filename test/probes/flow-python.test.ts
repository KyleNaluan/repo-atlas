/**
 * The Python Flow adapter (#52): three entry families, one new gate matcher, and
 * the named cuts that are the other half of what it produces.
 *
 * Every adapter is exercised in the states #35's PR 8 requires of each - NOT
 * APPLICABLE, RAN EMPTY, COMPLETE, and the refusals it names - plus a
 * gate-disagreement MUTANT for each new gate check, which is the only assertion
 * that proves the gate re-resolves rather than echoes. The mutants follow the
 * pattern the entry-adapter suite established: build the candidate against one
 * tree, then hand it to the gate against a MOVED tree with the SHA repinned, so
 * the two derivations are genuinely independent.
 *
 * The fixtures are real trees at real SHAs, as everywhere else in this suite: the
 * producer walks a parse index and the gate rereads the pinned blob, so a
 * hand-written candidate would exercise neither half of the guarantee.
 */
import { describe, expect, it } from "vitest";
import { runProbes } from "../../src/probes/registry.js";
import { contextFor, only, runAdapter } from "./flow-subject.js";
import { gateCandidate } from "../../src/gate/gate.js";
import { resolveFlowClaim } from "../../src/gate/flow.js";
import { flowArchetype } from "../../src/rank/flow.js";
import { dottedNamesOf, moduleOwnerName, packageDirsIn } from "../../src/probes/flow/py-module.js";
import { methodNamed, pythonIndex } from "../../src/probes/flow/py-symbols.js";
import { pyTraceFrom } from "../../src/probes/flow/py-trace.js";
import type { TypeSymbol } from "../../src/probes/flow/symbols.js";
import type { TraceResult } from "../../src/probes/flow/trace.js";
import type { Candidate, FlowClaim, ProbeOutcome } from "../../src/probes/types.js";
import type { FlowNode } from "../../src/schema/types.js";

/* ---------------------------------------------------------- fixtures */

const INIT = "";

const MAIN = `from fastapi import FastAPI

from app import records

app = FastAPI()


@app.get("/records/{record_id}")
def show_record(record_id: str) -> str:
    return records.render(record_id)
`;

const RECORDS = `from app.store import Store


def render(record_id: str) -> str:
    store = Store()
    return store.read_record(record_id)
`;

const STORE = `import sqlite3


class Store:
    def __init__(self) -> None:
        self._conn = sqlite3.connect("db")

    def read_record(self, record_id: str) -> str:
        row = self._conn.execute("select body from records where id = ?", (record_id,)).fetchone()
        return str(row[0])
`;

const ROUTE_SUBJECT = {
  "app/__init__.py": INIT,
  "app/main.py": MAIN,
  "app/records.py": RECORDS,
  "app/store.py": STORE,
};

const GRAPH = `from langgraph.graph import END, StateGraph


def build() -> object:
    def ingest(state: dict) -> dict:
        return state

    def deliver(state: dict) -> dict:
        return state

    graph = StateGraph(dict)
    graph.add_node("ingest", ingest)
    graph.add_node("deliver", deliver)
    graph.set_entry_point("ingest")
    graph.add_edge("ingest", "deliver")
    graph.add_edge("deliver", END)
    return graph.compile()
`;

const PIPELINE_SUBJECT = { "app/__init__.py": INIT, "app/graph.py": GRAPH };

const SCHEMA = (registry: string) => `import json
from pathlib import Path


class Alpha:
    @classmethod
    def load(cls, data: dict) -> "Alpha":
        Path("alpha.json").write_text(json.dumps(data))
        return cls()


class Beta:
    @classmethod
    def load(cls, data: dict) -> "Beta":
        Path("beta.json").write_text(json.dumps(data))
        return cls()


class Gamma:
    @classmethod
    def load(cls, data: dict) -> "Gamma":
        Path("gamma.json").write_text(json.dumps(data))
        return cls()


${registry}


class Envelope:
    @classmethod
    def parse(cls, data: dict) -> object:
        kind_cls = _KINDS[data["kind"]]
        return kind_cls.load(data["payload"])
`;

const TWO_MEMBERS = `_KINDS: dict[str, type] = {
    "alpha": Alpha,
    "beta": Beta,
}`;

const THREE_MEMBERS = `_KINDS: dict[str, type] = {
    "alpha": Alpha,
    "beta": Beta,
    "gamma": Gamma,
}`;

const DISPATCH_ENTRY = `from app.schema import Envelope


def parse_payload(data: dict) -> object:
    return Envelope.parse(data)


if __name__ == "__main__":
    parse_payload({})
`;

const DISPATCH_SUBJECT = {
  "app/__init__.py": INIT,
  "app/schema.py": SCHEMA(TWO_MEMBERS),
  "app/payloads.py": DISPATCH_ENTRY,
};

/* ---------------------------------------------------------- helpers */

const flowOf = (candidate: Candidate): FlowNode => candidate.node as FlowNode;

const verifiedOnly = (candidates: Candidate[]): Candidate[] =>
  candidates.filter((c) => flowOf(c).confidence === "verified");

const cutReasons = (candidates: Candidate[]): string[] =>
  candidates.filter((c) => c.absent_reason !== undefined).map((c) => c.absent_reason!);

const repinned = (candidate: Candidate, from: string, to: string): Candidate =>
  JSON.parse(JSON.stringify(candidate).replaceAll(from, to)) as Candidate;

const outcomeFor = (outcomes: ProbeOutcome[], id: string): ProbeOutcome =>
  outcomes.find((o) => o.probe_id === id)!;

/** The one verified Flow an adapter produced, gated against its own tree. */
const gated = async (files: Record<string, string>, adapter: string) => {
  const ctx = contextFor(files);
  const candidates = await runAdapter(adapter, ctx);
  const candidate = only(verifiedOnly(candidates));
  return { ctx, candidates, candidate, result: gateCandidate(ctx, candidate) };
};

/* ------------------------------------------- what a file is importable as */

describe("one definition of what a Python file is importable as", () => {
  it("starts the import name at the first ancestor that is not a package", () => {
    // ftb's layout: `src` declares __init__.py, so its modules import as `src.x`.
    const packaged = packageDirsIn(["src/__init__.py", "src/decision_log/__init__.py"]);
    expect(dottedNamesOf("src/decision_log/reader.py", packaged)).toEqual([
      "src.decision_log.reader",
    ]);
    // dsa's layout: `src` is a bare source root, so `ds_agent` is where the name
    // starts - and the repo-relative form is registered too, because a namespace
    // package would otherwise have no name at all.
    const rooted = packageDirsIn(["src/ds_agent/__init__.py", "src/ds_agent/agent/__init__.py"]);
    expect(dottedNamesOf("src/ds_agent/agent/graph.py", rooted)).toEqual([
      "src.ds_agent.agent.graph",
      "ds_agent.agent.graph",
    ]);
  });

  it("names a package by its directory rather than by __init__", () => {
    expect(moduleOwnerName("webui/decision_logs.py")).toBe("decision_logs");
    expect(moduleOwnerName("src/live/__init__.py")).toBe("live");
  });
});

/* ------------------------------------------- what an annotation denotes */

describe("what a Python annotation denotes, and what it does not", () => {
  it("unwraps only the wrappers that denote the same object", async () => {
    const { parsePython, findAll, annotationName, annotationElement } = await import(
      "../../src/probes/python.js"
    );
    const root = await parsePython(
      [
        "a: Optional[Store] = None",
        "b: Store | None = None",
        'c: "Store" = x',
        "d: models.Store = x",
        "e: type[Store] = Store",
        "f: list[Store] = []",
        "g: dict[str, Store] = {}",
        "h: SignalRecord | GateRecord = x",
      ].join("\n"),
    );
    const named = findAll(root, "assignment").map((node) =>
      annotationName(node.childForFieldName("type")),
    );
    // The first five denote a `Store`. The next two denote a CONTAINER, and
    // reducing them to their element is the defect this pins: it made
    // `records.append(...)` read as a missing `DecisionRecord.append` - a hole in a
    // story that has none. The last names two types, so it names none.
    expect(named).toEqual(["Store", "Store", "Store", "Store", "Store", "list", "dict", null]);
    const elements = findAll(root, "assignment").map((node) =>
      annotationElement(node.childForFieldName("type")),
    );
    // The other question - "one element of this" - is answered only for a real
    // container, which is what makes a `for` target's call a named stop rather
    // than a silence.
    expect(elements).toEqual([null, null, null, null, null, "Store", "Store", null]);
  }, 60_000);

  it("refuses a literal that is not one literal", async () => {
    const { parsePython, findAll, stringLiteral } = await import("../../src/probes/python.js");
    const root = await parsePython('a = "/records"\nb = f"/{prefix}/records"\n');
    const read = findAll(root, "assignment").map((node) =>
      stringLiteral(node.childForFieldName("right")),
    );
    // An f-string is assembled at run time, so it is the `dynamic_path:` family
    // rather than a route this engine may claim.
    expect(read).toEqual(["/records", null]);
  }, 60_000);
});

/* ------------------------------------------------------- the FastAPI route */

describe("a FastAPI route, traced to its durable read", () => {
  it("COMPLETE: one box per module and class, and the gate re-resolves every arrow", async () => {
    const { candidate, result } = await gated(ROUTE_SUBJECT, "flow-python-fastapi-http");
    const flow = flowOf(candidate);
    expect(flow.steps.map((step) => step.node)).toEqual(["GET /records/{}", "records", "Store"]);
    expect(flow.links!.map((link) => link.relation)).toEqual(["call", "read"]);
    expect(flowArchetype(flow)).toBe("request_response");
    // The route is a claim about the tree, so it is re-derived from the blob
    // rather than taken on the producer's word.
    const route = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "spring_route"));
    expect(route.link_id).toBeUndefined();
    expect(route.to!.protocol).toEqual({ method: "GET", path: "/records/{}" });
    // A durable read is claimed against the TARGET's own SQL, so the arrow cites
    // the declaration that carries it.
    const read = only((candidate.flow_claims ?? []).filter((c) => c.matcher === "data_access"));
    expect(read.evidence.map((e) => e.path)).toContain("app/store.py");
    expect(result.verdict).toBe("confirmed");
    expect(result.node.confidence).toBe("verified");
  }, 60_000);

  it("NOT APPLICABLE: a Python subject that imports no fastapi says so by name", async () => {
    const { outcomes } = await runProbes(contextFor(PIPELINE_SUBJECT));
    const outcome = outcomeFor(outcomes, "flow-python-fastapi-http");
    expect(outcome.status).toBe("not_applicable");
    expect(outcome.status === "not_applicable" && outcome.reason).toContain("imports fastapi");
  }, 60_000);

  it("RAN EMPTY: fastapi present and no route declared is a different finding", async () => {
    const ctx = contextFor({
      "app/__init__.py": INIT,
      "app/main.py": "from fastapi import FastAPI\n\napp = FastAPI()\n",
    });
    expect(await runAdapter("flow-python-fastapi-http", ctx)).toEqual([]);
  }, 60_000);

  it("CUT: a path that is not one string literal is named, not passed over", async () => {
    const candidates = await runAdapter(
      "flow-python-fastapi-http",
      contextFor({
        ...ROUTE_SUBJECT,
        "app/main.py": MAIN.replace('"/records/{record_id}"', 'f"/{PREFIX}/records"'),
      }),
    );
    expect(cutReasons(candidates)[0]).toContain("dynamic_route_path:");
  }, 60_000);

  it("CUT: a router nothing in the subject mounts serves no route", async () => {
    const candidates = await runAdapter(
      "flow-python-fastapi-http",
      contextFor({
        ...ROUTE_SUBJECT,
        "app/main.py": MAIN.replace("from fastapi import FastAPI", "from fastapi import APIRouter")
          .replace("app = FastAPI()", "app = APIRouter()"),
      }),
    );
    expect(cutReasons(candidates)[0]).toContain("unmounted_router:");
  }, 60_000);

  it("CUT: a prefix that is not a literal leaves the composed path unestablished", async () => {
    const candidates = await runAdapter(
      "flow-python-fastapi-http",
      contextFor({
        ...ROUTE_SUBJECT,
        "app/main.py": MAIN.replace("from fastapi import FastAPI", "from fastapi import APIRouter")
          .replace("app = FastAPI()", "app = APIRouter(prefix=BASE)"),
      }),
    );
    expect(cutReasons(candidates)[0]).toContain("dynamic_route_prefix:");
  }, 60_000);

  it("CUT: a receiver the subject declines to type quarantines the whole Flow", async () => {
    // The `-> Any` case, which is risk R2: one function declining to name its
    // return type makes every story through it unreachable, and that is a true
    // statement about the subject rather than something to walk around.
    const candidates = await runAdapter(
      "flow-python-fastapi-http",
      contextFor({
        ...ROUTE_SUBJECT,
        "app/records.py": `from typing import Any

from app.store import Store


def _open() -> Any:
    return Store()


def render(record_id: str) -> str:
    store = _open()
    return store.read_record(record_id)
`,
      }),
    );
    expect(cutReasons(candidates)[0]).toContain("unresolved_receiver_type:");
    expect(cutReasons(candidates)[0]).toContain("Any");
  }, 60_000);

  it("CUT: a story whose every step folds into one box draws no arrow", async () => {
    const candidates = await runAdapter(
      "flow-python-fastapi-http",
      contextFor({
        "app/__init__.py": INIT,
        "app/main.py": `import json
from pathlib import Path

from fastapi import FastAPI

app = FastAPI()


def _write(body: str) -> None:
    Path("out.json").write_text(json.dumps({"body": body}))


@app.get("/records")
def show_records() -> str:
    _write("x")
    return "ok"
`,
      }),
    );
    expect(cutReasons(candidates)[0]).toContain("no_arrow_drawn:");
  }, 60_000);

  it("MUTANT: a route whose verb moved under it quarantines the whole Flow", async () => {
    const ctx = contextFor(ROUTE_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-fastapi-http", ctx)));
    const moved = contextFor({ ...ROUTE_SUBJECT, "app/main.py": MAIN.replace("@app.get", "@app.post") });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("quarantined atomically");
    expect(result.finding).toContain("GET /records/{}");
  }, 60_000);

  it("MUTANT: a module-qualified call that stops being made quarantines the Flow", async () => {
    const ctx = contextFor(ROUTE_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-fastapi-http", ctx)));
    const moved = contextFor({
      ...ROUTE_SUBJECT,
      // The call is replaced in place, so every other line keeps its number and
      // the only thing that moved is the call the arrow rests on.
      "app/main.py": MAIN.replace("records.render(record_id)", "str(record_id) # render"),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("does not resolve show_record to render");
  }, 60_000);

  it("MUTANT: a durable read whose SQL disappeared quarantines the Flow", async () => {
    const ctx = contextFor(ROUTE_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-fastapi-http", ctx)));
    const moved = contextFor({
      ...ROUTE_SUBJECT,
      "app/store.py": STORE.replace(
        '"select body from records where id = ?"',
        '"pragma user_version           "',
      ),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("writes no SQL that reads durable storage");
  }, 60_000);

  it("MUTANT: an import that stops binding the module quarantines the Flow", async () => {
    const ctx = contextFor(ROUTE_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-fastapi-http", ctx)));
    const moved = contextFor({
      ...ROUTE_SUBJECT,
      "app/main.py": MAIN.replace("from app import records", "import records as records  # noqa"),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("does not resolve show_record to render");
  }, 60_000);
});

/* ------------------------------------------------ the declared pipeline */

describe("a declared LangGraph topology, which is a Flow (#52 D2)", () => {
  it("COMPLETE: one box per registered node, and every edge re-derived from its literals", async () => {
    const { candidate, result } = await gated(PIPELINE_SUBJECT, "flow-python-langgraph-pipeline");
    const flow = flowOf(candidate);
    expect(flow.steps.map((step) => step.node)).toEqual(["ingest", "deliver"]);
    expect(flow.links!).toHaveLength(1);
    expect(flow.links![0]!.label).toBe('add_edge("ingest", "deliver")');
    // #39's archetype set is closed at two and a declared topology carries no
    // request signal, so it may fill only capacity the two preferred archetypes
    // leave open - the treatment PR 8 gave the clock, message and unit families.
    expect(flowArchetype(flow)).toBe("unknown");
    const claims = candidate.flow_claims ?? [];
    const entry = only(claims.filter((c) => c.link_id === undefined));
    expect(entry.matcher).toBe("declared_pipeline");
    expect(entry.pipeline).toEqual({ entry_key: "ingest" });
    const edge = only(claims.filter((c) => c.link_id !== undefined));
    expect(edge.pipeline).toEqual({ from_key: "ingest", to_key: "deliver" });
    expect(result.verdict).toBe("confirmed");
  }, 60_000);

  it("NOT APPLICABLE: a Python subject that imports no langgraph says so by name", async () => {
    const { outcomes } = await runProbes(contextFor(ROUTE_SUBJECT));
    const outcome = outcomeFor(outcomes, "flow-python-langgraph-pipeline");
    expect(outcome.status).toBe("not_applicable");
    expect(outcome.status === "not_applicable" && outcome.reason).toContain("imports langgraph");
  }, 60_000);

  it("CUT: a branch chosen by a callable at run time is not a declared topology", async () => {
    const candidates = await runAdapter(
      "flow-python-langgraph-pipeline",
      contextFor({
        ...PIPELINE_SUBJECT,
        "app/graph.py": GRAPH.replace(
          'graph.add_edge("ingest", "deliver")',
          'graph.add_conditional_edges("ingest", route)',
        ),
      }),
    );
    expect(cutReasons(candidates)[0]).toContain("runtime_registration:");
  }, 60_000);

  it("CUT: a topology that names no beginning is refused by name", async () => {
    const candidates = await runAdapter(
      "flow-python-langgraph-pipeline",
      contextFor({
        ...PIPELINE_SUBJECT,
        "app/graph.py": GRAPH.replace('    graph.set_entry_point("ingest")\n', ""),
      }),
    );
    expect(cutReasons(candidates)[0]).toContain("no_declared_entry:");
  }, 60_000);

  it("CUT: an edge naming a key nothing registered is refused by name", async () => {
    const candidates = await runAdapter(
      "flow-python-langgraph-pipeline",
      contextFor({
        ...PIPELINE_SUBJECT,
        "app/graph.py": GRAPH.replace('graph.add_edge("ingest", "deliver")', 'graph.add_edge("ingest", "audit")'),
      }),
    );
    expect(cutReasons(candidates)[0]).toContain("unresolved_target:");
  }, 60_000);

  it("MUTANT: an edge the topology stops declaring quarantines the whole Flow", async () => {
    const ctx = contextFor(PIPELINE_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-langgraph-pipeline", ctx)));
    const moved = contextFor({
      ...PIPELINE_SUBJECT,
      "app/graph.py": GRAPH.replace('graph.add_edge("ingest", "deliver")', 'graph.add_edge("ingest", "ingest")'),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain('declares an edge from "ingest" to "deliver"');
  }, 60_000);

  it("MUTANT: a node registration that stops naming its def quarantines the whole Flow", async () => {
    const ctx = contextFor(PIPELINE_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-langgraph-pipeline", ctx)));
    const moved = contextFor({
      ...PIPELINE_SUBJECT,
      "app/graph.py": GRAPH.replace('graph.add_node("deliver", deliver)', 'graph.add_node("deliver", ingest)'),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain('registers the node "deliver" as deliver');
  }, 60_000);

  it("MUTANT: an entry the topology stops declaring quarantines the whole Flow", async () => {
    const ctx = contextFor(PIPELINE_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-langgraph-pipeline", ctx)));
    const moved = contextFor({
      ...PIPELINE_SUBJECT,
      "app/graph.py": GRAPH.replace('set_entry_point("ingest")', 'set_entry_point("deliver")'),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain('declares "ingest" as the topology\'s entry point');
  }, 60_000);
});

/* -------------------------------------- the program entry and its dispatch */

describe("a runnable Python entry, and the one closed set v1 ships", () => {
  it("COMPLETE: a __main__ guard fans a keyed registry out into one arrow per member", async () => {
    const { candidate, result } = await gated(DISPATCH_SUBJECT, "flow-python-console-entry");
    const flow = flowOf(candidate);
    // A closed set of several members is a FAN-OUT of separately labelled and
    // separately evidenced arrows, never a chosen variant.
    const dispatch = flow.links!.filter((link) => link.relation === "dispatch");
    expect(dispatch.map((link) => link.label).sort()).toEqual([
      'load(...) via "alpha"',
      'load(...) via "beta"',
    ]);
    const claims = (candidate.flow_claims ?? []).filter((c) => c.matcher === "closed_dispatch");
    expect(claims).toHaveLength(2);
    expect(claims[0]!.dispatch).toMatchObject({
      via: "keyed_registry",
      member_count: 2,
      base: { path: "app/schema.py", name: "_KINDS" },
    });
    // The selection and the call are two lines, so the arrow cites both plus the
    // registry's own declaration.
    expect(claims[0]!.evidence.filter((e) => e.path === "app/schema.py").length).toBeGreaterThan(2);
    expect(result.verdict).toBe("confirmed");
  }, 60_000);

  it("CUT: the framework-callback family is refused by name, per D1", async () => {
    const candidates = await runAdapter(
      "flow-python-console-entry",
      contextFor({
        "app/__init__.py": INIT,
        "app/strategy.py": `from nautilus_trader.trading.strategy import Strategy


class BookStrategy(Strategy):
    def on_bar(self, bar: object) -> None:
        pass
`,
      }),
    );
    const reason = only(cutReasons(candidates));
    expect(reason).toContain("framework_callback_unestablished:");
    expect(reason).toContain("BookStrategy(Strategy).on_bar");
    expect(reason).toContain("nothing in this subject declares what calls it");
  }, 60_000);

  it("CUT: a Protocol the subject wrote is not a framework callback", async () => {
    // A `Protocol` whose members are all named `on_*` is a contract the SUBJECT
    // wrote for its own implementations to fill - the opposite of a framework
    // owning the object's lifecycle - so it is not this family.
    const candidates = await runAdapter(
      "flow-python-console-entry",
      contextFor({
        "app/__init__.py": INIT,
        "app/ports.py": `from typing import Protocol


class HubListener(Protocol):
    def on_bar_message(self, payload: dict) -> None: ...
`,
      }),
    );
    expect(candidates).toEqual([]);
  }, 60_000);

  it("CUT: a call through an ABC-typed collection is unresolved_dispatch, per D3", async () => {
    const candidates = await runAdapter(
      "flow-python-console-entry",
      contextFor({
        "app/__init__.py": INIT,
        "app/tool.py": `from abc import ABC, abstractmethod


class Tool(ABC):
    @abstractmethod
    def run(self) -> None: ...


class One(Tool):
    def run(self) -> None:
        pass


class Two(Tool):
    def run(self) -> None:
        pass
`,
        "app/cli.py": `from app.tool import Tool


def run(tools: list[Tool]) -> None:
    for tool in tools:
        tool.run()


if __name__ == "__main__":
    run([])
`,
      }),
    );
    const reason = only(cutReasons(candidates));
    // Type closure is provably wrong by one on the reference subject and value
    // closure crosses two files, so v1 stops here rather than choosing between
    // them (#52, D3).
    expect(reason).toMatch(/unresolved_dispatch:|unresolved_receiver_type:/);
  }, 60_000);

  it("MUTANT: a registry that grows a member quarantines the whole Flow", async () => {
    const ctx = contextFor(DISPATCH_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-console-entry", ctx)));
    const moved = contextFor({ ...DISPATCH_SUBJECT, "app/schema.py": SCHEMA(THREE_MEMBERS) });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    // Proving one member exists says nothing about whether it is still the only
    // thing the call can reach, which is the whole point of the check.
    expect(result.finding).toContain("now holds 3 members, not the 2");
  }, 60_000);

  it("MUTANT: a registry key that moved quarantines the whole Flow", async () => {
    const ctx = contextFor(DISPATCH_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-console-entry", ctx)));
    const moved = contextFor({
      ...DISPATCH_SUBJECT,
      "app/schema.py": SCHEMA(TWO_MEMBERS.replace('"alpha"', '"first"')),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain('declares no key "alpha"');
  }, 60_000);

  it("MUTANT: a selection that stops going through the registry quarantines the Flow", async () => {
    const ctx = contextFor(DISPATCH_SUBJECT);
    const candidate = only(verifiedOnly(await runAdapter("flow-python-console-entry", ctx)));
    const moved = contextFor({
      ...DISPATCH_SUBJECT,
      "app/schema.py": SCHEMA(TWO_MEMBERS).replace(
        'kind_cls = _KINDS[data["kind"]]',
        "kind_cls = Alpha  # _KINDS[x]",
      ),
    });
    const result = gateCandidate(moved, repinned(candidate, ctx.sha, moved.sha));
    expect(result.node.confidence).toBe("absent");
    expect(result.finding).toContain("selects a member out of _KINDS");
  }, 60_000);
});

/* ------------------------------------ producer/gate parity fixes (review round) */

describe("two routers in one module keep their own mount identity", () => {
  const TWO_ROUTERS = (mainBody: string) => ({
    "app/__init__.py": INIT,
    "app/routes.py": `from fastapi import APIRouter

from app import records

router_a = APIRouter(prefix="/a")
router_b = APIRouter(prefix="/b")


@router_a.get("/records/{record_id}")
def show_a(record_id: str) -> str:
    return records.render(record_id)


@router_b.get("/records/{record_id}")
def show_b(record_id: str) -> str:
    return records.render(record_id)
`,
    "app/main.py": `from fastapi import FastAPI

from app import routes

app = FastAPI()
${mainBody}`,
    "app/records.py": RECORDS,
    "app/store.py": STORE,
  });

  it("gives each mounted router its own prefix, with no spurious ambiguous_route_mount", async () => {
    const candidates = await runAdapter(
      "flow-python-fastapi-http",
      contextFor(
        TWO_ROUTERS("app.include_router(routes.router_a, prefix=\"/x\")\napp.include_router(routes.router_b, prefix=\"/y\")\n"),
      ),
    );
    // Before the fix the consumer matched mounts by file alone, so each route saw
    // both mounts and cut itself `ambiguous_route_mount`; now each router is
    // matched by identity and gets its own composed path.
    expect(verifiedOnly(candidates).map((c) => flowOf(c).steps[0]!.node).sort()).toEqual([
      "GET /x/a/records/{}",
      "GET /y/b/records/{}",
    ]);
    expect(cutReasons(candidates)).toEqual([]);
  }, 60_000);

  it("does not serve a declared-but-unmounted router's routes", async () => {
    const ctx = contextFor(TWO_ROUTERS("app.include_router(routes.router_a)\n"));
    const candidates = await runAdapter("flow-python-fastapi-http", ctx);
    // Only router_a is mounted, so only its route is served - and the gate confirms
    // the composed path from the same declaration, not a borrowed one.
    const served = only(verifiedOnly(candidates));
    expect(flowOf(served).steps[0]!.node).toBe("GET /a/records/{}");
    expect(gateCandidate(ctx, served).verdict).toBe("confirmed");
    // router_b is declared but nothing mounts it, so its route is a named cut.
    const cut = only(cutReasons(candidates));
    expect(cut).toContain("unmounted_router:");
    expect(cut).toContain("router_b");
  }, 60_000);
});

describe("the gate types a wrapped receiver the same as the producer", () => {
  const WRAPPED = (annotation: string) => ({
    "app/__init__.py": INIT,
    "app/main.py": `from typing import Optional, Type, Final, Annotated, ClassVar
from fastapi import FastAPI

from app.store import Store

app = FastAPI()


@app.get("/records/{record_id}")
def show_record(record_id: str, store: ${annotation}) -> str:
    return store.read_record(record_id)
`,
    "app/store.py": STORE,
  });

  // Exactly the TRANSPARENT set `annotationName` unwraps, plus the union in either
  // order; a container like `list[Store]` is deliberately NOT here, because the
  // producer refuses to type a receiver as its element.
  for (const annotation of [
    "Optional[Store]",
    "type[Store]",
    "Type[Store]",
    "Final[Store]",
    "Annotated[Store]",
    "ClassVar[Store]",
    "Store | None",
    "None | Store",
  ]) {
    it(`re-resolves a receiver annotated ${annotation}`, async () => {
      const { candidate, result } = await gated(WRAPPED(annotation), "flow-python-fastapi-http");
      expect(flowOf(candidate).steps.some((step) => step.node === "Store")).toBe(true);
      expect(result.verdict).toBe("confirmed");
    }, 60_000);
  }
});

describe("an aliased free-function call resolves to the imported def", () => {
  it("looks the target up by the imported name, not the call-site alias", async () => {
    const subject = {
      "app/__init__.py": INIT,
      "app/cli.py": `from app.work import run_job as go


def main() -> None:
    go()


if __name__ == "__main__":
    main()
`,
      "app/work.py": `from app.store import Store


def run_job() -> None:
    store = Store()
    store.read_record("x")
`,
      "app/store.py": STORE,
    };
    // Before the fix the target was looked up by the alias `go`, which the work
    // module does not declare, so the whole story quarantined as unresolved_target.
    const { candidate, result } = await gated(subject, "flow-python-console-entry");
    expect(flowOf(candidate).steps.some((step) => step.node === "Store")).toBe(true);
    expect(result.verdict).toBe("confirmed");
  }, 60_000);
});

describe("a registry key that contains a colon is split on the masked copy", () => {
  it("keeps the whole quoted key rather than splitting inside the string", async () => {
    const subject = {
      "app/__init__.py": INIT,
      "app/schema.py": SCHEMA(`_KINDS: dict[str, type] = {
    "http:get": Alpha,
    "http:post": Beta,
}`),
      "app/payloads.py": DISPATCH_ENTRY,
    };
    const { candidate, result } = await gated(subject, "flow-python-console-entry");
    const claims = (candidate.flow_claims ?? []).filter((c) => c.matcher === "closed_dispatch");
    expect(claims).toHaveLength(2);
    // The colon lives inside the key literal, so a naive split miscounts the set
    // and the label check contradicts; the masked split keeps `"http:get"` whole.
    expect(result.verdict).toBe("confirmed");
  }, 60_000);
});

describe("the gate fails closed on a self-call across two files", () => {
  it("does not confirm a self.m() when the two classes only share a simple name", async () => {
    const ctx = contextFor({
      "app/__init__.py": INIT,
      "app/a.py": `class Store:
    def handle(self, record_id: str) -> str:
        return self.read_record(record_id)
`,
      "app/b.py": `class Store:
    def read_record(self, record_id: str) -> str:
        return "x"
`,
    });
    const claim: FlowClaim = {
      expect: "present",
      matcher: "direct_call",
      from: { path: "app/a.py", name: "handle", owner: "Store", arity: 1 },
      to: { path: "app/b.py", name: "read_record", owner: "Store", arity: 1 },
      evidence: [{ kind: "file", path: "app/a.py", line_start: 1, line_end: 3, sha: ctx.sha }],
    };
    // Two unrelated `Store` classes in two files are not the same receiver, so the
    // simple-name branch carries the same `sameFile` guard the inherited branch has.
    expect(resolveFlowClaim(ctx, undefined, claim).verdict).not.toBe("confirmed");
  }, 60_000);
});

describe("a re-export whose imported name equals the module binds", () => {
  it("binds `app` for `from app import app` rather than skipping it as the module node", async () => {
    const index = await pythonIndex(
      contextFor({
        "main.py": "from app import app\n",
        "app.py": "def app() -> None:\n    pass\n",
      }),
    );
    // The imported name shares text and type with the module_name node, so a
    // text-based skip left it unbound; identifying the module node by span binds it.
    expect(index.bindingsByPath.get("main.py")?.get("app")).toEqual({
      kind: "symbol",
      path: "app.py",
      name: "app",
    });
  }, 60_000);
});

describe("a framework base after a structural one is still inventoried (D1)", () => {
  it("reaches the real base past a leading Generic and names the cut by it", async () => {
    const candidates = await runAdapter(
      "flow-python-console-entry",
      contextFor({
        "app/__init__.py": INIT,
        "app/strategy.py": `from typing import Generic, TypeVar
from nautilus_trader.trading.strategy import Strategy

T = TypeVar("T")


class BookStrategy(Generic[T], Strategy):
    def on_bar(self, bar: object) -> None:
        pass
`,
      }),
    );
    // Generic is a structural base and comes first; abandoning the class at it
    // would leave the real Strategy callback a #6 silence, so the reader skips it.
    const reason = only(cutReasons(candidates));
    expect(reason).toContain("framework_callback_unestablished:");
    expect(reason).toContain("BookStrategy(Strategy).on_bar");
  }, 60_000);
});

/* ------------------------------------ review round 2: execution-path and parity fixes */

/** Trace one entry directly, so a tracer-internal distinction can be asserted. */
const traceEntry = async (
  files: Record<string, string>,
  path: string,
  className: string | null,
  methodName: string,
): Promise<TraceResult> => {
  const index = await pythonIndex(contextFor(files));
  const type: TypeSymbol =
    className === null
      ? index.modules.get(path)!
      : (index.classesByPath.get(path) ?? []).find((t) => t.name === className)!;
  return pyTraceFrom(index, type, methodNamed(type, methodName)!);
};

describe("the tracer only walks the calls that execute", () => {
  it("does not attribute a call inside a nested def to the method that defines it", async () => {
    // `helper` never runs when `render` runs - the closure only defines it - so its
    // call on an `Any`-typed value must not gap and quarantine the whole Flow.
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/mod.py": `from typing import Any

from app.store import Store


def render(record_id: str, thing: Any) -> str:
    def helper() -> None:
        thing.mystery()

    store = Store()
    return store.read_record(record_id)
`,
        "app/store.py": STORE,
      },
      "app/mod.py",
      null,
      "render",
    );
    expect(trace.gaps).toEqual([]);
    expect([...trace.landmarks.values()].some((l) => l.method.name === "read_record")).toBe(true);
  }, 60_000);
});

describe("a call on one element of a subject collection is unresolved_dispatch, per D3", () => {
  it("reaches the stop for `for r in self.records`, not only a bare identifier", async () => {
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/rec.py": `class Rec:
    def process(self) -> None:
        pass
`,
        "app/svc.py": `from app.rec import Rec


class Service:
    def __init__(self, records: list[Rec]) -> None:
        self.records: list[Rec] = records

    def run(self) -> None:
        for r in self.records:
            r.process()
`,
      },
      "app/svc.py",
      "Service",
      "run",
    );
    // Before the fix `self.records` typed to the container `list` (foreign) and the
    // call on `r` was silently skipped; now the subject element is named, so v1's
    // refusal to close a set through a collection quarantines the Flow.
    expect(trace.gaps.some((g) => g.kind === "unresolved_dispatch")).toBe(true);
  }, 60_000);

  it("reaches the stop for `for r in self.get_records()`, a method-returning collection", async () => {
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/rec.py": `class Rec:
    def process(self) -> None:
        pass
`,
        "app/svc.py": `from app.rec import Rec


class Service:
    def get_records(self) -> list[Rec]:
        return []

    def run(self) -> None:
        for r in self.get_records():
            r.process()
`,
      },
      "app/svc.py",
      "Service",
      "run",
    );
    // The iterable is a method call, not a field; its return element is re-read off
    // the method's declaration so the subject element is named rather than reduced
    // to `list` and dropped as foreign in silence.
    expect(trace.gaps.some((g) => g.kind === "unresolved_dispatch")).toBe(true);
  }, 60_000);

  it("reaches the stop for `for x in helper.items()`, a parameter receiver's method", async () => {
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/rec.py": `class Rec:
    def process(self) -> None:
        pass
`,
        "app/svc.py": `from app.rec import Rec


class Helper:
    def items(self) -> list[Rec]:
        return []


class Service:
    def run(self, helper: Helper) -> None:
        for x in helper.items():
            x.process()
`,
      },
      "app/svc.py",
      "Service",
      "run",
    );
    // The same rule applies to a local/parameter receiver typed to a subject class;
    // `helper.items()` returns `list[Rec]`, so `x.process()` is the D3 stop.
    expect(trace.gaps.some((g) => g.kind === "unresolved_dispatch")).toBe(true);
  }, 60_000);
});

describe("a module-level foreign attribute is not a hole across modules", () => {
  it("reads `other_mod.CONN.execute(...)` as foreign, not a gap", async () => {
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/db.py": `import sqlite3

CONN = sqlite3.connect("x.db")
`,
        "app/svc.py": `from app import db


def run() -> None:
    db.CONN.execute("select 1")
`,
      },
      "app/svc.py",
      null,
      "run",
    );
    // The module reader records `CONN = sqlite3.connect(...)` FOREIGN, exactly as the
    // class reader records `self._conn`, so a call on it is somebody else's rather
    // than an attribute no declaration establishes.
    expect(trace.gaps).toEqual([]);
  }, 60_000);
});

describe("an open() keyword argument is not read as a write mode", () => {
  it("classifies `open(path, encoding=...)` as a durable read, not a filesystem write", async () => {
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/io.py": `def load_config() -> str:
    return open("cfg", encoding="ascii").read()
`,
      },
      "app/io.py",
      null,
      "load_config",
    );
    const entry = trace.landmarks.get(trace.entry)!;
    // The `a` in `ascii` and the `w` in `newline` are not a mode; only a positional
    // string literal is, so the box stays a read rather than flipping to a write.
    expect(entry.externalEffect).toBeUndefined();
    expect(entry.dataAccess?.relation).toBe("read");
  }, 60_000);

  it("classifies `open(path, mode=\"w\")` as a filesystem write, not a durable read", async () => {
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/io.py": `def save(data: str) -> None:
    open("out", mode="w").write(data)
`,
      },
      "app/io.py",
      null,
      "save",
    );
    const entry = trace.landmarks.get(trace.entry)!;
    // The write mode arrives as a `mode=` keyword; reading only the positional second
    // argument missed it and flipped a genuine write to a durable read.
    expect(entry.externalEffect).toBe("filesystem");
    expect(entry.dataAccess).toBeUndefined();
  }, 60_000);

  it("classifies `open(path, \"w\")` as a filesystem write", async () => {
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/io.py": `def save(data: str) -> None:
    open("out", "w").write(data)
`,
      },
      "app/io.py",
      null,
      "save",
    );
    expect(trace.landmarks.get(trace.entry)!.externalEffect).toBe("filesystem");
  }, 60_000);

  it("classifies `open(path, newline=\"\")` as a durable read, not a write", async () => {
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/io.py": `def load() -> str:
    return open("cfg", newline="").read()
`,
      },
      "app/io.py",
      null,
      "load",
    );
    const entry = trace.landmarks.get(trace.entry)!;
    expect(entry.externalEffect).toBeUndefined();
    expect(entry.dataAccess?.relation).toBe("read");
  }, 60_000);
});

describe("a bare subprocess call is a process launch", () => {
  it("marks `Popen(...)` from `from subprocess import Popen` a process effect", async () => {
    const trace = await traceEntry(
      {
        "app/__init__.py": INIT,
        "app/launch.py": `from subprocess import Popen


def launch() -> None:
    Popen(["ls"])
`,
      },
      "app/launch.py",
      null,
      "launch",
    );
    // The bare callee is resolved through its import binding to `subprocess`, so it
    // is the same launch `subprocess.Popen(...)` names.
    expect(trace.landmarks.get(trace.entry)!.externalEffect).toBe("process");
  }, 60_000);
});

describe("the gate does not throw on a targetless Python direct_call claim", () => {
  it("quarantines rather than dereferencing a missing target", async () => {
    const ctx = contextFor({
      "app/__init__.py": INIT,
      "app/a.py": `class Store:
    def handle(self, record_id: str) -> str:
        return "x"
`,
    });
    const claim: FlowClaim = {
      expect: "present",
      matcher: "direct_call",
      from: { path: "app/a.py", name: "handle", owner: "Store", arity: 1 },
      evidence: [{ kind: "file", path: "app/a.py", line_start: 1, line_end: 3, sha: ctx.sha }],
    };
    expect(resolveFlowClaim(ctx, undefined, claim).verdict).toBe("unresolved");
  }, 60_000);
});

describe("a receiver annotated with the FastAPI DI idiom binds its first element", () => {
  it("types `Annotated[Store, Depends(get_store)]` as Store and the gate confirms", async () => {
    const subject = {
      "app/__init__.py": INIT,
      "app/main.py": `from typing import Annotated
from fastapi import Depends, FastAPI

from app.store import Store

app = FastAPI()


def get_store() -> Store:
    return Store()


@app.get("/records/{record_id}")
def show_record(record_id: str, store: Annotated[Store, Depends(get_store)]) -> str:
    return store.read_record(record_id)
`,
      "app/store.py": STORE,
    };
    const { candidate, result } = await gated(subject, "flow-python-fastapi-http");
    // Annotated carries metadata after its object, so the single-element rule cannot
    // apply to it; its first element is the type the receiver is.
    expect(flowOf(candidate).steps.some((step) => step.node === "Store")).toBe(true);
    expect(result.verdict).toBe("confirmed");
  }, 60_000);
});

describe("a handler carrying two route decorators declares two routes", () => {
  it("emits an entry for each distinct verb, not only the first", async () => {
    const candidates = await runAdapter(
      "flow-python-fastapi-http",
      contextFor({
        "app/__init__.py": INIT,
        "app/main.py": `from fastapi import FastAPI

from app import records

app = FastAPI()


@app.get("/records/{record_id}")
@app.post("/records/{record_id}")
def show_record(record_id: str) -> str:
    return records.render(record_id)
`,
        "app/records.py": RECORDS,
        "app/store.py": STORE,
      }),
    );
    // Before the fix the loop broke after the first decorator, dropping the rest in
    // the silence #6 forbids.
    expect(verifiedOnly(candidates).map((c) => flowOf(c).steps[0]!.node).sort()).toEqual([
      "GET /records/{}",
      "POST /records/{}",
    ]);
  }, 60_000);
});

describe("a router mounted on another router is a named cut, not a shorter path", () => {
  it("refuses `nested_mount:` rather than asserting a path missing the outer prefix", async () => {
    const candidates = await runAdapter(
      "flow-python-fastapi-http",
      contextFor({
        "app/__init__.py": INIT,
        "app/routes.py": `from fastapi import APIRouter

from app import records

inner = APIRouter()


@inner.get("/records/{record_id}")
def show(record_id: str) -> str:
    return records.render(record_id)
`,
        "app/main.py": `from fastapi import APIRouter, FastAPI

from app import routes

app = FastAPI()
outer = APIRouter()
outer.include_router(routes.inner, prefix="/inner")
app.include_router(outer, prefix="/api")
`,
        "app/records.py": RECORDS,
        "app/store.py": STORE,
      }),
    );
    expect(verifiedOnly(candidates)).toHaveLength(0);
    expect(only(cutReasons(candidates))).toContain("nested_mount:");
  }, 60_000);
});

describe("the gate resolves an aliased mount to the router the producer named", () => {
  it("confirms `from routes import router as r; app.include_router(r, ...)`", async () => {
    const subject = {
      "app/__init__.py": INIT,
      "app/routes.py": `from fastapi import APIRouter

from app import records

router = APIRouter(prefix="/records")


@router.get("/{record_id}")
def show(record_id: str) -> str:
    return records.render(record_id)
`,
      "app/main.py": `from fastapi import FastAPI

from app.routes import router as r

app = FastAPI()
app.include_router(r, prefix="/api")
`,
      "app/records.py": RECORDS,
      "app/store.py": STORE,
    };
    const { candidate, result } = await gated(subject, "flow-python-fastapi-http");
    expect(flowOf(candidate).steps[0]!.node).toBe("GET /api/records/{}");
    // Before the fix the gate compared the call-site alias `r` to the router name
    // `router` and contradicted a real route; it now resolves the alias first.
    expect(result.verdict).toBe("confirmed");
  }, 60_000);
});

describe("a single-argument add_node infers its key from the function name (#52 D2)", () => {
  it("reads `graph.add_node(ingest)` and the gate re-derives it the same way", async () => {
    const subject = {
      "app/__init__.py": INIT,
      "app/graph.py": `from langgraph.graph import END, StateGraph


def ingest(state: dict) -> dict:
    return state


def deliver(state: dict) -> dict:
    return state


def build() -> object:
    graph = StateGraph(dict)
    graph.add_node(ingest)
    graph.add_node(deliver)
    graph.set_entry_point("ingest")
    graph.add_edge("ingest", "deliver")
    graph.add_edge("deliver", END)
    return graph.compile()
`,
    };
    const { candidate, result } = await gated(subject, "flow-python-langgraph-pipeline");
    expect(flowOf(candidate).steps.map((s) => s.node).sort()).toEqual(["deliver", "ingest"]);
    expect(result.verdict).toBe("confirmed");
  }, 60_000);
});

describe("a topology built outside a titleable def is named, not passed over", () => {
  it("cuts `import_time_topology:` for a module-scope StateGraph", async () => {
    const candidates = await runAdapter(
      "flow-python-langgraph-pipeline",
      contextFor({
        "app/__init__.py": INIT,
        "app/graph.py": `from langgraph.graph import END, StateGraph


def ingest(state: dict) -> dict:
    return state


graph = StateGraph(dict)
graph.add_node("ingest", ingest)
graph.set_entry_point("ingest")
graph.add_edge("ingest", END)
`,
      }),
    );
    // The topology is real and declared, so passing it over would be the #6 silence
    // this cut exists to prevent.
    expect(verifiedOnly(candidates)).toHaveLength(0);
    expect(only(cutReasons(candidates))).toContain("import_time_topology:");
  }, 60_000);
});

describe("an absolute from-import binds its symbol without the removed dead branch", () => {
  it("binds a def imported by its absolute module path as a symbol", async () => {
    const index = await pythonIndex(
      contextFor({
        "app/__init__.py": INIT,
        "app/work.py": "def run_job() -> None:\n    pass\n",
        "app/cli.py": "from app.work import run_job\n",
      }),
    );
    expect(index.bindingsByPath.get("app/cli.py")?.get("run_job")).toEqual({
      kind: "symbol",
      path: "app/work.py",
      name: "run_job",
    });
  }, 60_000);
});
