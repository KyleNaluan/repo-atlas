/**
 * The subject's Python symbol index (#52).
 *
 * It answers the same questions `symbols.ts` answers for Java, and it deliberately
 * answers them into the SAME `TypeSymbol`/`MethodSymbol` shapes. That is not
 * convenience: `trace.ts`'s `TraceResult` and the whole of `candidate.ts` - the
 * landmark compression, the one-arrow-per-relationship grouping, the absent-cut
 * emission - are language-neutral machinery this adapter reuses verbatim (#52
 * budget, "reused unchanged"), and they read a landmark through those two
 * interfaces. A Python index that invented its own symbol shape would have forced
 * a second candidate emitter, and two emitters is two definitions of what a box
 * is.
 *
 * Python declares no types the way Java does, so what fills those shapes is
 * Python's own and is the part worth reading:
 *
 * - A **module** is a pseudo-type. `webui/decision_logs.py` becomes a
 *   `TypeSymbol` named `decision_logs` whose methods are its module-level `def`s.
 *   Report 4.2(a) measured this to be the single largest source of resolvable
 *   steps in Python and it has no Java analogue at all: `from webui import
 *   decision_logs` binds a name to a FILE, and `decision_logs.query_rows(...)`
 *   then names one `def` in exactly one file with no type inference involved.
 * - A **class** is a pseudo-type whose `fields` are the attributes `__init__`
 *   establishes (report 4.2(c)), reconstructed from three single-file shapes.
 * - `bean` is TRUE for both, because in Python a module and a class are exactly
 *   what the subject declares itself to have. `symbols.ts` reads it off a Spring
 *   stereotype for the same reason - it is the subject's own statement of what a
 *   part is - and Python's answer is the file and the class rather than an
 *   annotation. What that buys is `candidate.ts`'s one-box-per-TYPE rule: the
 *   three functions of `decision_logs` the story passes through are one box.
 *
 * Name resolution is by IMPORT, never by a global simple-name map. Java can ask
 * "which subject type is called `Store`"; Python cannot, because the answer is
 * whatever the importing file said it is. So every binding below is read out of
 * the file that uses it, which is also exactly what the gate can re-derive from
 * one blob.
 */
import { isSourceFile } from "../../harvest/tree.js";
import { walk, type SyntaxNode } from "../java.js";
import {
  annotationName,
  decoratedOf,
  endLineOf,
  findAll,
  lineOf,
  nameOf,
  namedChildren,
  parametersOf,
  parsePython,
  positionalArguments,
  superclassNames,
} from "../python.js";
import { dottedNamesOf, moduleOwnerName, packageDirsIn } from "./py-module.js";
import type { ProbeContext } from "../types.js";
import type { MethodSymbol, ParamRef, TypeSymbol } from "./symbols.js";

/**
 * What one name in one file denotes.
 *
 * `foreign` is a positive finding, not a failure: a call on a `pandas` frame is
 * not a hole in the subject's story, and the tracer must be able to tell it from
 * a name it could not resolve at all (#52 report 4.1, the FOREIGN/GAP split).
 */
/**
 * The type recorded for an attribute this reader established as FOREIGN.
 *
 * `TypeSymbol.fields` maps a name to a declared type, and a Python attribute has
 * three states rather than two: a subject type, somebody else's value, and
 * nothing the file states at all. The third must be a NAMED gap at the call site
 * (a silently dropped subject branch could be a durable write) and the second must
 * be silent, so the two cannot share "absent from the map". An empty name resolves
 * to no binding and no same-file class, which is exactly what foreign means here.
 */
export const FOREIGN_ATTRIBUTE = "";

export type Binding =
  /** A subject module, bound by `from pkg import mod` or `import pkg.mod as mod`. */
  | { kind: "module"; path: string }
  /** A subject `def`/`class`, bound by a same-file declaration or a `from ... import`. */
  | { kind: "symbol"; path: string; name: string }
  /** Somebody else's module or name. */
  | { kind: "foreign"; dotted: string }
  /** A subject module or name this reader cannot name uniquely. Named, never guessed. */
  | { kind: "ambiguous"; dotted: string };

