/**
 * Python entry-point detection: where a Python execution story is allowed to
 * begin (#52).
 *
 * Every detector reads DECLARATIONS off the parse tree, never text, and the
 * measurement that forces it is the same one `entries.ts` records for Java
 * `main`: `if __name__ == "__main__"` and `@app.get("/x")` both appear inside
 * docstrings and README fences in the two #52 subjects, and a text scan counts
 * those as entry points. Reading them as an `if_statement` and a `decorator`
 * settles it without argument.
 *
 * Four families are inventoried, and one of them exists only to be CUT. #52's
 * D1 keeps framework-callback entries out of v1 because `class X(Strategy)` plus
 * a method named `on_bar` is the entire declaration and nothing in the subject
 * says a bar subscription routes there - admitting it would assert a framework
 * contract the tree does not state, which the confidence contract (#28) forbids.
 * The honest v1 output is a named cut, so the family is INVENTORIED here and
 * refused by name rather than passed over in silence (#6).
 */
import type { SyntaxNode } from "../java.js";
import {
  annotationName,
  decoratedOf,
  decoratorCall,
  endLineOf,
  findAll,
  keywordArgument,
  lineOf,
  nameOf,
  namedChildren,
  positionalArguments,
  stringLiteral,
} from "../python.js";
import { isTomlTable, parseToml } from "../toml.js";
import { normalizedRoute } from "./route.js";
import { methodNamed, type Binding, type PythonIndex } from "./py-symbols.js";
import type { HttpVerb } from "./entries.js";
import type { MethodSymbol, TypeSymbol } from "./symbols.js";

const HTTP_VERBS: Record<string, HttpVerb> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

/** A span the gate must be handed so it can re-derive one half of a route. */
export interface CitedSpan {
  path: string;
  line_start: number;
  line_end: number;
}

export interface PyHttpEntry {
  kind: "http";
  /** The module pseudo-type the handler is declared in. */
  type: TypeSymbol;
  method: MethodSymbol;
  protocol: { method: HttpVerb; path: string };
  /**
   * Every span the composed path was read from, beyond the handler's own.
   *
   * The route is a claim about the tree, and a composed prefix is a claim about
   * TWO more declarations - where the router was built and where it was mounted -
   * so both travel with the entry and both are cited. The gate re-derives the
   * same composition from the same spans with its own reader.
   */
  composition: CitedSpan[];
}

/** A route the subject declares that this reader refuses, and why. */
export interface PyRouteCut {
  /** Kind-tokened, per `AGENTS.md`: the record counts failures without matching prose. */
  reason: string;
  type: TypeSymbol;
  method: MethodSymbol;
}

/** A module-level object a route decorator can be written on. */
interface RouteHost {
  name: string;
  kind: "app" | "router";
  /** A literal `prefix=` at construction, or null when it declares none. */
  prefix: string | null;
  /** True when a `prefix=` was written that is not a literal - a named cut. */
  dynamicPrefix: boolean;
  declaration: CitedSpan;
}

const CONSTRUCTORS: Record<string, RouteHost["kind"]> = { FastAPI: "app", APIRouter: "router" };

/**
 * The FastAPI apps and routers one module declares, at any nesting depth.
 *
 * A host is an identifier assigned a `FastAPI(...)` or `APIRouter(...)`
 * construction, whether that assignment sits at module level or inside a function
 * body - the app-factory pattern (`app = FastAPI(...)` inside `create_app()`, dsa
 * `app.py:61`) is standard FastAPI, and the gate re-derives each host by the same
 * textual `= FastAPI(`/`= APIRouter(` shape from the cited span regardless of
 * where it is nested, so "the producer resolves no further than the gate can
 * re-resolve" holds either way.
 *
 * An identifier the file assigns a host construction more than once cannot be
 * pinned to one host, so it is dropped (fail closed) rather than resolved to
 * whichever assignment was read last - the same "identity pinned exactly or not
 * at all" rule the router-mount reader keeps.
 */
