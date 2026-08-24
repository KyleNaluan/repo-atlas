/**
 * The bounded typed trace for Python: from one entry point to its terminals, or
 * nothing (#52).
 *
 * It answers the same question `trace.ts` answers and it obeys the same three
 * rules, which are the whole of what makes a Flow a Flow rather than a call graph:
 *
 * - **A gap anywhere the entry reaches quarantines the whole candidate**, not
 *   merely a gap on a path that survived pruning. So this module never returns a
 *   shortened chain; `retained` and `flowCandidate` are reused verbatim, and the
 *   quarantine comes out of the shared machinery rather than being re-decided here.
 * - **The producer resolves no further than the gate can re-resolve.** Every rule
 *   below is single-file on BOTH sides, because the gate re-reads one blob with
 *   its own scanner. That is what cuts a receiver held in another type's
 *   attribute, a chained call whose inner callee is not a same-file `def`, and any
 *   cross-file return type - each by name.
 * - **Every stop names itself** with a kind token, so the record counts failures
 *   without string-matching a sentence.
 *
 * What is different is what Python gives a reader to stand on. Java types a
 * receiver from a declaration; Python has none, so the four shapes below are
 * reconstructed instead, and #52 report 4.2 measured that these four are exactly
 * the ones both sides can re-derive within one file:
 *
 * (a) a module-qualified free-function call - `decision_logs.query_rows(...)`
 *     where `from webui import decision_logs` binds the name to a FILE. This has
 *     no Java analogue and is the largest source of resolvable steps in Python.
 * (b) `self.m(...)` and `self._x.m(...)`, the second typed by the three
 *     `__init__` shapes `py-symbols.ts` reconstructs.
 * (c) an annotated parameter, local or class-name receiver.
 * (d) a same-file `def`'s return annotation, propagated one step - which is what
 *     makes `path.stat()` foreign rather than a hole after `_session_path(...) ->
 *     Path`, and what makes a value derived from a foreign expression foreign.
 *
 * The one closure rule is `py-dispatch.ts`'s keyed registry (#52 D3). A call
 * through an ABC-typed collection, a `Callable` alias or a `Protocol` is
 * `unresolved_dispatch:`, by decision rather than by omission.
 */
import { walk, type SyntaxNode } from "../java.js";
import {
  annotationElement,
  annotationName,
  endLineOf,
  findAll,
  lineOf,
  namedChildren,
  parametersOf,
  receiverRoot,
} from "../python.js";
import { readsDurably, writesDurably } from "./sql.js";
import { keyedRegistriesIn, type KeyedRegistry } from "./py-dispatch.js";
import {
  classIn,
  methodNamed,
  methodOnClass,
  RETURN_UNREADABLE,
  type Binding,
  type PythonIndex,
} from "./py-symbols.js";
import type { MethodSymbol, TypeSymbol } from "./symbols.js";
import {
  BOUNDS,
  methodKey,
  type GapKind,
  type TraceEdge,
  type TraceGap,
  type TraceLandmark,
  type TraceResult,
} from "./trace.js";

/**
 * Calls that leave the process, read from the CALLEE as the source wrote it.
 *
 * Read from the body rather than from a method's name, exactly as
 * `externalEffectOf` does for Java, because "commit" and "run" say nothing on
 * their own. The three lists are the spellings that actually cross the boundary
 * in Python, and each is anchored to what is being called rather than to what the
 * receiver is: `Path.write_text` and a file handle's `.write` are the same
 * boundary written two ways, and neither receiver is typeable here.
 */
const PROCESS_CALLS = new Set([
  "Popen",
  "run",
  "call",
  "check_call",
  "check_output",
  "system",
  "spawnl",
  "spawnv",
  "execv",
  "execvp",
  "fork",
]);
const PROCESS_MODULES = new Set(["subprocess", "os"]);

const FILE_WRITE_CALLS = new Set([
  "write_text",
  "write_bytes",
  "mkdir",
  "makedirs",
  "touch",
  "unlink",
  "rename",
  "replace",
  "rmdir",
  "rmtree",
  "copy",
  "copy2",
  "copyfile",
  "move",
  "remove",
  "to_csv",
  "to_parquet",
  "to_json",
  "writerow",
  "writerows",
  "dump",
]);

const FILE_READ_CALLS = new Set([
  "read_text",
  "read_bytes",
  "read_csv",
  "read_parquet",
  "read_json",
  "iterdir",
  "listdir",
  "glob",
  "rglob",
  "walk",
  "load",
  "loads",
]);

/** The write modes an `open(...)` second argument may carry. */
const WRITE_MODE = /[wax+]/;

/**
 * What one method body does to the world outside the process.
 *
 * The split between the two answers is not cosmetic and it is the reason a
 * filesystem READ is not reported as an external effect. `candidate.ts` renders a
 * component with an external effect as an `aside` - beside the story rather than
 * inside it - which is right for a process launch and for a write, and wrong for
 * the middle of a read path: ftb's `read_decision_log` reads the log AND hands
 * the records on to `DecisionRecord.from_dict`, so it is a durable read that the
 * story continues through. A durable read is one of #35's terminals, so it is
 * marked as one, and the box stays a plain box.
 *
 * Neither answer is ever a claim: no arrow rests on it, and the box's own
 * evidence is the declaration. It decides only where a path may END.
 */