export interface PythonIndex {
  /** Production Python paths that were indexed, in tree order. */
  paths: string[];
  /** One pseudo-type per module, keyed by path. */
  modules: Map<string, TypeSymbol>;
  /** Every class the subject declares, keyed by path. */
  classesByPath: Map<string, TypeSymbol[]>;
  /** Modules and classes together - what a landmark's `type` may be. */
  types: TypeSymbol[];
  /** Every dotted module name that resolves in this subject, to the paths claiming it. */
  byDotted: Map<string, string[]>;
  /** Per file: what each name in it denotes. */
  bindingsByPath: Map<string, Map<string, Binding>>;
  /** Per file: its parse tree, so the tracer reads bodies without reparsing. */
  treesByPath: Map<string, SyntaxNode>;
}

/** Whether two nodes of one tree occupy the exact same source span - a stable identity. */
const sameSpan = (a: SyntaxNode, b: SyntaxNode): boolean =>
  a.startPosition.row === b.startPosition.row &&
  a.startPosition.column === b.startPosition.column &&
  a.endPosition.row === b.endPosition.row &&
  a.endPosition.column === b.endPosition.column;

/** A decorator reduced to a name and its argument text, mirroring `AnnotationRef`. */
const decoratorRefs = (definition: SyntaxNode): { name: string; args: string }[] => {
  const decorated = decoratedOf(definition);
  if (!decorated) return [];
  const out: { name: string; args: string }[] = [];
  for (const decorator of decorated.decorators) {
    const expression = namedChildren(decorator)[0];
    if (!expression) continue;
    if (expression.type === "call") {
      const callee = expression.childForFieldName("function");
      const name = callee === null ? null : lastDottedPiece(callee.text);
      if (name) out.push({ name, args: expression.childForFieldName("arguments")?.text ?? "" });
      continue;
    }
    const name = lastDottedPiece(expression.text);
    if (name) out.push({ name, args: "" });
  }
  return out;
};

const lastDottedPiece = (text: string): string | null => {
  const trimmed = text.trim();
  if (!/^[A-Za-z_][\w.]*$/.test(trimmed)) return null;
  return trimmed.split(".").pop() ?? null;
};

/**
 * A `def`'s parameters as `ParamRef`s.
 *
 * `type` carries the parameter's own NAME rather than its annotation, and that is
 * deliberate. The field has two readers in the language-neutral machinery: it
 * separates two Java overloads, and it renders the signature in a rendered box.
 * Python has no overloads, and a Python signature is read by parameter name
 * because its parameters are keyword-callable - so `query_rows(session_id, limit)`
 * is what a reader of that box should see, and a half-annotated list would read as
 * neither a Python signature nor a type list. The annotation is kept verbatim in
 * `declared`, and the tracer reads annotations off the parse tree rather than out
 * of this projection, because it needs the NODE to reduce a container to its
 * element.
 */
const paramRefsOf = (definition: SyntaxNode): ParamRef[] =>
  parametersOf(definition).map((param) => ({
    type: param.name,
    declared: param.annotation?.text.trim() ?? "",
    name: param.name,
  }));

/**
 * The `def`s declared DIRECTLY in one scope - a module body or a class body.
 *
 * "Directly" is the same rule `methodsOf` applies in Java and it matters for the
 * same reason: a closure declared inside a method is that method's own business,
 * and attributing it to the enclosing class would let the tracer draw an arrow
 * into a name no call site can reach.
 */
const definitionsIn = (
  body: SyntaxNode,
  path: string,
  owner: string,
): MethodSymbol[] => {
  const out: MethodSymbol[] = [];
  for (const statement of namedChildren(body)) {
    const definition =
      statement.type === "function_definition"
        ? statement
        : statement.type === "decorated_definition"
          ? statement.childForFieldName("definition")
          : null;
    if (definition?.type !== "function_definition") continue;
    const name = nameOf(definition);
    if (!name) continue;
    const params = paramRefsOf(definition);
    const decorators = decoratorRefs(definition);
    // `self` is not a parameter a call site passes, so it is not part of the
    // arity the gate re-derives at a call site. It IS part of the arity the gate
    // re-derives at a DECLARATION, which is why the count is stored without it
    // and the gate's Python reader accepts either reading - the same tolerance
    // `argumentCounts` already extends to a Java generic comma.
    const bound = params.length > 0 && (params[0]!.name === "self" || params[0]!.name === "cls");
    out.push({
      name,
      owner,
      path,
      params: bound ? params.slice(1) : params,
      returns: declaredReturn(definition),
      annotations: decorators,
      modifiers: [
        ...(definition.text.startsWith("async") ? ["async"] : []),
        ...decorators.map((decorator) => decorator.name),
      ],
      body: definition.childForFieldName("body"),
      // The DECORATED span, so a claim citing a route handler cites the decorator
      // that declares the route beside the `def` that serves it.
      line_start: lineOf(
        definition.parent?.type === "decorated_definition" ? definition.parent : definition,
      ),
      line_end: endLineOf(definition),
    });
  }
  return out;
};