const routeHostsIn = (root: SyntaxNode, path: string): Map<string, RouteHost> => {
  const out = new Map<string, RouteHost>();
  const ambiguous = new Set<string>();
  for (const assignment of findAll(root, "assignment")) {
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (left?.type !== "identifier" || right?.type !== "call") continue;
    const callee = right.childForFieldName("function");
    const constructor = callee?.type === "identifier" ? CONSTRUCTORS[callee.text] : undefined;
    if (constructor === undefined) continue;
    if (out.has(left.text) || ambiguous.has(left.text)) {
      ambiguous.add(left.text);
      out.delete(left.text);
      continue;
    }
    const prefixNode = keywordArgument(right, "prefix");
    const prefix = prefixNode === null ? null : stringLiteral(prefixNode);
    out.set(left.text, {
      name: left.text,
      kind: constructor,
      prefix,
      dynamicPrefix: prefixNode !== null && prefix === null,
      declaration: { path, line_start: lineOf(assignment), line_end: endLineOf(assignment) },
    });
  }
  return out;
};

/** One `include_router(<router>, prefix=...)` the subject writes. */
interface RouterMount {
  /** The path whose router this mount names, when the reader could pin one. */
  routerPath: string;
  /**
   * The router's OWN name in the module that declares it - the attribute of
   * `mod.router_v2` or the imported binding's original name for `router_a`.
   *
   * Carried so a module declaring two routers, one mounted and one not, cannot
   * lend the mounted one's prefix to the other's routes: the consumer matches on
   * `(routerPath, routerName)`, not on the file alone.
   */
  routerName: string;
  prefix: string | null;
  dynamicPrefix: boolean;
  span: CitedSpan;
  /**
   * True when the object this mount is written on is a subject-declared FastAPI
   * app - `app.include_router(...)`.
   *
   * A mount written on another router (`router_b.include_router(router_a, ...)`) is
   * one whose serving prefix depends on where `router_b` is itself mounted, a chain
   * this v1 reader does not resolve; and one written on an object this reader cannot
   * identify pins no host at all. Both are `false`, so the consumer refuses to
   * compose a path from them rather than asserting one missing the outer prefixes.
   */
  appHost: boolean;
}

/**
 * Every `include_router` call the subject writes, resolved to the module whose
 * router it mounts.
 *
 * Two shapes are read and both appear in the wild: `app.include_router(mod.router)`
 * where `mod` is a module this file imports (dsa `app.py:86-88`), and
 * `app.include_router(router)` where `router` is imported by name. Anything else -
 * a router held in a list, one built by a factory - is not resolved, because the
 * gate could not re-derive it from the mounting file's own declarations.
 */
const routerMountsIn = (index: PythonIndex): RouterMount[] => {
  const out: RouterMount[] = [];
  // Every module-level app/router across the subject, so a mount's HOST can be
  // classified: `X.include_router(...)` is an app-mount only where `X` is a FastAPI
  // app the subject declares.
  const hostsByPath = new Map<string, Map<string, RouteHost>>();
  for (const [path, root] of index.treesByPath) hostsByPath.set(path, routeHostsIn(root, path));
  const hostKindOf = (
    bindings: Map<string, Binding>,
    path: string,
    hostNode: SyntaxNode | null,
  ): RouteHost["kind"] | null => {
    if (hostNode?.type === "identifier") {
      return hostsByPath.get(path)?.get(hostNode.text)?.kind ?? null;
    }
    // `mod.app.include_router(...)`: the app is declared in the imported module.
    if (hostNode?.type === "attribute" && hostNode.childForFieldName("object")?.type === "identifier") {
      const bound = bindings.get(hostNode.childForFieldName("object")!.text);
      const attribute = hostNode.childForFieldName("attribute")?.text;
      if (bound?.kind === "module" && attribute !== undefined) {
        return hostsByPath.get(bound.path)?.get(attribute)?.kind ?? null;
      }
    }
    return null;
  };
  for (const [path, root] of index.treesByPath) {
    const bindings = index.bindingsByPath.get(path);
    if (!bindings) continue;
    for (const call of findAll(root, "call")) {
      const callee = call.childForFieldName("function");
      if (callee?.type !== "attribute") continue;
      if (callee.childForFieldName("attribute")?.text !== "include_router") continue;
      const first = positionalArguments(call)[0];
      if (first === undefined) continue;
      const hostKind = hostKindOf(bindings, path, callee.childForFieldName("object"));
      // Both shapes name the router by its OWN identity in the declaring module:
      // `mod.router_v2` by the attribute, and `router_a` by the imported binding's
      // original name. Anything else - a router in a list, one a factory returns -
      // pins no identity and is left unresolved, so the routes it would mount stay
      // an `unmounted_router:` cut rather than borrowing another router's prefix.
      const resolved: { path: string; name: string } | null =
        first.type === "attribute" && first.childForFieldName("object")?.type === "identifier"
          ? (() => {
              const bound = bindings.get(first.childForFieldName("object")!.text);
              const attribute = first.childForFieldName("attribute")?.text;
              return bound?.kind === "module" && attribute !== undefined
                ? { path: bound.path, name: attribute }
                : null;
            })()
          : first.type === "identifier"
            ? (() => {
                const bound = bindings.get(first.text);
                return bound?.kind === "symbol" ? { path: bound.path, name: bound.name } : null;
              })()
            : null;
      if (resolved === null) continue;
      const prefixNode = keywordArgument(call, "prefix");
      const prefix = prefixNode === null ? null : stringLiteral(prefixNode);
      const statement = enclosingStatement(call);
      out.push({
        routerPath: resolved.path,
        routerName: resolved.name,
        prefix,
        dynamicPrefix: prefixNode !== null && prefix === null,
        span: { path, line_start: lineOf(statement), line_end: endLineOf(statement) },
        appHost: hostKind === "app",
      });
    }
  }
  return out;
};