const outsideEffectOf = (
  method: MethodSymbol,
): { external?: "process" | "filesystem"; durable?: "read" | "write" } => {
  if (!method.body) return {};
  let external: "process" | "filesystem" | undefined;
  let durable: "read" | "write" | undefined;
  const body = method.body;
  // SQL the body itself writes is the strongest statement available, and it is
  // read through the SAME `sql.ts` predicates the Java producer and the gate both
  // use - one definition of "a read", as `manifests.ts` is one definition of
  // "declared".
  const text = body.text;
  if (writesDurably(text)) durable = "write";
  else if (readsDurably(text)) durable = "read";
  walk(body, (node) => {
    if (external === "process") return;
    if (node.type !== "call") return;
    const callee = node.childForFieldName("function");
    if (!callee) return;
    const name =
      callee.type === "attribute"
        ? callee.childForFieldName("attribute")?.text
        : callee.type === "identifier"
          ? callee.text
          : undefined;
    if (name === undefined) return;
    const root = receiverRoot(callee.type === "attribute" ? callee.childForFieldName("object") : null);
    const rootName = root?.type === "identifier" ? root.text : undefined;
    if (PROCESS_CALLS.has(name) && rootName !== undefined && PROCESS_MODULES.has(rootName)) {
      external = "process";
      return;
    }
    if (name === "open") {
      const args = namedChildren(node.childForFieldName("arguments") ?? node);
      const mode = args[1]?.text ?? "";
      if (WRITE_MODE.test(mode)) external = external ?? "filesystem";
      else durable = durable ?? "read";
      return;
    }
    if (FILE_WRITE_CALLS.has(name)) {
      external = external ?? "filesystem";
      return;
    }
    if (FILE_READ_CALLS.has(name)) durable = durable ?? "read";
  });
  return { ...(external === undefined ? {} : { external }), ...(durable === undefined ? {} : { durable }) };
};

/** One name a Python call site can use as a receiver, as the source declared it. */
interface ValueDecl {
  /** The annotation node, when the declaration carries one. */
  annotation: SyntaxNode | null;
  /** The initialising expression, when the declaration is an assignment. */
  init: SyntaxNode | null;
  /**
   * True when the name holds ONE ELEMENT of `init` rather than `init` itself - a
   * `for` target or a comprehension variable.
   *
   * It changes what "unresolvable" means at a call site. A collection the subject
   * declares an element type for is a set this phase does NOT close (#52, D3
   * rejects both type closure and value closure), so a call on one of its
   * elements is a named `unresolved_dispatch:` stop rather than a silence -
   * whereas iterating somebody else's list is foreign, and gapping on that would
   * report a hole in a story that has none.
   */
  element?: boolean;
  /**
   * True when the declaration is a PARAMETER rather than a local.
   *
   * `candidate.ts` reads this through `TraceEdge.heldReceiver`: a collaborator the
   * method is HANDED is part of the design, while one it builds is an
   * implementation detail of the caller.
   */
  parameter: boolean;
}

/**
 * The scopes a name nested inside a `def` belongs to something other than that
 * `def`.
 *
 * Python scoping is FUNCTION-wide rather than block-wide, so an `if` branch's
 * assignment is in scope for the whole function - which is why a `block` is
 * absent from this set although `trace.ts` lists it for Java. A nested `def`, a
 * `lambda` and a comprehension are their own scopes, and a name declared in one
 * must not type a receiver in a sibling one.
 */
const NESTED_SCOPE = new Set([
  "function_definition",
  "lambda",
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "generator_expression",
]);

const sameNode = (a: SyntaxNode, b: SyntaxNode): boolean =>
  a.type === b.type &&
  a.startPosition.row === b.startPosition.row &&
  a.startPosition.column === b.startPosition.column &&
  a.endPosition.row === b.endPosition.row &&
  a.endPosition.column === b.endPosition.column;

const declaringScope = (node: SyntaxNode, body: SyntaxNode): SyntaxNode => {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (sameNode(cur, body)) return body;
    if (NESTED_SCOPE.has(cur.type)) return cur;
  }
  return body;
};

const scopeContains = (scope: SyntaxNode, node: SyntaxNode): boolean => {
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
    if (sameNode(cur, scope)) return true;
  }
  return false;
};

interface ValueScope {
  at: (callSite: SyntaxNode) => Map<string, ValueDecl>;
  /** Every name bound anywhere in the body, in any scope. */
  boundNames: Set<string>;
}

/**
 * Every name a `def` body can use as a receiver, resolved per call site by the
 * scope it sits in: this function's parameters, and the names its body binds.
 *
 * Four binding forms, all of them declarations the gate can re-read in the same
 * file: an assignment (annotated or not), a `for` target, a `with ... as` target,
 * and an `except ... as` target. A name bound twice at two DIFFERENT declarations
 * is dropped rather than guessed, the same rule the attribute reconstruction and
 * Java's own field index use: an ambiguous receiver fails closed and is then
 * named at the call site rather than skipped.
 */