/**
 * What a `def` declares about its return, in three states rather than Java's two.
 *
 * `MethodSymbol.returns` is `null` for a Java `void`; Python needs to separate
 * "returns nothing" from "declares nothing", because the second is the single
 * largest gap #52 measured and the whole of risk R2: dsa's entire pipeline is
 * unreachable because `build_graph` is annotated `-> Any`, and "this subject's
 * execution path passes through a value it declines to type" is a true and
 * interesting statement about the subject rather than something to pass over.
 *
 * - `null`            - no annotation at all. A receiver typed from it is a NAMED gap.
 * - `"None"`          - Python's `void`. Foreign, and silent.
 * - `RETURN_UNREADABLE` - an annotation naming more than one type, or one this
 *                       reader does not reduce. A NAMED gap, never a guess.
 * - anything else     - the one type the annotation names.
 */
export const RETURN_UNREADABLE = "";

const declaredReturn = (definition: SyntaxNode): string | null => {
  const annotation = definition.childForFieldName("return_type");
  if (annotation === null) return null;
  const name = annotationName(annotation);
  if (name !== null) return name;
  return annotation.text.trim() === "None" ? "None" : RETURN_UNREADABLE;
};

/** The `def` nodes declared directly in one body - the nodes, not the projection. */
const methodDefinitionsIn = (body: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (const statement of namedChildren(body)) {
    const definition =
      statement.type === "function_definition"
        ? statement
        : statement.type === "decorated_definition"
          ? statement.childForFieldName("definition")
          : null;
    if (definition?.type === "function_definition") out.push(definition);
  }
  return out;
};

/**
 * The attribute types a class establishes about itself, from three single-file
 * shapes and no others (#52 report 4.2(c)).
 *
 * This is the one place Python is stronger than Java's own rule, and the reason
 * is the GATE's reach rather than a change of principle. `AGENTS.md` records that
 * a Java `var` local typed from its initialiser is marked gate-blind and never
 * used to draw an arrow, because the gate's `typedReceivers` only finds
 * `Type name` declarations. `self._driver = BookSessionDriver(...)` is a literal
 * assignment the gate finds with one regex in the same file, so the initialiser
 * path is admissible here where it is not there.
 *
 * A name established twice at two different types is DROPPED, exactly as
 * `fieldsOf` drops a Java field declared twice: an ambiguous receiver must fail
 * closed and be named at the call site, never resolve to whichever assignment
 * was read last.
 */