const STATEMENT_PARENT = /_statement$/;

const enclosingStatement = (node: SyntaxNode): SyntaxNode => {
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
    if (STATEMENT_PARENT.test(cur.type)) return cur;
  }
  return node;
};

/**
 * Every FastAPI route the subject declares, with the prefix its own wiring
 * composes - and a named cut for each one this reader refuses.
 *
 * The refusals are the interesting half. A path or prefix that is not a string
 * literal is `dynamic_route_path:`/`dynamic_route_prefix:`, the same shape the
 * TypeScript transport seam already names for a template URL. A router nothing in
 * the subject mounts is `unmounted_router:`: its decorated functions exist, but
 * nothing in the tree says the application serves them, and asserting a route
 * would be asserting a mount the subject never wrote.
 */
export const pyHttpEntries = (index: PythonIndex): { entries: PyHttpEntry[]; cuts: PyRouteCut[] } => {
  const entries: PyHttpEntry[] = [];
  const cuts: PyRouteCut[] = [];
  const mounts = routerMountsIn(index);
  for (const [path, root] of index.treesByPath) {
    const module = index.modules.get(path);
    if (!module) continue;
    const hosts = routeHostsIn(root, path);
    if (hosts.size === 0) continue;
    for (const definition of findAll(root, "function_definition")) {
      const decorated = decoratedOf(definition);
      if (!decorated || decorated.decorators.length === 0) continue;
      const name = nameOf(definition);
      if (!name) continue;
      const method = methodNamed(module, name);
      // Only a module-level handler: a route registered on a nested `def` is one
      // whose declaration the gate's own module-level reader would not find.
      if (!method) continue;
      // Each decorator is its own (verb, path): a handler carrying two route
      // decorators declares two routes, so every branch below `continue`s to the
      // next decorator rather than stopping at the first - a `break` here dropped
      // the rest in the silence #6 forbids.
      for (const decorator of decorated.decorators) {
        const call = decoratorCall(decorator);
        if (!call) continue;
        const host = hosts.get(call.object);
        const verb = HTTP_VERBS[call.attribute];
        if (host === undefined || verb === undefined) continue;
        const literal = stringLiteral(positionalArguments(call.call)[0] ?? null);
        if (literal === null) {
          cuts.push({
            reason: `dynamic_route_path: ${path} registers ${call.object}.${call.attribute} on a path that is not one string literal, so no route can be claimed`,
            type: module,
            method,
          });
          continue;
        }
        if (host.dynamicPrefix) {
          cuts.push({
            reason: `dynamic_route_prefix: ${host.name} in ${path} is constructed with a prefix that is not a string literal, so the composed path is not established`,
            type: module,
            method,
          });
          continue;
        }
        const composition: CitedSpan[] = [];
        let prefix = host.prefix ?? "";
        if (host.kind === "router") {
          composition.push(host.declaration);
          const mounted = mounts.filter(
            (mount) => mount.routerPath === path && mount.routerName === host.name,
          );
          if (mounted.length === 0) {
            cuts.push({
              reason: `unmounted_router: ${path} declares ${host.name} = APIRouter(...) and nothing in this subject calls include_router on it, so no line in the tree says the application serves this route`,
              type: module,
              method,
            });
            continue;
          }
          // A mount written on anything but a subject FastAPI app - another router
          // (a nested mount whose outer prefix this v1 reader does not compose) or
          // an object it cannot identify - pins no serving prefix, so the composed
          // path would be missing the outer segments. Cut it by name rather than
          // asserting the shorter path.
          if (mounted.some((mount) => !mount.appHost)) {
            cuts.push({
              reason: `nested_mount: ${path}'s router ${host.name} is mounted on an object that is not a subject FastAPI app, so this v1 reader cannot compose the served path`,
              type: module,
              method,
            });
            continue;
          }
          if (mounted.some((mount) => mount.dynamicPrefix)) {
            cuts.push({
              reason: `dynamic_route_prefix: ${path}'s router is mounted with a prefix that is not a string literal`,
              type: module,
              method,
            });
            continue;
          }
          const prefixes = [...new Set(mounted.map((mount) => mount.prefix ?? ""))];
          if (prefixes.length > 1) {
            cuts.push({
              reason: `ambiguous_route_mount: ${path}'s router is mounted at ${prefixes.length} different prefixes (${prefixes.join(", ")}), so this route has no single path`,
              type: module,
              method,
            });
            continue;
          }
          prefix = `${prefixes[0] ?? ""}${prefix}`;
          for (const mount of mounted) composition.push(mount.span);
        }
        entries.push({
          kind: "http",
          type: module,
          method,
          protocol: { method: verb, path: normalizedRoute(`${prefix}/${literal}`) },
          composition,
        });
      }
    }
  }
  return { entries, cuts };
};