const valueScope = (definition: SyntaxNode, body: SyntaxNode): ValueScope => {
  const base = new Map<string, ValueDecl>();
  for (const param of parametersOf(definition)) {
    base.set(param.name, { annotation: param.annotation, init: null, parameter: true });
  }

  const bound: { name: string; decl: ValueDecl; scope: SyntaxNode }[] = [];
  const boundNames = new Set<string>();
  const remember = (name: string, decl: ValueDecl, node: SyntaxNode): void => {
    bound.push({ name, decl, scope: declaringScope(node, body) });
    boundNames.add(name);
  };
  walk(body, (node) => {
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      if (left?.type !== "identifier") return;
      remember(
        left.text,
        {
          annotation: node.childForFieldName("type"),
          init: node.childForFieldName("right"),
          parameter: false,
        },
        node,
      );
      return;
    }
    if (node.type === "for_statement" || node.type === "for_in_clause") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left?.type !== "identifier" || right === null) return;
      remember(left.text, { annotation: null, init: right, parameter: false, element: true }, node);
      return;
    }
    if (node.type === "for_in_clause") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left?.type === "identifier" && right !== null) {
        remember(left.text, { annotation: null, init: right, parameter: false, element: true }, node);
      }
      return;
    }
    if (node.type === "as_pattern") {
      const alias = namedChildren(node).find((child) => child.type === "as_pattern_target");
      const target = alias === undefined ? null : namedChildren(alias)[0] ?? null;
      const value = namedChildren(node)[0];
      if (target?.type !== "identifier" || value === undefined) return;
      remember(target.text, { annotation: null, init: value, parameter: false }, node);
    }
  });

  const at = (callSite: SyntaxNode): Map<string, ValueDecl> => {
    const names = new Map(base);
    const conflicting = new Set<string>();
    for (const entry of bound) {
      if (!scopeContains(entry.scope, callSite)) continue;
      const previous = names.get(entry.name);
      if (previous !== undefined && !sameDeclaration(previous, entry.decl)) conflicting.add(entry.name);
      names.set(entry.name, entry.decl);
    }
    for (const name of conflicting) names.delete(name);
    return names;
  };
  return { at, boundNames };
};

const sameDeclaration = (a: ValueDecl, b: ValueDecl): boolean =>
  (a.annotation?.text ?? null) === (b.annotation?.text ?? null) &&
  (a.init?.text ?? null) === (b.init?.text ?? null);

type Resolved =
  | {
      kind: "subject";
      type: TypeSymbol;
      /**
       * Set when this phase typed the receiver from something the GATE cannot
       * re-read in the calling file - a return type declared in another file, a
       * chained call whose inner callee is not a same-file `def`.
       *
       * The type is still used, because knowing it is what separates a foreign
       * value from a hole. It is not used to DRAW an arrow: the gate re-types a
       * receiver only from declarations in the file it is re-reading, so an edge
       * through one would turn a real chain into a confusing quarantine. Producer
       * and gate fail closed on the same line - the same arrangement `trace.ts`
       * uses for a Java `var`.
       */
      blind?: string;
    }
  /** A call through a keyed registry the file closes: a fan-out, not a stop. */
  | { kind: "dispatch"; registry: KeyedRegistry; subscript: SyntaxNode; blind?: string }
  | { kind: "foreign" }
  | { kind: "ambiguous"; name: string }
  /** A subject-owned receiver this phase declines to type. Named, never skipped. */
  | { kind: "unestablished"; kindToken: GapKind; why: string };

const FOREIGN: Resolved = { kind: "foreign" };

/** Literal and derived-value expressions: values, never subject receivers. */
const FOREIGN_EXPRESSION = new Set([
  "string",
  "concatenated_string",
  "integer",
  "float",
  "true",
  "false",
  "none",
  "list",
  "set",
  "tuple",
  "dictionary",
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "generator_expression",
  "binary_operator",
  "unary_operator",
  "boolean_operator",
  "comparison_operator",
  "not_operator",
  "lambda",
  "conditional_expression",
  "f_string",
]);

interface Frame {
  index: PythonIndex;
  /** The module or class the call site is written in. */
  type: TypeSymbol;
  method: MethodSymbol;
  /** The module pseudo-type of the calling FILE, which is never the class. */
  module: TypeSymbol;
  bindings: Map<string, Binding>;
  registries: Map<string, KeyedRegistry>;
}

/**
 * Types the subject uses to say it is NOT saying - a named gap, never silence.
 *
 * `Any` and `object` are annotations that decline to name a type, and the whole of
 * risk R2 is that they are contagious and subject-controlled: dsa's pipeline is
 * unreachable from every route because one function is annotated `-> Any`. Reading
 * them as foreign would hide that behind a silence; reading them as a named stop
 * says the true thing about the subject.
 */
const UNTYPED_ANNOTATIONS = new Set(["Any", "object"]);

/** A declared type NAME resolved against the calling file's own bindings. */
const namedType = (frame: Frame, name: string | null): Resolved => {
  if (name === null) return FOREIGN;
  if (UNTYPED_ANNOTATIONS.has(name)) {
    return {
      kind: "unestablished",
      kindToken: "unresolved_receiver_type",
      why: `the declaration types it \`${name}\`, which names no type this phase can follow`,
    };
  }
  const bound = frame.bindings.get(name);
  if (bound === undefined) {
    // A name this file binds nowhere states nothing. A same-file class is still
    // found, because a class declaration binds its own name.
    const local = classIn(frame.index, frame.type.path, name);
    return local === null ? FOREIGN : { kind: "subject", type: local };
  }
  if (bound.kind === "foreign") return FOREIGN;
  if (bound.kind === "ambiguous") return { kind: "ambiguous", name };
  if (bound.kind === "module") {
    const module = frame.index.modules.get(bound.path);
    return module === undefined ? FOREIGN : { kind: "subject", type: module };
  }
  const declared = classIn(frame.index, bound.path, bound.name);
  return declared === null ? FOREIGN : { kind: "subject", type: declared };
};

/**
 * The subject type an expression evaluates to, when one file establishes one.
 *
 * Every branch is a shape #52 report 4.2 measured as re-derivable within one
 * file; everything else is FOREIGN, which means "not traced" and never "traced
 * and empty". A subject-owned receiver this phase declines to type is
 * `unestablished` with its own kind token, so it is NAMED at the call site rather
 * than dropped in silence - a silently dropped branch could be a durable write,
 * and the gate re-resolves emitted claims, never omitted edges.
 */