const attributeTypesOf = (
  declaration: SyntaxNode,
  bindings: Map<string, Binding>,
  ownScope: string,
): Map<string, string> => {
  const seen = new Map<string, string>();
  const conflicting = new Set<string>();
  const remember = (name: string, type: string): void => {
    const previous = seen.get(name);
    if (previous !== undefined && previous !== type) conflicting.add(name);
    seen.set(name, type);
  };
  const body = declaration.childForFieldName("body");
  if (!body) return seen;

  // Class-body annotations: `_capture: BarCaptureWriter | None = None` written at
  // class level rather than in `__init__`.
  for (const statement of namedChildren(body)) {
    const assignment =
      statement.type === "assignment"
        ? statement
        : statement.type === "expression_statement"
          ? namedChildren(statement).find((child) => child.type === "assignment") ?? null
          : null;
    if (!assignment) continue;
    const left = assignment.childForFieldName("left");
    if (left?.type !== "identifier") continue;
    const type = annotationName(assignment.childForFieldName("type"));
    if (type !== null) remember(left.text, type);
  }

  for (const definition of methodDefinitionsIn(body)) {
    const methodBody = definition.childForFieldName("body");
    if (!methodBody) continue;
    const parameterTypes = new Map<string, string>();
    for (const param of parametersOf(definition)) {
      if (param.type !== null) parameterTypes.set(param.name, param.type);
    }
    for (const assignment of findAll(methodBody, "assignment")) {
      const left = assignment.childForFieldName("left");
      if (left?.type !== "attribute") continue;
      if (left.childForFieldName("object")?.text !== "self") continue;
      const attribute = left.childForFieldName("attribute")?.text;
      if (attribute === undefined) continue;
      // (1) An annotated assignment states the type outright.
      const annotated = annotationName(assignment.childForFieldName("type"));
      if (annotated !== null) {
        remember(attribute, annotated);
        continue;
      }
      const right = assignment.childForFieldName("right");
      if (!right) continue;
      // (2) A constructor initialiser: `self._control = ControlChannel(dir)`.
      if (right.type === "call") {
        const callee = right.childForFieldName("function");
        const name = callee?.type === "identifier" ? callee.text : null;
        if (name !== null && bindings.get(name)?.kind === "symbol") {
          remember(attribute, name);
          continue;
        }
        // A value some other library produced - `self._conn = sqlite3.connect(...)`
        // - is FOREIGN, and saying so is load-bearing. Left unrecorded it reads as
        // "an attribute no declaration establishes", which is a hole; and a call
        // on somebody else's connection object is not a hole in the subject's
        // story. The rooted name is what the file itself states is foreign.
        const root = calleeRoot(callee);
        if (root !== null && bindings.get(root)?.kind === "foreign") {
          remember(attribute, FOREIGN_ATTRIBUTE);
        }
        continue;
      }
      // (3) An annotated-parameter passthrough: `self._runner = runner` where the
      // signature declares `runner: LiveRunner`.
      if (right.type === "identifier") {
        const type = parameterTypes.get(right.text);
        if (type !== undefined) remember(attribute, type);
        continue;
      }
    }
  }
  for (const name of conflicting) seen.delete(name);
  return seen;
};

/** The root identifier of a call's callee - `sqlite3` in `sqlite3.connect(...)`. */
const calleeRoot = (callee: SyntaxNode | null): string | null => {
  let cur = callee;
  while (cur?.type === "attribute") cur = cur.childForFieldName("object");
  return cur?.type === "identifier" ? cur.text : null;
};

/** Module-level annotated assignments, which type a module-level receiver. */
const moduleAttributeTypes = (
  root: SyntaxNode,
  bindings: Map<string, Binding>,
): Map<string, string> => {
  const seen = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const statement of namedChildren(root)) {
    const assignment =
      statement.type === "assignment"
        ? statement
        : statement.type === "expression_statement"
          ? namedChildren(statement).find((child) => child.type === "assignment") ?? null
          : null;
    if (!assignment) continue;
    const left = assignment.childForFieldName("left");
    if (left?.type !== "identifier") continue;
    const annotated = annotationName(assignment.childForFieldName("type"));
    const right = assignment.childForFieldName("right");
    const callee = right?.type === "call" ? right.childForFieldName("function") : null;
    const constructed =
      callee?.type === "identifier" && bindings.get(callee.text)?.kind === "symbol"
        ? callee.text
        : null;
    // A module-level attribute built by a foreign call - `CONN = sqlite3.connect(...)`
    // - is FOREIGN, recorded for the same reason `attributeTypesOf` records a class
    // attribute foreign: left out of the map it reads as "an attribute no declaration
    // establishes", which is a hole, and a call on somebody else's connection is not
    // a hole in the subject's story. Both readers of the three-shape rule must agree
    // on the foreign shape, or a cross-module `mod.CONN.execute(...)` gaps here where
    // it would not on a class.
    const foreign =
      constructed === null && callee !== null && (() => {
        const root = calleeRoot(callee);
        return root !== null && bindings.get(root)?.kind === "foreign";
      })();
    const type = annotated ?? constructed ?? (foreign ? FOREIGN_ATTRIBUTE : null);
    if (type === null) continue;
    const previous = seen.get(left.text);
    if (previous !== undefined && previous !== type) conflicting.add(left.text);
    seen.set(left.text, type);
  }
  for (const name of conflicting) seen.delete(name);
  return seen;
};