export interface PyProgramEntry {
  kind: "program";
  type: TypeSymbol;
  method: MethodSymbol;
  /** How the subject declares this function to be startable. */
  via: "console_script" | "main_guard";
  /** The declaration that establishes it: a manifest entry, or the guard block. */
  declaration: CitedSpan;
  /** The console-script name, when that is what declared it. */
  script?: string;
}

/**
 * Every function the subject declares it can be started as a program.
 *
 * Two shapes, and both are DECLARATIONS rather than text:
 *
 * - a `[project.scripts]` entry in `pyproject.toml` naming `module:function`,
 *   which is machine-checkable end to end,
 * - an `if __name__ == "__main__":` guard whose block calls a function this file
 *   declares.
 *
 * The guard is read off the tree as an `if_statement` over the literal condition,
 * which is what keeps the seventeen real guards in ftb separate from the ones
 * inside docstrings. Whether anything RUNS the program is a different question
 * and this reader does not answer it: `flow-java-cli` handles the same shape by
 * titling its Flow "entry to terminal", and #52 report 4.3 says to copy that.
 */
export const pyProgramEntries = (
  index: PythonIndex,
  read: (path: string) => string | null,
): PyProgramEntry[] => {
  const out: PyProgramEntry[] = [];
  const seen = new Set<string>();
  const remember = (entry: PyProgramEntry): void => {
    const key = `${entry.type.path}#${entry.method.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  const manifest = read("pyproject.toml");
  if (manifest !== null) {
    const root = parseToml(manifest);
    const project = root === null ? undefined : root["project"];
    const scripts = isTomlTable(project) ? project["scripts"] : undefined;
    if (isTomlTable(scripts)) {
      const lines = manifest.split("\n");
      for (const [script, target] of Object.entries(scripts)) {
        if (typeof target !== "string") continue;
        const [dotted, functionName] = target.split(":");
        if (dotted === undefined || functionName === undefined) continue;
        const paths = index.byDotted.get(dotted);
        if (paths?.length !== 1) continue;
        const module = index.modules.get(paths[0]!);
        const method = module === undefined ? null : methodNamed(module, functionName);
        if (!module || !method) continue;
        // The manifest line the entry rests on, found by its own key so the claim
        // cites the declaration rather than the whole table.
        const at = lines.findIndex((line) =>
          new RegExp(String.raw`^\s*["']?${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\s*=`).test(line),
        );
        if (at < 0) continue;
        remember({
          kind: "program",
          type: module,
          method,
          via: "console_script",
          declaration: { path: "pyproject.toml", line_start: at + 1, line_end: at + 1 },
          script,
        });
      }
    }
  }

  for (const [path, root] of index.treesByPath) {
    const module = index.modules.get(path);
    if (!module) continue;
    for (const statement of findAll(root, "if_statement")) {
      const condition = statement.childForFieldName("condition");
      if (condition?.type !== "comparison_operator") continue;
      const pieces = namedChildren(condition);
      const left = pieces[0];
      const right = pieces[pieces.length - 1];
      if (left?.text !== "__name__") continue;
      if (stringLiteral(right ?? null) !== "__main__") continue;
      const body = statement.childForFieldName("consequence");
      if (!body) continue;
      // The block names the function it calls; a guard that calls nothing this
      // file declares establishes no entry, and says so by finding none.
      for (const call of findAll(body, "call")) {
        const callee = call.childForFieldName("function");
        if (callee?.type !== "identifier") continue;
        const method = methodNamed(module, callee.text);
        if (!method) continue;
        remember({
          kind: "program",
          type: module,
          method,
          via: "main_guard",
          declaration: {
            path,
            line_start: lineOf(statement),
            line_end: endLineOf(statement),
          },
        });
      }
    }
  }
  return out;
};