const expressionType = (
  frame: Frame,
  values: Map<string, ValueDecl>,
  expr: SyntaxNode | null,
  depth = 0,
): Resolved => {
  if (expr === null) return FOREIGN;
  if (depth > 4) {
    return {
      kind: "unestablished",
      kindToken: "chained_call",
      why: "the receiver expression nests past the depth this phase reads",
    };
  }
  if (FOREIGN_EXPRESSION.has(expr.type)) return FOREIGN;
  if (expr.type === "parenthesized_expression" || expr.type === "await") {
    return expressionType(frame, values, namedChildren(expr)[0] ?? null, depth + 1);
  }
  if (expr.type === "identifier") {
    if (expr.text === "self" || expr.text === "cls") {
      // `self` inside a module-level `def` is an ordinary parameter name; inside a
      // method it is the declaring class, which is the whole of what makes
      // `self.m()` resolvable.
      return frame.type === frame.module ? FOREIGN : { kind: "subject", type: frame.type };
    }
    const value = values.get(expr.text);
    if (value !== undefined) {
      if (value.annotation !== null) return namedType(frame, annotationName(value.annotation));
      // One element of a collection whose element type the subject NAMES. v1
      // closes no set through such a collection (#52, D3), so this is a named
      // stop; a collection the subject names no element for stays whatever its
      // own expression resolves to, which is foreign for somebody else's list.
      // The element is read off the iterated NAME's annotation, exactly as Java's
      // `streamElementType` reads it off a field's declaration and stops when the
      // collection is rooted in a call instead.
      if (value.element === true && value.init?.type === "identifier") {
        const iterated = values.get(value.init.text);
        const element = annotationElement(iterated?.annotation ?? null);
        if (element !== null && namedType(frame, element).kind === "subject") {
          return {
            kind: "unestablished",
            kindToken: "unresolved_dispatch",
            why: `\`${expr.text}\` is one element of \`${value.init.text}\`, declared over ${element}, and no declaration closes that set`,
          };
        }
      }
      if (value.init === null) {
        return {
          kind: "unestablished",
          kindToken: "unresolved_receiver_type",
          why: `\`${expr.text}\` is declared with no annotation and no initialiser in this file`,
        };
      }
      return expressionType(frame, values, value.init, depth + 1);
    }
    // A module-level name of the calling FILE - `templates = Jinja2Templates(...)`,
    // `_PAYLOAD_TYPES: dict[...] = {...}` - is typed from the file's own
    // module-level declaration.
    const moduleField = frame.module.fields.get(expr.text);
    if (moduleField !== undefined) return namedType(frame, moduleField);
    return namedType(frame, expr.text);
  }
  if (expr.type === "attribute") {
    const attribute = expr.childForFieldName("attribute")?.text;
    const owner = expressionType(frame, values, expr.childForFieldName("object"), depth + 1);
    if (attribute === undefined || owner.kind !== "subject") {
      return owner.kind === "subject" ? FOREIGN : owner;
    }
    // A receiver held in ANOTHER type's attribute is where this phase stops, and
    // it stops on purpose: the gate re-types a receiver from the declarations in
    // the calling file, so tracing through `other.field` would propose an arrow
    // the gate cannot check and turn a real chain into a confusing quarantine.
    const inCallingScope =
      owner.type.path === frame.type.path &&
      (owner.type.qualified === frame.type.qualified || owner.type.qualified === frame.module.qualified);
    const declared = owner.type.fields.get(attribute);
    if (declared === undefined) {
      // A module's own attribute this file does not declare is somebody else's
      // (`np.nan`); a CLASS attribute nothing establishes is a hole in the story.
      if (owner.type === frame.module || owner.type.methods.some((m) => m.name === attribute)) {
        return FOREIGN;
      }
      return {
        kind: "unestablished",
        kindToken: "unresolved_receiver_type",
        why: `\`${expr.text}\` reads an attribute no declaration in ${owner.type.path} establishes`,
      };
    }
    if (!inCallingScope) {
      return {
        kind: "unestablished",
        kindToken: "unresolved_receiver_type",
        why: `the receiver is held in ${owner.type.name}.${attribute}, and this phase types a receiver only from the declarations in the calling file`,
      };
    }
    const read = namedType(frame, declared);
    return read.kind === "subject" && owner.blind !== undefined ? { ...read, blind: owner.blind } : read;
  }
  if (expr.type === "subscript") {
    const value = expr.childForFieldName("value");
    // The one closure rule (#52 D3): subscripting a keyed registry this file
    // declares as a literal yields one of a set the file closes.
    if (value?.type === "identifier") {
      const registry = frame.registries.get(value.text);
      if (registry !== undefined) return { kind: "dispatch", registry, subscript: expr };
    }
    const container = expressionType(frame, values, value, depth + 1);
    if (container.kind !== "subject") return container;
    return {
      kind: "unestablished",
      kindToken: "unresolved_dispatch",
      why: `the receiver is one element of ${expr.text.split("[")[0]}, a subject collection whose element this phase does not establish`,
    };
  }
  if (expr.type === "call") {
    const callee = expr.childForFieldName("function");
    if (callee?.type === "identifier") {
      const bound = frame.bindings.get(callee.text);
      // Constructing a subject class yields that class - the strongest and
      // simplest statement a Python expression makes about its own type.
      const constructed = bound === undefined
        ? classIn(frame.index, frame.type.path, callee.text)
        : bound.kind === "symbol"
          ? classIn(frame.index, bound.path, bound.name)
          : null;
      if (constructed !== null) return { kind: "subject", type: constructed };
      if (bound?.kind === "symbol") {
        // A same-file `def`'s RETURN ANNOTATION, propagated one step. Same file on
        // both sides, so the gate re-reads the same declaration.
        const owning = frame.index.modules.get(bound.path);
        const declared = owning === undefined ? null : methodNamed(owning, bound.name);
        if (declared === null) return FOREIGN;
        const returned = returnedType(frame, declared);
        if (returned.kind !== "subject") return returned;
        return bound.path === frame.type.path
          ? returned
          : {
              ...returned,
              blind: `the receiver is typed by a return annotation in ${bound.path}, and the gate re-types a receiver only from the declarations in the calling file`,
            };
      }
      return FOREIGN;
    }
    if (callee?.type === "attribute") {
      const name = callee.childForFieldName("attribute")?.text;
      const owner = expressionType(frame, values, callee.childForFieldName("object"), depth + 1);
      if (name === undefined || owner.kind !== "subject") {
        return owner.kind === "subject" ? FOREIGN : owner;
      }
      const found =
        owner.type === frame.index.modules.get(owner.type.path)
          ? (() => {
              const method = methodNamed(owner.type, name);
              return method === null ? null : { type: owner.type, method };
            })()
          : methodOnClass(frame.index, owner.type, name);
      if (found === null) {
        const constructed = classIn(frame.index, owner.type.path, name);
        if (constructed !== null) return { kind: "subject", type: constructed };
        return FOREIGN;
      }
      const returned = returnedType(frame, found.method);
      if (returned.kind !== "subject") return returned;
      const sameFile = found.type.path === frame.type.path;
      const blind =
        owner.blind ??
        (sameFile
          ? undefined
          : `the receiver is typed by a return annotation in ${found.type.path}, and the gate re-types a receiver only from the declarations in the calling file`);
      return blind === undefined ? returned : { ...returned, blind };
    }
    return FOREIGN;
  }
  return FOREIGN;
};