const typeSymbol = (
  fields: Map<string, string>,
  rest: Omit<TypeSymbol, "fields" | "fieldsDeclared" | "kind" | "modifiers" | "annotations">,
  options: { annotations?: { name: string; args: string }[]; modifiers?: string[] } = {},
): TypeSymbol => ({
  ...rest,
  kind: "class",
  modifiers: options.modifiers ?? [],
  annotations: options.annotations ?? [],
  // Python has no generic declaration to preserve, and D3 forecloses closing a
  // dispatch set on a declared element type, so the two field maps carry the
  // same reduced name. Keeping both is what lets the language-neutral machinery
  // read a Python landmark through the same interface as a Java one.
  fields,
  fieldsDeclared: fields,
});

/**
 * What every name in one file denotes, read from that file's own imports and
 * declarations.
 *
 * An import is the file's own statement of what a name means, which is why it is
 * read rather than guessed - the same reason `symbols.ts` keeps
 * `importsByPath`. The difference is that in Python the import is the WHOLE of
 * the resolution: there is no global type namespace to fall back on.
 */
const bindingsIn = (
  root: SyntaxNode,
  path: string,
  byDotted: Map<string, string[]>,
  byPath: Set<string>,
): Map<string, Binding> => {
  const out = new Map<string, Binding>();

  const moduleBinding = (dotted: string): Binding => {
    const paths = byDotted.get(dotted);
    if (paths === undefined) return { kind: "foreign", dotted };
    return paths.length === 1 ? { kind: "module", path: paths[0]! } : { kind: "ambiguous", dotted };
  };

  /**
   * The directory a relative import points at - `from .routes import runs` inside
   * `src/ds_agent_web/app.py` points at `src/ds_agent_web/routes`.
   *
   * Relative imports are resolved on PATHS rather than through the dotted table,
   * because a relative import states its own base: the importing file's package.
   * Routing it through the dotted table would ask which of a module's several
   * legitimate absolute names it meant, a question the statement does not pose.
   */
  const relativeBase = (dots: number, tail: string): string | null => {
    const pieces = path.replace(/\.py$/, "").split("/");
    const inPackage = pieces.slice(0, -1);
    const base = inPackage.slice(0, inPackage.length - (dots - 1));
    if (base.length === 0 && dots > 1) return null;
    return [...base, ...(tail === "" ? [] : tail.split("."))].join("/");
  };

  /** The module file a package-relative path names, or null. */
  const moduleAt = (base: string): string | null => {
    for (const candidate of [`${base}.py`, `${base}/__init__.py`]) {
      if (byPath.has(candidate)) return candidate;
    }
    return null;
  };

  for (const statement of findAll(root, "import_statement")) {
    for (const child of namedChildren(statement)) {
      if (child.type === "dotted_name") {
        // `import a.b.c` binds `a`, which this reader does not follow: the name a
        // call site writes is `a.b.c`, rooted in `a`, and typing that root as the
        // package would let a call on `a.b.c` resolve through a module it is not.
        const first = child.text.split(".")[0]!;
        const whole = moduleBinding(child.text);
        out.set(first, child.text.includes(".") ? { kind: "foreign", dotted: child.text } : whole);
        continue;
      }
      if (child.type === "aliased_import") {
        const dotted = namedChildren(child)[0]?.text ?? "";
        const alias = child.childForFieldName("alias")?.text;
        if (alias) out.set(alias, moduleBinding(dotted));
      }
    }
  }

  for (const statement of findAll(root, "import_from_statement")) {
    const moduleNode = statement.childForFieldName("module_name");
    const relativeDots = moduleNode?.type === "relative_import"
      ? (/^\.+/.exec(moduleNode.text)?.[0].length ?? 0)
      : 0;
    const moduleText = moduleNode?.text ?? "";
    const base = relativeDots > 0 ? relativeBase(relativeDots, moduleText.replace(/^\.+/, "")) : null;
    // Absolute-import module name. Every relative import (`relativeDots > 0`)
    // returns inside the loop below before this is read, so it is only consulted
    // when `relativeDots === 0`, where it is exactly `moduleText`.
    const dottedModule = moduleText;
    for (const child of namedChildren(statement)) {
      // The module node is identified by its SOURCE SPAN, not by text+type: for
      // `from app import app` the imported name shares both with the module_name,
      // and skipping on text would leave `app` unbound - a re-export the tracer
      // then cannot follow. Reference equality is unreliable across web-tree-sitter
      // accesses, so position is the stable identity.
      if (moduleNode !== null && sameSpan(child, moduleNode)) continue;
      if (child.type === "wildcard_import") continue;
      const imported =
        child.type === "aliased_import" ? namedChildren(child)[0]?.text ?? "" : child.text;
      const local =
        child.type === "aliased_import"
          ? child.childForFieldName("alias")?.text ?? ""
          : child.text;
      if (local === "" || imported === "") continue;
      if (relativeDots > 0) {
        if (base === null) {
          out.set(local, { kind: "ambiguous", dotted: `${moduleText}.${imported}` });
          continue;
        }
        // A relative import names a SUBMODULE when one exists and a name declared
        // in the package otherwise - the more specific reading first, exactly as
        // `uniqueType` tries a qualified Java name before a simple one.
        const submodule = moduleAt(base === "" ? imported : `${base}/${imported}`);
        if (submodule !== null) {
          out.set(local, { kind: "module", path: submodule });
          continue;
        }
        const owner = base === "" ? null : moduleAt(base);
        out.set(
          local,
          owner === null
            ? { kind: "ambiguous", dotted: `${moduleText}.${imported}` }
            : { kind: "symbol", path: owner, name: imported },
        );
        continue;
      }
      // `from webui import decision_logs` binds a SUBMODULE when one exists, and a
      // name declared inside the package's `__init__` otherwise. The submodule is
      // tried first because it is the more specific statement, exactly as
      // `uniqueType` tries a qualified Java name before a simple one.
      const asModule = byDotted.get(`${dottedModule}.${imported}`);
      if (asModule !== undefined) {
        out.set(
          local,
          asModule.length === 1
            ? { kind: "module", path: asModule[0]! }
            : { kind: "ambiguous", dotted: `${dottedModule}.${imported}` },
        );
        continue;
      }
      const owning = byDotted.get(dottedModule);
      if (owning === undefined) {
        out.set(local, { kind: "foreign", dotted: `${dottedModule}.${imported}` });
        continue;
      }
      out.set(
        local,
        owning.length === 1
          ? { kind: "symbol", path: owning[0]!, name: imported }
          : { kind: "ambiguous", dotted: `${dottedModule}.${imported}` },
      );
    }
  }

  // A same-file declaration binds its own name, and it OVERRIDES an import: the
  // last binding in a file wins in Python too, and a file that both imports and
  // declares a name is one this reader must read the same way the interpreter does.
  walk(root, (node) => {
    if (node.type !== "function_definition" && node.type !== "class_definition") return;
    if (node.parent?.type !== "module" && node.parent?.parent?.type !== "module") return;
    const name = nameOf(node);
    if (name) out.set(name, { kind: "symbol", path, name });
  });

  return out;
};