export interface PyPipelineNode {
  key: string;
  /** The `def` the topology registers under `key`, wherever in the file it sits. */
  method: MethodSymbol;
  /** The `add_node("<key>", <name>)` statement, which is what the gate re-reads. */
  registration: CitedSpan;
}

export interface PyPipelineEdge {
  from: string;
  to: string;
  span: CitedSpan;
}

export interface PyPipeline {
  kind: "pipeline";
  /** The module pseudo-type the topology is declared in. */
  type: TypeSymbol;
  /** The function the topology is built inside, which the entry box is titled by. */
  builder: MethodSymbol;
  /** The `StateGraph(...)` construction, cited by every claim as the graph's identity. */
  graph: CitedSpan;
  entryKey: string;
  /** The `set_entry_point`/`add_edge(START, ...)` statement establishing the entry. */
  entrySpan: CitedSpan;
  nodes: PyPipelineNode[];
  edges: PyPipelineEdge[];
  /** Keys the topology declares terminal by drawing an edge to `END`. */
  terminalKeys: string[];
}

/** A declared topology this reader refuses, and why. */
export interface PyPipelineCut {
  reason: string;
  type: TypeSymbol;
  method: MethodSymbol;
}

const GRAPH_CONSTRUCTORS = new Set(["StateGraph", "MessageGraph", "Graph"]);

/**
 * Bases that declare a SHAPE the subject fills, not a runtime that calls it.
 *
 * `typing.Protocol` is the one that matters and it is the one that showed up: ftb
 * declares six `Protocol` interfaces whose members are all named `on_*`
 * (`MarketHubListener.on_bar_message`), and a first draft of this inventory cut
 * all seventeen of them as framework callbacks. They are the opposite thing - a
 * contract the SUBJECT wrote, for its own implementations to fill - so a call
 * through one is a dispatch question, not an entry-family question. The rest are
 * here for the same reason: `ABC`, `Generic`, `Enum`, `NamedTuple` and
 * `TypedDict` all state a shape and none of them owns an object's lifecycle.
 */
const STRUCTURAL_BASES = new Set([
  "Protocol",
  "ABC",
  "ABCMeta",
  "Generic",
  "Enum",
  "IntEnum",
  "StrEnum",
  "Flag",
  "IntFlag",
  "NamedTuple",
  "TypedDict",
  "Exception",
  "BaseException",
]);