/**
 * The subject type a resolved call's RESULT evaluates to.
 *
 * The three non-types are the point (`declaredReturn` in `py-symbols.ts` records
 * them): a `def` that declares no return annotation, or declares one this reader
 * cannot reduce to a single type, hands back a value the subject declined to name -
 * so a receiver typed from it is a NAMED gap rather than a silence. An explicit
 * `-> None` is Python's `void` and is foreign, exactly as a Java `void` is.
 *
 * This is the asymmetry #52 report 5.1 points at on the reference subject:
 * `GET /runs/{}/report` traces clean while its sibling
 * `GET /runs/{}/report/{}` does not, because `_report_model_or_error` carries no
 * return annotation and `model.section(...)` is written on its result.
 */
const returnedType = (frame: Frame, method: MethodSymbol): Resolved => {
  if (method.returns === null) {
    return {
      kind: "unestablished",
      kindToken: "unresolved_receiver_type",
      why: `\`${method.name}\` in ${method.path} declares no return annotation, so the type of its result is not established`,
    };
  }
  if (method.returns === "None") return FOREIGN;
  if (method.returns === RETURN_UNREADABLE) {
    return {
      kind: "unestablished",
      kindToken: "unresolved_dispatch",
      why: `\`${method.name}\` in ${method.path} declares a return type naming more than one type, and no declaration closes that set`,
    };
  }
  return namedType(frame, method.returns);
};

const STATEMENT = /_statement$/;

/**
 * The whole statement a call sits in.
 *
 * The citation has to carry the COMPLETE call, because the gate re-reads the
 * receiver and the call together out of exactly this span.
 */
const citedRange = (call: SyntaxNode): SyntaxNode => {
  for (let cur: SyntaxNode | null = call; cur; cur = cur.parent) {
    if (STATEMENT.test(cur.type)) return cur;
  }
  return call;
};

const insideReturn = (call: SyntaxNode, body: SyntaxNode): boolean => {
  for (let cur: SyntaxNode | null = call; cur && !sameNode(cur, body); cur = cur.parent) {
    if (cur.type === "return_statement") return true;
  }
  return false;
};

/** Whether a call node is a decorator's own call rather than a step of a body. */
const isDecoratorCall = (call: SyntaxNode): boolean => {
  for (let cur: SyntaxNode | null = call; cur; cur = cur.parent) {
    if (cur.type === "decorator") return true;
    if (cur.type === "block" || cur.type === "function_definition") return false;
  }
  return false;
};

/** The total number of arguments a call writes, keyword arguments included. */
const argumentCount = (call: SyntaxNode): number => {
  const args = call.childForFieldName("arguments");
  if (!args) return 0;
  return namedChildren(args).filter((child) => child.type !== "comment").length;
};

/** The `def` node a projected MethodSymbol came from, or null. */
const definitionOf = (method: MethodSymbol): SyntaxNode | null => {
  const parent = method.body?.parent ?? null;
  return parent?.type === "function_definition" ? parent : null;
};

/**
 * A trace holding only its entry, for an adapter that has to emit a NAMED CUT.
 *
 * `absentCandidate` reports the entry it started from as evidence - that much IS
 * established - and no steps at all, so a refusal that never traced anything still
 * needs one landmark to name itself by. Without this an adapter would have to
 * choose between running a trace it has already decided not to trust and dropping
 * the refusal in silence, which is the one thing #6 forbids.
 */