const CACHE = new WeakMap<ProbeContext, Promise<PythonIndex>>();

/**
 * The subject's production Python modules and classes, parsed once per run.
 *
 * Test sources are excluded through `isSourceFile`, the harvest stage's shared
 * definition, for the reason `javaIndex` gives: a route a test declares is not a
 * route the subject serves.
 */
export const pythonIndex = (ctx: ProbeContext): Promise<PythonIndex> => {
  const cached = CACHE.get(ctx);
  if (cached) return cached;
  const built = (async (): Promise<PythonIndex> => {
    const paths = ctx.paths.filter((p) => p.endsWith(".py") && isSourceFile(p));
    const packageDirs = packageDirsIn(ctx.paths.filter((p) => p.endsWith(".py")));
    const byDotted = new Map<string, string[]>();
    for (const path of paths) {
      for (const dotted of dottedNamesOf(path, packageDirs)) {
        byDotted.set(dotted, [...(byDotted.get(dotted) ?? []), path]);
      }
    }

    const treesByPath = new Map<string, SyntaxNode>();
    for (const path of paths) {
      const source = ctx.read(path);
      if (source === null) continue;
      treesByPath.set(path, await parsePython(source));
    }

    const indexedPaths = new Set(treesByPath.keys());
    const bindingsByPath = new Map<string, Map<string, Binding>>();
    for (const [path, root] of treesByPath) {
      bindingsByPath.set(path, bindingsIn(root, path, byDotted, indexedPaths));
    }

    const modules = new Map<string, TypeSymbol>();
    const classesByPath = new Map<string, TypeSymbol[]>();
    for (const [path, root] of treesByPath) {
      const bindings = bindingsByPath.get(path)!;
      const moduleName = moduleOwnerName(path);
      modules.set(
        path,
        typeSymbol(moduleAttributeTypes(root, bindings), {
          name: moduleName,
          qualified: moduleName,
          path,
          supertypes: new Set<string>(),
          bean: true,
          methods: definitionsIn(root, path, moduleName),
          line_start: 1,
          header_line_end: 1,
          line_end: endLineOf(root),
        }),
      );
      const classes: TypeSymbol[] = [];
      for (const declaration of findAll(root, "class_definition")) {
        const name = nameOf(declaration);
        if (!name) continue;
        const enclosing: string[] = [];
        for (let cur = declaration.parent; cur; cur = cur.parent) {
          if (cur.type !== "class_definition") continue;
          const outerName = nameOf(cur);
          if (outerName) enclosing.unshift(outerName);
        }
        const qualified = [...enclosing, name].join(".");
        const body = declaration.childForFieldName("body");
        classes.push(
          typeSymbol(attributeTypesOf(declaration, bindings, qualified), {
            name,
            qualified,
            path,
            supertypes: new Set(superclassNames(declaration)),
            bean: true,
            methods: body ? definitionsIn(body, path, qualified) : [],
            line_start: lineOf(
              declaration.parent?.type === "decorated_definition" ? declaration.parent : declaration,
            ),
            header_line_end: body ? lineOf(body) - 1 : lineOf(declaration),
            line_end: endLineOf(declaration),
          }),
          );
      }
      classesByPath.set(path, classes);
    }

    return {
      paths,
      modules,
      classesByPath,
      types: [...modules.values(), ...[...classesByPath.values()].flat()],
      byDotted,
      bindingsByPath,
      treesByPath,
    };
  })();
  CACHE.set(ctx, built);
  return built;
};