/**
 * The one `def` a file declares by this name, at any nesting depth, or null.
 *
 * The pipeline's node functions are closures inside the builder on the reference
 * subject (`graph.py:698-1000` inside `build_graph`), and the report's gate
 * derivation is "that identifier is declared as a `def` in the same file" - so
 * this is the question both sides ask, and it is deliberately NOT the
 * module-level question `direct_call` asks. Two `def`s of one name in one file
 * fail closed: a topology that could be registering either establishes neither.
 */
const soleDefinitionNamed = (
  index: PythonIndex,
  path: string,
  name: string,
): MethodSymbol | null => {
  const root = index.treesByPath.get(path);
  const module = index.modules.get(path);
  if (!root || !module) return null;
  const found = findAll(root, "function_definition").filter(
    (definition) => nameOf(definition) === name,
  );
  if (found.length !== 1) return null;
  const definition = found[0]!;
  const declared = methodNamed(module, name);
  if (declared) return declared;
  // A nested `def` is not a member of the module pseudo-type, so it is projected
  // into a MethodSymbol here - the same shape, owned by the module the file is.
  return {
    name,
    owner: module.qualified,
    path,
    params: [],
    returns: annotationName(definition.childForFieldName("return_type")),
    annotations: [],
    modifiers: [],
    body: definition.childForFieldName("body"),
    line_start: lineOf(
      definition.parent?.type === "decorated_definition" ? definition.parent : definition,
    ),
    line_end: endLineOf(definition),
  };
};

/**
 * Every LangGraph topology the subject declares in literals, and a named cut for
 * each one it declares in something else.
 *
 * #52's D2 settles that a declared topology IS a Flow: it has an entry, steps and
 * terminals, which is what a Flow is, and the precedent for an arrow whose source
 * is not a call is `process_launch`. What this reader admits is exactly what both
 * sides can re-derive from one file: `add_node("<key>", <name>)` with a literal
 * and a bare identifier, `add_edge("<from>", "<to>")` with two literals, and an
 * entry named by `set_entry_point("<key>")` or `add_edge(START, "<key>")`.
 *
 * `add_conditional_edges` is a cut by name. Its branch table is a callable
 * returning a key at runtime, so the arrows it draws are not declared anywhere -
 * which is the `runtime_registration:` family report 4.4 names.
 */