export const soleLandmarkTrace = (type: TypeSymbol, method: MethodSymbol): TraceResult => {
  const key = methodKey(type, method);
  return {
    entry: key,
    landmarks: new Map([[key, { key, type, method }]]),
    edges: [],
    terminals: new Set(),
    gaps: [],
    cyclesCut: 0,
    cycleAt: new Set(),
  };
};

/**
 * Trace one Python entry to its terminals under the shared bounds.
 *
 * The traversal is whole-graph rather than single-path for the reason `trace.ts`
 * gives: a real handler writes a record AND returns a response, and drawing only
 * one of them would be a picture of a different program.
 */
export const pyTraceFrom = (
  index: PythonIndex,
  entryType: TypeSymbol,
  entryMethod: MethodSymbol,
): TraceResult => {
  const entry = methodKey(entryType, entryMethod);
  const landmarks = new Map<string, TraceLandmark>();
  const edges: TraceEdge[] = [];
  const terminals = new Set<string>();
  const gaps: TraceGap[] = [];
  const cycleAt = new Set<string>();
  let cyclesCut = 0;

  const gap = (kind: GapKind, at: string, detail: string): void => {
    if (!gaps.some((g) => g.kind === kind && g.at === at && g.detail === detail)) {
      gaps.push({ kind, at, detail });
    }
  };

  const landmarkOf = (type: TypeSymbol, method: MethodSymbol): TraceLandmark => {
    const outside = outsideEffectOf(method);
    const key = methodKey(type, method);
    // Leaving the program IS an ending, and so is reading or writing a durable
    // record. #35's terminal set names all three, and without this a method that
    // writes a file or reads the log is pruned as a helper that goes nowhere.
    if (outside.external !== undefined || outside.durable !== undefined) terminals.add(key);
    return {
      key,
      type,
      method,
      ...(outside.external === undefined ? {} : { externalEffect: outside.external }),
      ...(outside.durable === undefined ? {} : { dataAccess: { relation: outside.durable } }),
    };
  };

  landmarks.set(entry, landmarkOf(entryType, entryMethod));

  const visit = (type: TypeSymbol, method: MethodSymbol, stack: string[]): void => {
    const key = methodKey(type, method);
    if (stack.length > BOUNDS.maxPathEdges) {
      gap(
        "trace_bound_before_terminal",
        stack[stack.length - 1] ?? key,
        `the path through ${key} passes ${BOUNDS.maxPathEdges} call edges`,
      );
      return;
    }
    if (landmarks.size > BOUNDS.maxSymbols) {
      gap(
        "trace_bound_before_terminal",
        stack[stack.length - 1] ?? key,
        `the trace passed ${BOUNDS.maxSymbols} subject symbols before reaching a terminal`,
      );
      return;
    }
    const body = method.body;
    const definition = definitionOf(method);
    if (!body || !definition) return;
    const module = index.modules.get(method.path);
    const bindings = index.bindingsByPath.get(method.path);
    if (!module || !bindings) return;
    const frame: Frame = {
      index,
      type,
      method,
      module,
      bindings,
      registries: keyedRegistriesIn(index, method.path),
    };
    const scope = valueScope(definition, body);

    const calls: SyntaxNode[] = [];
    walk(body, (node) => {
      if (node.type === "call" && !isDecoratorCall(node)) calls.push(node);
    });

    for (const call of calls) {
      const callee = call.childForFieldName("function");
      if (!callee) continue;
      const values = scope.at(call);
      const range = citedRange(call);
      const arity = argumentCount(call);
      const edgeBase = {
        from: key,
        label: `${calleeLabel(callee)}(${arity === 0 ? "" : "..."})`,
        path: method.path,
        line_start: lineOf(range),
        line_end: endLineOf(range),
        inReturn: insideReturn(call, body),
        heldReceiver: false,
      };

      if (callee.type === "identifier") {
        const name = callee.text;
        // `cls(...)` in a classmethod and `self(...)` in a `__call__` name the
        // declaring class, so the call CONSTRUCTS it - a value, not a step, exactly
        // as `new X()` is for Java. It is checked before the callable-value branch
        // below because both are the first parameter of their method, and reading
        // `return cls(...)` as an unresolvable callable quarantined every story
        // through a `from_dict` classmethod on the reference subject.
        if ((name === "cls" || name === "self") && type !== module) continue;
        // A bare call on a name the body BINDS is a callable value - a `Callable`
        // alias, a handler a caller passed in. No implementation set exists to
        // close, so it is a stop rather than a fan-out (#52 report 4.4).
        if (values.has(name)) {
          gap(
            "unresolved_dispatch",
            key,
            `${key} calls \`${name}\`, a callable value this file binds rather than a function it declares`,
          );
          continue;
        }
        const bound = bindings.get(name);
        if (bound === undefined) continue;
        if (bound.kind === "ambiguous") {
          gap(
            "unresolved_target",
            key,
            `${key} calls ${name}, imported from ${bound.dotted}, which this subject declares in more than one place`,
          );
          continue;
        }
        if (bound.kind !== "symbol") continue;
        // Constructing a class is a value, not a step of the story - the same
        // reading `trace.ts` gives `new X()`.
        if (classIn(index, bound.path, bound.name) !== null) continue;
        const owning = index.modules.get(bound.path);
        const target = owning === undefined ? null : methodNamed(owning, name);
        if (owning === undefined) continue;
        if (target === null) {
          if (owning.methods.some((m) => m.name === name)) {
            gap(
              "ambiguous_overload",
              key,
              `${key} calls ${name}, which ${bound.path} declares more than once at module level`,
            );
            continue;
          }
          gap(
            "unresolved_target",
            key,
            `${key} calls ${name}, which ${bound.path} declares neither as a module-level def nor as a class`,
          );
          continue;
        }
        draw(owning, target, edgeBase, key, stack, undefined);
        continue;
      }

      if (callee.type !== "attribute") {
        // A call on a computed callee - `handlers[i](...)`, `(f or g)(...)`. The
        // target is chosen at run time and nothing declares it.
        gap(
          "runtime_registration",
          key,
          `${key} calls through \`${callee.text.split("\n")[0]}\`, a callee chosen at run time rather than declared`,
        );
        continue;
      }

      const name = callee.childForFieldName("attribute")?.text;
      const receiverNode = callee.childForFieldName("object");
      if (name === undefined) continue;
      const receiver = expressionType(frame, values, receiverNode);
      const root = receiverRoot(receiverNode);
      // A receiver reached through a chained call is one this phase can type but
      // the gate usually cannot: it re-types a receiver only from the named
      // declarations in the calling file. The single exception is a bare call to a
      // `def` this file declares, because the file states its return type.
      const chained = root?.type === "call" && !sameFileBareCall(bindings, root, method.path);
      const blindReason = chained
        ? `a chained call this phase types but the gate re-types a receiver only from the declarations in the calling file`
        : receiver.kind === "subject" || receiver.kind === "dispatch"
          ? receiver.blind
          : undefined;

      if (receiver.kind === "foreign") continue;
      if (receiver.kind === "ambiguous") {
        gap(
          "unresolved_target",
          key,
          `${key} calls ${name} on ${receiver.name}, a name this subject declares in more than one place`,
        );
        continue;
      }
      if (receiver.kind === "unestablished") {
        gap(receiver.kindToken, key, `${key} calls ${name} where ${receiver.why}`);
        continue;
      }
      const held =
        receiverNode?.type === "identifier"
          ? values.get(receiverNode.text)?.parameter === true
          : receiverNode?.type === "attribute" &&
            receiverNode.childForFieldName("object")?.text === "self";

      if (receiver.kind === "dispatch") {
        if (blindReason !== undefined) {
          gap(
            "unresolved_receiver_type",
            key,
            `${key} dispatches ${name} on a receiver where ${blindReason}`,
          );
          continue;
        }
        dispatchInto(
          receiver.registry,
          receiver.subscript,
          name,
          arity,
          { ...edgeBase, heldReceiver: held },
          key,
          stack,
          method.path,
        );
        continue;
      }

      const target = receiver.type;
      const isModule = index.modules.get(target.path) === target;
      const found = isModule
        ? (() => {
            const declared = methodNamed(target, name);
            return declared === null ? null : { type: target, method: declared };
          })()
        : methodOnClass(index, target, name);
      if (found === null) {
        // A class the module declares, named through the module: a construction.
        if (classIn(index, target.path, name) !== null) continue;
        // A method the class inherits from a base this FILE does not declare is
        // somebody else's behaviour, not this tree's to trace.
        if (!isModule && [...target.supertypes].some((base) => classIn(index, target.path, base) === null)) {
          continue;
        }
        // A module attribute rather than a function - `mod.CONSTANT.thing()` was
        // already resolved above, so what is left names nothing the file declares.
        if (isModule && target.fields.has(name)) continue;
        gap(
          "unresolved_target",
          key,
          `${key} calls ${target.name}.${name}, which no declaration in ${target.path} or its same-file bases provides`,
        );
        continue;
      }
      if (blindReason !== undefined) {
        gap(
          chained ? "chained_call" : "unresolved_receiver_type",
          key,
          `${key} calls ${name} on \`${receiverNode?.text.split("\n")[0] ?? "self"}\`, where ${blindReason}`,
        );
        continue;
      }
      draw(found.type, found.method, { ...edgeBase, heldReceiver: held }, key, stack, target);
    }
  };

  /**
   * One arrow into a resolved target, typed by what the target's own body does.
   *
   * A target whose body writes durable SQL is a `read`/`write` arrow rather than a
   * plain call, and the arrow CITES that body: the claim asserts the target reads
   * durably, and the SQL in its declaration is where that is written. A filesystem
   * boundary is not read this way - it names a path expression rather than a
   * record the arrow can name - so it marks the target's box as a terminal and
   * leaves the arrow an ordinary call.
   */
  const draw = (
    targetType: TypeSymbol,
    targetMethod: MethodSymbol,
    edgeBase: Omit<TraceEdge, "to" | "relation">,
    key: string,
    stack: string[],
    receiver: TypeSymbol | undefined,
  ): void => {
    const targetKey = methodKey(targetType, targetMethod);
    if (stack.includes(targetKey) || targetKey === key) {
      cyclesCut += 1;
      cycleAt.add(key);
      return;
    }
    const known = landmarks.has(targetKey);
    if (!known) landmarks.set(targetKey, landmarkOf(targetType, targetMethod));
    const landmark = landmarks.get(targetKey)!;
    const sql = targetMethod.body === null
      ? undefined
      : writesDurably(targetMethod.body.text)
        ? ("write" as const)
        : readsDurably(targetMethod.body.text)
          ? ("read" as const)
          : undefined;
    edges.push({
      ...edgeBase,
      to: targetKey,
      relation:
        sql !== undefined
          ? sql
          : landmark.externalEffect === undefined
            ? "call"
            : "side_effect",
      ...(sql === undefined
        ? {}
        : {
            cites: [
              {
                path: targetType.path,
                line_start: targetMethod.line_start,
                line_end: targetMethod.line_end,
              },
            ],
          }),
      ...(receiver !== undefined && receiver.qualified !== targetType.qualified
        ? { receiver }
        : {}),
    });
    if (!known) visit(targetType, targetMethod, [...stack, key]);
  };

  /**
   * One call through a keyed registry, fanned out into one arrow per member.
   *
   * A closed set of several members is a FAN-OUT of separately labelled and
   * separately evidenced arrows, never a chosen variant: the tree establishes that
   * the call reaches one of these and which key selects each, and it does not
   * establish which one a given execution takes. Each arrow cites the call site,
   * the subscript that selected the member, and the registry's own declaration -
   * the three spans the gate needs to re-enumerate the set.
   */
  const dispatchInto = (
    registry: KeyedRegistry,
    subscript: SyntaxNode,
    name: string,
    arity: number,
    edgeBase: Omit<TraceEdge, "to" | "relation">,
    key: string,
    stack: string[],
    fromPath: string,
  ): void => {
    const resolved = registry.members.map((member) => ({
      member,
      found: methodOnClass(index, member.type, name),
    }));
    const missing = resolved.find((entry) => entry.found === null);
    if (missing) {
      gap(
        "unresolved_dispatch",
        key,
        `${key} calls ${name} through the registry ${registry.name}, whose member ${missing.member.type.name} declares no ${name}`,
      );
      return;
    }
    const registryType = registryPseudoType(registry);
    const selection = citedRange(subscript);
    // Several keys may reach one target; that is ONE arrow carrying every label
    // that reaches it, not two arrows drawn on top of each other.
    const byTarget = new Map<
      string,
      { found: { type: TypeSymbol; method: MethodSymbol }; labels: string[] }
    >();
    for (const entry of resolved) {
      const targetKey = methodKey(entry.found!.type, entry.found!.method);
      const existing = byTarget.get(targetKey);
      if (existing) existing.labels.push(entry.member.label);
      else byTarget.set(targetKey, { found: entry.found!, labels: [entry.member.label] });
    }
    for (const [targetKey, { found, labels }] of byTarget) {
      if (stack.includes(targetKey) || targetKey === key) {
        cyclesCut += 1;
        cycleAt.add(key);
        continue;
      }
      const known = landmarks.has(targetKey);
      if (!known) landmarks.set(targetKey, landmarkOf(found.type, found.method));
      edges.push({
        ...edgeBase,
        to: targetKey,
        relation: "dispatch",
        label: `${name}(${arity === 0 ? "" : "..."}) via ${labels.join(" | ")}`,
        cites: [
          { path: fromPath, line_start: lineOf(selection), line_end: endLineOf(selection) },
        ],
        dispatch: {
          via: "keyed_registry",
          base: registryType,
          labels,
          memberCount: registry.members.length,
          guards: [registry.declaration],
        },
      });
      if (!known) visit(found.type, found.method, [...stack, key]);
    }
  };

  visit(entryType, entryMethod, []);

  // A leaf reached by a call inside a `return` statement is the value the caller
  // hands back: a terminal. A leaf reached any other way is a helper the story
  // does not end at, and `retained` prunes it rather than drawing it as an ending.
  const outgoing = new Set(edges.map((e) => e.from));
  for (const [key] of landmarks) {
    if (outgoing.has(key) || terminals.has(key)) continue;
    if (cycleAt.has(key)) continue;
    if (edges.some((e) => e.to === key && e.inReturn)) terminals.add(key);
  }

  return { entry, landmarks, edges, terminals, gaps, cyclesCut, cycleAt };
};

