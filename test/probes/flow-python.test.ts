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
import { flowArchetype } from "../../src/rank/flow.js";
import { dottedNamesOf, moduleOwnerName, packageDirsIn } from "../../src/probes/flow/py-module.js";
import type { Candidate, ProbeOutcome } from "../../src/probes/types.js";
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