export const pyPipelines = (
  index: PythonIndex,
): { pipelines: PyPipeline[]; cuts: PyPipelineCut[] } => {
  const pipelines: PyPipeline[] = [];
  const cuts: PyPipelineCut[] = [];
  for (const [path, root] of index.treesByPath) {
    const module = index.modules.get(path);
    if (!module) continue;
    for (const assignment of findAll(root, "assignment")) {
      const left = assignment.childForFieldName("left");
      const right = assignment.childForFieldName("right");
      if (left?.type !== "identifier" || right?.type !== "call") continue;
      const callee = right.childForFieldName("function");
      if (callee?.type !== "identifier" || !GRAPH_CONSTRUCTORS.has(callee.text)) continue;
      const holder = left.text;
      const enclosing = enclosingBuilder(index, path, assignment);
      if (enclosing === null) {
        // A topology built at import time in the module body, or inside a def this
        // reader cannot title the Flow by, is a REAL declared topology with no
        // builder to name it. #6 forbids passing it over in silence, so it is a
        // named cut rather than a `continue`.
        cuts.push({
          reason: `import_time_topology: ${path} builds ${holder} = ${callee.text}(...) outside a module-level def this reader can title the Flow by, so the declared topology is named rather than drawn`,
          type: module,
          method: moduleLevelBuilder(module, assignment, holder),
        });
        continue;
      }

      const nodes: PyPipelineNode[] = [];
      const edges: PyPipelineEdge[] = [];
      const terminalKeys: string[] = [];
      let entryKey: string | null = null;
      let entrySpan: CitedSpan | null = null;
      let cut: string | null = null;

      const scope = enclosing.body ?? root;
      for (const call of findAll(scope, "call")) {
        const target = call.childForFieldName("function");
        if (target?.type !== "attribute") continue;
        if (target.childForFieldName("object")?.text !== holder) continue;
        const operation = target.childForFieldName("attribute")?.text;
        const args = positionalArguments(call);
        const statement = enclosingStatement(call);
        const span: CitedSpan = {
          path,
          line_start: lineOf(statement),
          line_end: endLineOf(statement),
        };
        if (operation === "add_node") {
          // LangGraph documents two shapes and both are fully declared: the paired
          // `add_node("<key>", <fn>)` names the key, and the single-argument
          // `add_node(<fn>)` infers it from the function name. Both are read here;
          // anything else - a key or function that is not a literal or a bare name -
          // is a `runtime_registration:` cut.
          const twoArg = args.length >= 2;
          const key = twoArg
            ? stringLiteral(args[0] ?? null)
            : args[0]?.type === "identifier"
              ? args[0].text
              : null;
          const identifier = twoArg ? args[1] : args[0];
          if (key === null || identifier?.type !== "identifier") {
            cut = `runtime_registration: ${path} registers a ${holder} node with something other than a (string-literal key, bare function) pair or a single bare function name`;
            break;
          }
          const method = soleDefinitionNamed(index, path, identifier.text);
          if (method === null) {
            cut = `unresolved_target: ${path} registers the node "${key}" as ${identifier.text}, which this file does not declare as exactly one def`;
            break;
          }
          nodes.push({ key, method, registration: span });
          continue;
        }
        if (operation === "set_entry_point") {
          const key = stringLiteral(args[0] ?? null);
          if (key === null) {
            cut = `runtime_registration: ${path} sets the ${holder} entry point to something other than a string literal`;
            break;
          }
          entryKey = key;
          entrySpan = span;
          continue;
        }
        if (operation === "add_edge") {
          const from = args[0];
          const to = args[1];
          const fromKey = stringLiteral(from ?? null);
          const toKey = stringLiteral(to ?? null);
          // `START`/`END` are the framework's own sentinels, imported by name.
          // An edge from START declares the entry; an edge to END declares a
          // terminal. Neither is a box: the sentinel is not a step of the story.
          const fromSentinel = from?.type === "identifier" && from.text === "START";
          const toSentinel = to?.type === "identifier" && to.text === "END";
          if (fromSentinel && toKey !== null) {
            entryKey = toKey;
            entrySpan = span;
            continue;
          }
          if (toSentinel && fromKey !== null) {
            terminalKeys.push(fromKey);
            continue;
          }
          if (fromKey === null || toKey === null) {
            cut = `runtime_registration: ${path} draws a ${holder} edge whose endpoints are not both string literals`;
            break;
          }
          edges.push({ from: fromKey, to: toKey, span });
          continue;
        }
        if (operation === "add_conditional_edges") {
          cut = `runtime_registration: ${path} routes ${holder} through add_conditional_edges, whose branch is chosen by a callable at run time rather than declared`;
          break;
        }
      }

      if (cut !== null) {
        cuts.push({ reason: cut, type: module, method: enclosing });
        continue;
      }
      if (nodes.length === 0) {
        cuts.push({
          reason: `no_declared_nodes: ${path} builds ${holder} = ${callee.text}(...) and registers no node with a literal key`,
          type: module,
          method: enclosing,
        });
        continue;
      }
      if (entryKey === null || entrySpan === null) {
        cuts.push({
          reason: `no_declared_entry: ${path} declares ${nodes.length} ${holder} nodes and no set_entry_point or START edge, so the topology names no beginning`,
          type: module,
          method: enclosing,
        });
        continue;
      }
      const registered = new Set(nodes.map((node) => node.key));
      const dangling = [...edges.flatMap((edge) => [edge.from, edge.to]), entryKey, ...terminalKeys].filter(
        (key) => !registered.has(key),
      );
      if (dangling.length > 0) {
        cuts.push({
          reason: `unresolved_target: ${path} draws ${holder} edges naming ${[...new Set(dangling)].join(", ")}, which no add_node registered`,
          type: module,
          method: enclosing,
        });
        continue;
      }
      pipelines.push({
        kind: "pipeline",
        type: module,
        builder: enclosing,
        graph: {
          path,
          line_start: lineOf(enclosingStatement(assignment)),
          line_end: endLineOf(enclosingStatement(assignment)),
        },
        entryKey,
        entrySpan,
        nodes,
        edges,
        terminalKeys,
      });
    }
  }
  return { pipelines, cuts };
};