/** One class in one file by simple or qualified name, or null when ambiguous. */
export const classIn = (
  index: PythonIndex,
  path: string,
  name: string,
): TypeSymbol | null => {
  const declared = index.classesByPath.get(path) ?? [];
  const exact = declared.filter((type) => type.qualified === name);
  if (exact.length === 1) return exact[0]!;
  const simple = declared.filter((type) => type.name === name);
  return simple.length === 1 ? simple[0]! : null;
};

/**
 * The type a binding denotes, or null when it denotes nothing traceable.
 *
 * A `symbol` binding may name a class (a type) or a `def` (a member of the module
 * pseudo-type); this answers only the first question, and the tracer asks the
 * second separately.
 */
export const boundClass = (index: PythonIndex, binding: Binding): TypeSymbol | null =>
  binding.kind === "symbol" ? classIn(index, binding.path, binding.name) : null;

/** The one method a type declares by this name, or null when it declares none or several. */
export const methodNamed = (type: TypeSymbol, name: string): MethodSymbol | null => {
  const found = type.methods.filter((method) => method.name === name);
  return found.length === 1 ? found[0]! : null;
};

/**
 * The method a class resolves a name to, following bases declared IN THE SAME
 * FILE and no further.
 *
 * The stop is the gate's reach, not a limitation of the parse: every rule the
 * Python adapter admits is single-file on both sides, because that is what the
 * gate can re-derive from one blob (#52 report 5.3, "cross-module type
 * inference" is out of v1).
 */
export const methodOnClass = (
  index: PythonIndex,
  type: TypeSymbol,
  name: string,
  seen = new Set<string>(),
): { type: TypeSymbol; method: MethodSymbol } | null => {
  const key = `${type.path}#${type.qualified}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const own = methodNamed(type, name);
  if (own) return { type, method: own };
  for (const base of type.supertypes) {
    const declared = classIn(index, type.path, base);
    if (!declared) continue;
    const found = methodOnClass(index, declared, name, seen);
    if (found) return found;
  }
  return null;
};