/**
 * Whether a chained receiver's inner call is a bare call to a `def` THIS FILE
 * declares - the one chained receiver the gate can re-resolve.
 *
 * The gate re-types a receiver from the declarations in the file it is re-reading,
 * and a same-file `def`'s return annotation is such a declaration. Every other
 * chained receiver is typed here from a declaration in some other file, which the
 * gate never reads, so it stays a named `chained_call:` limit - the same split
 * `trace.ts` draws around Java's one admissible `accessor(...).name(...)`.
 */
const sameFileBareCall = (
  bindings: Map<string, Binding>,
  call: SyntaxNode,
  path: string,
): boolean => {
  const callee = call.childForFieldName("function");
  if (callee?.type !== "identifier") return false;
  const bound = bindings.get(callee.text);
  return bound?.kind === "symbol" && bound.path === path;
};

const calleeLabel = (callee: SyntaxNode): string =>
  callee.type === "attribute" ? callee.childForFieldName("attribute")?.text ?? callee.text : callee.text;

/**
 * The registry's declaration, projected into the `TypeSymbol` shape a dispatch
 * arrow's `base` is carried in.
 *
 * `base` means "the declaration the set is closed BY" - in Java an interface, in
 * Python a module-level dict literal - and the two facts a claim needs from it are
 * its path and its name. Projecting it here keeps `DispatchFacts` one shape for
 * both languages, so the gate reads `dispatch.base` the same way whichever
 * producer filled it.
 */
const registryPseudoType = (registry: KeyedRegistry): TypeSymbol => ({
  name: registry.name,
  qualified: registry.name,
  path: registry.path,
  kind: "class",
  modifiers: [],
  supertypes: new Set<string>(),
  annotations: [],
  fields: new Map(),
  fieldsDeclared: new Map(),
  bean: false,
  methods: [],
  line_start: registry.declaration.line_start,
  header_line_end: registry.declaration.line_start,
  line_end: registry.declaration.line_end,
});