/**
 * The module-level `def` a topology is built inside, or null.
 *
 * A topology built at import time in the module body has no builder to title the
 * figure by and no scope to bound the search, so it is left alone rather than
 * guessed at; neither #52 subject writes one.
 */
/**
 * A synthetic builder for a topology with no module-level def to name it, so an
 * `import_time_topology:` cut has a landmark to name itself by (#6). It owns
 * nothing and traces nothing - `soleLandmarkTrace` reads only its name and span.
 */
const moduleLevelBuilder = (
  module: TypeSymbol,
  assignment: SyntaxNode,
  holder: string,
): MethodSymbol => {
  const statement = enclosingStatement(assignment);
  return {
    name: holder,
    owner: module.qualified,
    path: module.path,
    params: [],
    returns: null,
    annotations: [],
    modifiers: [],
    body: null,
    line_start: lineOf(statement),
    line_end: endLineOf(statement),
  };
};

const enclosingBuilder = (
  index: PythonIndex,
  path: string,
  node: SyntaxNode,
): MethodSymbol | null => {
  const module = index.modules.get(path);
  if (!module) return null;
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type !== "function_definition") continue;
    const name = nameOf(cur);
    if (!name) return null;
    return methodNamed(module, name);
  }
  return null;
};

export interface PyFrameworkCallback {
  type: TypeSymbol;
  method: MethodSymbol;
  /** The base class the subclass declares, which is what makes this a framework. */
  base: string;
}

/**
 * Every framework lifecycle callback the subject declares - the family #52's D1
 * keeps OUT of v1, inventoried here so the refusal can be said by name.
 *
 * The shape is read generically rather than vendored to one framework: a class
 * whose declared base this subject does not declare (so the base is somebody
 * else's), carrying a method named `on_<something>` that nothing in the subject
 * calls. That is exactly `class PersonalBookStrategy(Strategy)` with `on_bar` on
 * ftb, and it is the whole of the declaration - which is the point. For
 * `@Scheduled`, PR 8 could cite three declarations that establish the trigger,
 * including the `@EnableScheduling` a subject that never writes it would not run
 * without. Nothing here plays that part: `on_start` calling `self.subscribe_bars`
 * is the closest thing to a citation and the link from it to `on_bar` is
 * convention, not declaration. D1's recorded v2 proposal is to admit the family
 * on exactly that citation, and it deserves its own resolution first.
 */
export const pyFrameworkCallbacks = (index: PythonIndex): PyFrameworkCallback[] => {
  // Deliberately no "and nothing calls it" filter. The first draft of this
  // inventory carried one, matching method names across the whole subject, and it
  // dropped `PersonalBookStrategy.on_bar` - ftb's best story and the exact method
  // D1 is about - because an unrelated `IntradaySleeve.on_bar` is called
  // elsewhere. A name-only scan cannot tell two classes' callbacks apart, and the
  // refusal does not rest on that question anyway: what D1 refuses is admitting
  // the DECLARATION as an entry, and the declaration is the subclass plus the
  // method. Whether other subject code also calls the method is a tracer
  // question, answered where the tracer answers it.
  const out: PyFrameworkCallback[] = [];
  for (const [path, classes] of index.classesByPath) {
    const bindings = index.bindingsByPath.get(path);
    for (const type of classes) {
      for (const base of type.supertypes) {
        const bound = bindings?.get(base);
        // A base the subject itself declares is not a framework, and an unbound
        // name states nothing at all. Only an import from outside the subject
        // makes the base somebody else's contract.
        if (bound?.kind !== "foreign") continue;
        // A structural base states a SHAPE and owns no lifecycle, so it is not the
        // framework this family names - but it may sit before the real base in
        // `class X(Generic[T], Strategy)`, so skip past it rather than abandoning
        // the class, which would leave the real callback a #6 silence.
        if (STRUCTURAL_BASES.has(base)) continue;
        for (const method of type.methods) {
          if (!/^on_[a-z]/.test(method.name)) continue;
          out.push({ type, method, base });
        }
        break;
      }
    }
  }
  return out;
};
