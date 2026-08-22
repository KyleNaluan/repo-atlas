/**
 * The bounded typed trace: from one entry point to its terminals, or nothing.
 *
 * The scout measured both halves of this. A name-only call graph reached 245 of
 * the reference subject's 588 declared methods by depth eight - not recall, an
 * explosion. A conservative receiver-typed graph reached 22 symbols and stopped
 * at the interface a registry returns. This module is the second one, with the
 * stopping made explicit: a receiver it cannot type, an interface whose
 * implementation the phase cannot close, an overload it cannot pick, or a bound
 * reached before a terminal are all recorded as a GAP, and a gap on a retained
 * path means the whole candidate is proposed `absent`.
 *
 * That is the one rule that matters here. "A path that stops when resolution
 * becomes difficult" is explicitly not a Flow (#35, accepted design 1.4), so
 * this module never returns a shortened chain: it returns the complete traced
 * story or it returns why it could not.
 *
 * PR 5 closes one of those stops and only one: a dispatch through an interface
 * whose implementation set the subject's own Spring wiring closes (see
 * `dispatch.ts`). Every other interface call is still a named gap, `reachability`
 * still has no resolver, and the gate re-derives each closed set independently
 * from the blob. The producer and the gate agree about what this phase can prove,
 * and both fail closed on the rest.
 */
import { findAll, walk, type SyntaxNode } from "../java.js";
import { closedDispatch, type DispatchVia } from "./dispatch.js";
import {
  importedForeign,
  injectedElementType,
  simpleTypeName,
  uniqueType,
  type JavaIndex,
  type MethodSymbol,
  type TypeSymbol,
} from "./symbols.js";

/**
 * Mechanical safety limits, not rank budgets (#35, accepted design 5.4).
 *
 * The 200-symbol cap is grounded rather than guessed: the useful receiver-typed
 * submission trace on the reference subject holds 22 symbols, while the name-only
 * graph the design rejected passes 200 by depth seven. It catches an explosion
 * without clipping a real path.
 */
export const BOUNDS = {
  /** Subject-owned call edges on one raw path. */
  maxPathEdges: 16,
  /** Unique subject symbols explored per entry point. */
  maxSymbols: 200,
} as const;

/*
 * There is deliberately no third bound counting rendered boxes.
 *
 * PR 4 carried one, at eight, and PR 5 removes it. The two bounds above are
 * mechanical explosion guards - they stop a walk, and the numbers are measured
 * rather than chosen. A budget expressed in RENDERED BOXES is not that: it is a
 * readability judgement, and this project puts readability judgements in the
 * renderer (which already warns above eight steps, #7) and selection in rank
 * (#9, and the Flow budget of two from #39). A producer that deleted a fully
 * verified story because the figure would be large would be exactly the second
 * authority over what survives that "mechanics propose, judgement deletes"
 * forbids - and on the reference subject it deleted the one story #35 exists to
 * recover, a 23-box submission walkthrough in which every arrow independently
 * re-resolves. Compressing or splitting such a figure is real work and it is
 * PR 6's; refusing to emit it was never the honest way to defer that work.
 */

export type GapKind =
  | "unresolved_dispatch"
  | "unresolved_receiver_type"
  | "unresolved_target"
  | "ambiguous_overload"
  | "unprovable_data_access"
  | "trace_bound_before_terminal";

export interface TraceGap {
  kind: GapKind;
  /** The landmark whose body could not be fully resolved. */
  at: string;
  detail: string;
}

/** One traced method: a box in the rendered graph. */
export interface TraceLandmark {
  key: string;
  type: TypeSymbol;
  method: MethodSymbol;
  /** A repository read/write target; it is a terminal and is never traced onward. */
  dataAccess?: { relation: "read" | "write" };
  /**
   * The method leaves the process: it starts one, or writes the filesystem.
   *
   * The arrow into such a method is a `side_effect` rather than a plain call, and
   * its box is an `aside`. That is the difference the reference artifact draws
   * between the graded path and the best-effort commit beside it, and here it is
   * read off the callee's own body rather than assumed from its name.
   */
  externalEffect?: "process" | "filesystem";
  /** The method, or its declaring type, is declared transactional. */
  transactional?: boolean;
}

/**
 * What the tree established about one arrow, when the arrow is a dispatch.
 *
 * It travels with the edge because the gate re-derives the whole set rather than
 * the single target: proving `TestCaseGrader.grade` exists says nothing about
 * whether it is the ONLY thing the call can reach, and that is the claim a
 * dispatch arrow makes.
 */
export interface DispatchFacts {
  via: DispatchVia;
  /** The declared type the call is written through. */
  base: TypeSymbol;
  /** How the tree names this branch: an implementation, a permitted type, a key. */
  labels: string[];
  /** How many implementations the closed set holds. */
  memberCount: number;
  /** The declarations that establish these branches - a guard body, a header. */
  guards: { path: string; line_start: number; line_end: number }[];
}

export interface TraceEdge {
  from: string;
  to: string;
  relation: "call" | "read" | "write" | "return" | "dispatch" | "side_effect";
  /** The call this arrow is, as the source wrote it. */
  label: string;
  path: string;
  line_start: number;
  line_end: number;
  /** Set when the call site sits inside a `return` statement of the calling method. */
  inReturn: boolean;
  /** Present exactly when `relation` is `dispatch`. */
  dispatch?: DispatchFacts;
  /**
   * The type the call was written on, when the declaration lives on a supertype
   * or an enclosing type of it. The gate re-derives that relation itself.
   */
  receiver?: TypeSymbol;
  /**
   * Whether the call went through a member the calling type HOLDS - a field, or a
   * constructor-injected dependency.
   *
   * This is the difference between a collaborator and a helper, and it is the
   * subject's own wiring that states it: a type the caller is handed is a part of
   * the design, while one it constructs or calls statically is an implementation
   * detail of the caller. The rendered figure draws the first as its own box and
   * folds the second into the box that uses it.
   */
  heldReceiver: boolean;
}

export interface TraceResult {
  entry: string;
  landmarks: Map<string, TraceLandmark>;
  edges: TraceEdge[];
  terminals: Set<string>;
  gaps: TraceGap[];
  /** Cycles cut rather than followed, kept so a no-terminal trace can say why. */
  cyclesCut: number;
  /** Landmarks whose body called back into the path; they are not leaves. */
  cycleAt: Set<string>;
}

const REPOSITORY_NAMED = /(?:Repository|Dao|DAO)$/;
const READ_METHOD = /^(?:find|get|read|load|select|exists|count|query|fetch|lookup|search)/i;
const WRITE_METHOD = /^(?:save|write|insert|update|delete|remove|persist|store|upsert|merge)/i;

export const methodKey = (type: TypeSymbol, method: MethodSymbol): string =>
  `${type.path}#${type.qualified}.${method.name}/${method.params.length}`;

/**
 * A durable-storage boundary: the subject's own repository type, however it is
 * written.
 *
 * Both spellings matter and the reference subject carries both. A Spring Data
 * interface has no implementation to dispatch to in the subject at all - the
 * framework generates one - so its declared methods are a data boundary rather
 * than a polymorphic call. A hand-written JDBC repository class is a boundary
 * for the opposite reason: its body is SQL plumbing rather than an architectural
 * landmark, and a story that traced into it would draw statement builders beside
 * services. Either way the arrow into it is the persistence step, and stopping
 * there is what "terminal" means.
 *
 * A Spring Data interface's INHERITED methods (`save`, `findById`) are excluded
 * at the call site below rather than here: nothing in the tree declares them, so
 * nothing in the tree can establish the arrow, and this phase proposes only what
 * the gate can independently resolve.
 */
export const isRepositoryType = (type: TypeSymbol): boolean =>
  REPOSITORY_NAMED.test(type.name) ||
  type.annotations.some((a) => a.name === "Repository") ||
  (type.kind === "interface" && [...type.supertypes].some((s) => REPOSITORY_NAMED.test(s)));

/**
 * Whether a method body leaves the process: it builds a subprocess, or writes a
 * file.
 *
 * Read from the body rather than from the name, because "commit" and "run" say
 * nothing on their own. `ProcessBuilder`, `Runtime.exec` and the writing half of
 * `java.nio.file.Files` are the three spellings that actually cross the boundary.
 */
const FILE_WRITE = /^(?:write|writeString|createFile|createDirector(?:y|ies)|copy|move|delete|deleteIfExists|newOutputStream|newBufferedWriter)$/;

const externalEffectOf = (method: MethodSymbol): "process" | "filesystem" | undefined => {
  if (!method.body) return undefined;
  let effect: "process" | "filesystem" | undefined;
  walk(method.body, (node) => {
    if (effect === "process") return;
    if (node.type === "object_creation_expression" && node.childForFieldName("type")?.text === "ProcessBuilder") {
      effect = "process";
      return;
    }
    if (node.type !== "method_invocation") return;
    const name = node.childForFieldName("name")?.text ?? "";
    const receiver = node.childForFieldName("object")?.text ?? "";
    if (name === "exec" && receiver.includes("Runtime")) effect = "process";
    else if (receiver === "Files" && FILE_WRITE.test(name) && effect === undefined) effect = "filesystem";
  });
  return effect;
};

/** Spring's own declaration that a method runs inside a database transaction. */
const isTransactional = (type: TypeSymbol, method: MethodSymbol): boolean =>
  method.annotations.some((a) => a.name === "Transactional") ||
  type.annotations.some((a) => a.name === "Transactional");

const argumentCount = (invocation: SyntaxNode): number =>
  invocation.childForFieldName("arguments")?.namedChildCount ?? 0;

const STATEMENT = /_statement$|^local_variable_declaration$/;

/**
 * The whole statement a call sits in.
 *
 * The citation has to carry the COMPLETE call, parentheses included: the gate
 * counts the arguments inside the cited span to tell two overloads apart, and a
 * span that ends mid-call would leave it unable to resolve an arrow that is
 * genuinely there.
 */
const citedRange = (invocation: SyntaxNode): SyntaxNode => {
  for (let cur: SyntaxNode | null = invocation; cur; cur = cur.parent) {
    if (STATEMENT.test(cur.type)) return cur;
  }
  return invocation;
};

const insideReturn = (invocation: SyntaxNode, body: SyntaxNode): boolean => {
  for (let cur: SyntaxNode | null = invocation; cur && cur !== body; cur = cur.parent) {
    if (cur.type === "return_statement") return true;
  }
  return false;
};

/**
 * Whether a call's receiver is itself a chained method result (`x().y()`).
 *
 * This phase can type such a receiver, but the gate cannot re-resolve it: the
 * gate types a receiver only from the named declarations in the calling file, so
 * a call whose receiver is a chained result is one it can never confirm. Naming
 * it lets the call site fail closed on the same line the gate would - the
 * alternative is a real chain returning as a confusing quarantine, or the
 * chain's untypeable accessor otherwise dropping the branch in silence.
 */
const throughChainedCall = (node: SyntaxNode | null): boolean => {
  let cur = node;
  while (cur && cur.type === "parenthesized_expression") cur = cur.namedChild(0);
  return cur?.type === "method_invocation";
};

/**
 * Whether a chained receiver is an accessor DECLARED IN THE CALLING TYPE and
 * called with no receiver of its own: `graderFor(exercise).grade(...)`.
 *
 * This is the one chained receiver the gate can re-resolve independently. It
 * re-types receivers from the declarations in the calling file, and this file
 * declares the accessor's return type; the gate looks for exactly that name and
 * that return type. Every other chained receiver is typed here from a
 * declaration in some other file, which the gate never reads, so it stays a
 * named limit.
 */
const localAccessor = (type: TypeSymbol, node: SyntaxNode | null): boolean => {
  let cur = node;
  while (cur && cur.type === "parenthesized_expression") cur = cur.namedChild(0);
  if (cur?.type !== "method_invocation" || cur.childForFieldName("object") !== null) return false;
  const name = cur.childForFieldName("name")?.text;
  return name !== undefined && type.methods.some((m) => m.name === name && m.returns !== null);
};

/**
 * The leaf a receiver chain is rooted in: the innermost object of nested calls,
 * field reads and parentheses.
 *
 * Used only to tell a depth-bounded subject chain (name it) from a depth-bounded
 * library chain (leave it silent, since gapping a call on someone else's library
 * is exactly what this phase must not do). The root leaf is one or two levels
 * deep, so typing it never re-approaches the recursion bound.
 */
const chainRoot = (node: SyntaxNode | null): SyntaxNode | null => {
  let cur = node;
  while (cur) {
    if (cur.type === "parenthesized_expression") {
      cur = cur.namedChild(0);
      continue;
    }
    if (cur.type === "method_invocation" || cur.type === "field_access") {
      const object = cur.childForFieldName("object");
      if (object === null) return cur;
      cur = object;
      continue;
    }
    return cur;
  }
  return null;
};

/**
 * The scopes a local nested inside a method body belongs to something other than
 * the method: a lambda's or anonymous/local class's own body, a nested statement
 * block - not the method's.
 *
 * `block` is Java's own rule and it matters on real code: a `switch` whose arms
 * each declare `value` at a different type declares four different locals, and
 * treating them as one redeclaration drops the name as ambiguous and then names
 * a gap in a method that has none.
 */
const NESTED_SCOPE = new Set(["lambda_expression", "class_body", "block"]);

/**
 * Node identity by source span. `web-tree-sitter` hands back a fresh wrapper
 * object for every `.parent` access, so `===` between two wrappers for the same
 * node is false; a span comparison is the stable identity these walks need.
 */
const sameNode = (a: SyntaxNode, b: SyntaxNode): boolean =>
  a.type === b.type &&
  a.startPosition.row === b.startPosition.row &&
  a.startPosition.column === b.startPosition.column &&
  a.endPosition.row === b.endPosition.row &&
  a.endPosition.column === b.endPosition.column;

/**
 * The scope a local belongs to: the nearest enclosing lambda, anonymous- or
 * local-class body, or the method body itself.
 *
 * Method-wide within one scope is deliberate - a name declared in one `if` branch
 * is still in scope for the whole method here - but a local declared inside a
 * lambda is a different scope's declaration: visible inside that lambda and not a
 * sibling one, and not the method body around it.
 */
const declaringScope = (local: SyntaxNode, body: SyntaxNode): SyntaxNode => {
  for (let cur = local.parent; cur; cur = cur.parent) {
    if (sameNode(cur, body)) return body;
    if (NESTED_SCOPE.has(cur.type)) return cur;
  }
  return body;
};

/** Whether `scope` encloses `node`, or is `node` itself. */
const scopeContains = (scope: SyntaxNode, node: SyntaxNode): boolean => {
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
    if (sameNode(cur, scope)) return true;
  }
  return false;
};

/** One name a call site can use as a receiver, as the source declared it. */
export interface ReceiverDecl {
  /** The type EXACTLY as written, generics kept - `var` included, unresolved. */
  declared: string;
  /** A local's initialiser, which is the only thing that types a `var`. */
  init: SyntaxNode | null;
}

interface ReceiverScope {
  /** The receivers in scope at one call site: fields, parameters, in-scope locals. */
  at: (callSite: SyntaxNode) => Map<string, ReceiverDecl>;
  /** Every name declared as a local anywhere in the body, in any scope. */
  localNames: Set<string>;
}

/**
 * Every name a method body can use as a receiver, resolved per call site by its
 * scope chain: the enclosing type's fields, this method's parameters, and the
 * locals whose declaring scope encloses that site.
 *
 * The scope check is load-bearing in both directions. `walk` visits invocations
 * inside lambda and anonymous-class bodies flatly, so a local declared in one
 * lambda must not type a receiver in a sibling lambda or in the method body - a
 * declaration the calling scope does not actually have; the gate re-types
 * receivers by scanning the whole file and would confirm the same wrong
 * attribution rather than catch it, so the scope check lives here, one of the few
 * places producer and gate can agree and both be wrong. The other way, a
 * lambda-local resolved at a site its own lambda encloses is gate-compatible:
 * the gate's `typedReceivers` finds the same declaration in the file, so typing
 * it reopens no divergence - the alternative is a durable write inside a lambda
 * dropping in silence.
 *
 * A name declared twice with different types in one scope chain is dropped rather
 * than guessed, the same rule the field index uses: an ambiguous receiver fails
 * closed and is then named at the call site rather than skipped.
 */
const receiverScope = (type: TypeSymbol, method: MethodSymbol): ReceiverScope => {
  const base = new Map<string, ReceiverDecl>();
  for (const [name, declared] of type.fieldsDeclared) base.set(name, { declared, init: null });
  const baseConflict = new Set<string>();
  const remember = (
    names: Map<string, ReceiverDecl>,
    conflicting: Set<string>,
    name: string,
    decl: ReceiverDecl,
  ): void => {
    const previous = names.get(name);
    if (previous !== undefined && previous.declared !== decl.declared) conflicting.add(name);
    names.set(name, decl);
  };
  for (const param of method.params) {
    if (param.name) remember(base, baseConflict, param.name, { declared: param.declared, init: null });
  }

  const locals: { name: string; decl: ReceiverDecl; scope: SyntaxNode }[] = [];
  const localNames = new Set<string>();
  if (method.body) {
    for (const local of findAll(method.body, "local_variable_declaration")) {
      const declared = local.childForFieldName("type")?.text;
      if (!declared) continue;
      const scope = declaringScope(local, method.body);
      // Direct declarators only: a local declared inside a lambda in this local's
      // initialiser is its own declaration, reached by the outer loop with its own
      // scope, and must not be attributed to this one.
      for (let i = 0; i < local.namedChildCount; i += 1) {
        const declarator = local.namedChild(i);
        if (declarator?.type !== "variable_declarator") continue;
        const name = declarator.childForFieldName("name")?.text;
        if (!name) continue;
        locals.push({
          name,
          decl: { declared, init: declarator.childForFieldName("value") },
          scope,
        });
        localNames.add(name);
      }
    }
  }

  const at = (callSite: SyntaxNode): Map<string, ReceiverDecl> => {
    const names = new Map(base);
    const conflicting = new Set(baseConflict);
    for (const local of locals) {
      if (!scopeContains(local.scope, callSite)) continue;
      remember(names, conflicting, local.name, local.decl);
    }
    for (const name of conflicting) names.delete(name);
    return names;
  };
  return { at, localNames };
};

/**
 * The parameter names a lambda introduces in one method body, and the subject
 * type the tree establishes for each - which is usually none.
 *
 * A lambda parameter's type comes from whichever functional interface the call
 * site expects, and this phase does not resolve those. One shape is different and
 * it is the shape Spring collection injection produces: a stream over a field
 * declared `List<Grader>` binds its parameter to `Grader`, because the element
 * type is written in the declaration. That is the same wiring `dispatch.ts`
 * reads, and it is what lets a `supports()`-guarded registry resolve at all.
 *
 * Everything else is collected WITHOUT a type, so that a call ON one is recorded
 * as an unresolved receiver rather than passed over as foreign: "I could not type
 * this" and "this is somebody else's library" must not look the same, which is
 * the same rule that makes an inapplicable probe say so by name.
 */
const lambdaParameters = (
  index: JavaIndex,
  body: SyntaxNode,
  receivers: (callSite: SyntaxNode) => Map<string, ReceiverDecl>,
): Map<string, TypeSymbol | null> => {
  const names = new Map<string, TypeSymbol | null>();
  for (const lambda of findAll(body, "lambda_expression")) {
    const params = lambda.childForFieldName("parameters");
    if (!params) continue;
    const declared: string[] = [];
    if (params.type === "identifier") declared.push(params.text);
    else walk(params, (n) => {
      if (n.type === "identifier") declared.push(n.text);
    });
    // Only a single-parameter lambda is typed from a collection: a two-parameter
    // one is a comparator or a reducer, where the element type is not the whole
    // story and guessing which parameter it belongs to would be inference.
    const element = declared.length === 1 ? streamElementType(index, lambda, receivers) : null;
    for (const name of declared) {
      names.set(name, names.has(name) && names.get(name) !== element ? null : element);
    }
  }
  return names;
};

/**
 * The lambda parameters whose stream is rooted in a name the SUBJECT declares.
 *
 * This is what separates "I could not type an element of your collection" from
 * "this iterates somebody else's library". Only the first is a hole in the
 * subject's story, and only the first is named.
 */
const subjectRootedLambdaParameters = (
  index: JavaIndex,
  type: TypeSymbol,
  method: MethodSymbol,
  body: SyntaxNode,
  receivers: (callSite: SyntaxNode) => Map<string, ReceiverDecl>,
): Set<string> => {
  const names = new Set<string>();
  for (const lambda of findAll(body, "lambda_expression")) {
    let call: SyntaxNode | null = lambda.parent;
    while (call && call.type !== "method_invocation") call = call.parent;
    const root = call ? chainRoot(call.childForFieldName("object")) : null;
    if (root === null) continue;
    const rooted = expressionType(index, type, method, receivers(lambda), root);
    if (rooted.kind === "subject") continue;
    const declared = root.type === "identifier" ? receivers(lambda).get(root.text)?.declared : undefined;
    const element = declared === undefined ? null : injectedElementType(declared);
    if (element === null || uniqueType(index, element, type.path) === null) continue;
    const params = lambda.childForFieldName("parameters");
    if (!params) continue;
    if (params.type === "identifier") names.add(params.text);
    else walk(params, (n) => {
      if (n.type === "identifier") names.add(n.text);
    });
  }
  return names;
};

/**
 * The element type of the collection a lambda is applied over, when a field or
 * local declares it.
 *
 * Walks out to the invocation the lambda is an argument of, back down that call's
 * receiver chain to its root name, and reads the element type off that name's
 * DECLARATION. Nothing is inferred through the stream operators themselves: a
 * `map` changes the element type and this deliberately does not follow it, so
 * only a chain whose root declaration still describes the element resolves.
 */
const streamElementType = (
  index: JavaIndex,
  lambda: SyntaxNode,
  receivers: (callSite: SyntaxNode) => Map<string, ReceiverDecl>,
): TypeSymbol | null => {
  let call: SyntaxNode | null = lambda.parent;
  while (call && call.type !== "method_invocation") call = call.parent;
  if (!call) return null;
  const root = chainRoot(call.childForFieldName("object"));
  if (root?.type !== "identifier") return null;
  const declared = receivers(lambda).get(root.text)?.declared;
  if (declared === undefined) return null;
  const element = injectedElementType(declared);
  return element === null ? null : uniqueType(index, element);
};

type Resolved =
  | {
      kind: "subject";
      type: TypeSymbol;
      /**
       * Set when this phase typed the receiver from something the GATE cannot
       * re-read in the calling file - a `var` local's initialiser, so far.
       *
       * The type is still used, because knowing it is what tells an implicit
       * accessor from a hole. It is not used to DRAW an arrow: the gate re-types a
       * receiver from the declarations in the calling file, and `var` declares
       * none, so an edge through one would be a real chain returning as a
       * confusing quarantine. Producer and gate fail closed on the same line.
       */
      blind?: string;
    }
  | { kind: "foreign" }
  | { kind: "ambiguous"; name: string }
  /** A subject-owned receiver this phase declines to type. Named, never skipped. */
  | { kind: "unestablished"; why: string }
  /**
   * The recursion depth bound stopped before this expression's root could be
   * typed. Distinct from `foreign` because a receiver we could not reach and a
   * library call must not look the same: the call site re-checks the chain's root
   * to tell a depth-bounded subject chain (named) from a library one (silent).
   */
  | { kind: "depth_exceeded" };

const FOREIGN: Resolved = { kind: "foreign" };
const DEPTH_EXCEEDED: Resolved = { kind: "depth_exceeded" };

/**
 * The subject type an expression evaluates to, when the tree establishes one.
 *
 * Handles exactly the receivers the design names as mechanically resolvable:
 * bare and `this` calls inside the enclosing type, fields (including
 * constructor-injected ones), locals, parameters, a named type for a static
 * call, `new X()`, and a chained call whose accessor - declared on the receiver's
 * type or an owned supertype - returns a subject type. A chained accessor rooted
 * in a subject type but untypeable (ambiguous overload, or no reachable
 * declaration) is `unestablished`, named rather than skipped. Anything else is
 * foreign, which means "not traced", never "traced and empty".
 */
const expressionType = (
  index: JavaIndex,
  type: TypeSymbol,
  method: MethodSymbol,
  receivers: Map<string, ReceiverDecl>,
  expr: SyntaxNode | null,
  depth = 0,
): Resolved => {
  if (expr === null) return { kind: "subject", type };
  if (depth > 4) return DEPTH_EXCEEDED;
  if (expr.type === "this") return { kind: "subject", type };
  if (expr.type === "identifier") {
    const decl = receivers.get(expr.text);
    if (decl !== undefined) {
      if (simpleTypeName(decl.declared) !== "var") return named(index, decl.declared, type.path);
      // `var` names no type at all: what it holds comes from the initialiser, which
      // this phase reads and the gate cannot. Typing it is what separates an
      // implicit record accessor from a genuine hole; the `blind` mark is what
      // stops the type being used to draw an arrow the gate could not re-resolve.
      if (decl.init === null) {
        return {
          kind: "unestablished",
          why: "the receiver is a `var` local with no initialiser in this declaration",
        };
      }
      const inferred = expressionType(index, type, method, receivers, decl.init, depth + 1);
      return inferred.kind === "subject"
        ? { ...inferred, blind: `the receiver is a \`var\` local, whose type no declaration in the calling file states` }
        : inferred;
    }
    // Not a value in scope: a type name is a static call, anything else foreign.
    return named(index, expr.text, type.path);
  }
  if (expr.type === "field_access") {
    // `x.field`, `this.field`, `Type.CONSTANT`: resolve what it is read FROM,
    // then read the field's declared type off that type. A field whose owner
    // this phase cannot type is foreign, never guessed by name.
    const field = expr.childForFieldName("field")?.text;
    const owner = expressionType(
      index,
      type,
      method,
      receivers,
      expr.childForFieldName("object"),
      depth + 1,
    );
    if (field === undefined || owner.kind !== "subject") return owner.kind === "foreign" ? FOREIGN : owner;
    const declared = owner.type.fieldsDeclared.get(field);
    if (declared === undefined) return FOREIGN;
    // A field held by ANOTHER type is where this phase stops, and it stops on
    // purpose. The gate re-resolves a receiver from the declarations in the
    // calling file, so a producer that traced through `Other.FIELD` would
    // propose an arrow the gate cannot check and turn a real chain into a
    // confusing quarantine. Producer and gate fail closed on the same line.
    if (owner.type.qualified !== type.qualified || owner.type.path !== type.path) {
      return {
        kind: "unestablished",
        why: `the receiver is held in ${owner.type.name}.${field}, and this phase types a receiver only from the declarations in the calling file`,
      };
    }
    const read = named(index, declared, owner.type.path);
    return read.kind === "subject" && owner.blind !== undefined ? { ...read, blind: owner.blind } : read;
  }
  if (expr.type === "object_creation_expression") {
    const created = expr.childForFieldName("type")?.text;
    return created === undefined ? FOREIGN : named(index, created, type.path);
  }
  if (expr.type === "method_invocation") {
    const owner = expressionType(
      index,
      type,
      method,
      receivers,
      expr.childForFieldName("object"),
      depth + 1,
    );
    if (owner.kind !== "subject") return owner;
    const name = expr.childForFieldName("name")?.text;
    if (name === undefined) return FOREIGN;
    // A chained receiver rooted in a subject type is typed exactly as a direct
    // call to its accessor would be - following subject-owned supertypes, so an
    // inherited accessor resolves the same as a declared one. A receiver this
    // phase cannot type from here is NAMED (unestablished), not skipped as
    // FOREIGN: FOREIGN means "somebody else's library" and skips silently, but a
    // silently dropped subject branch could be a durable write, and the gate
    // re-resolves emitted claims, never omitted edges. A genuinely foreign
    // return type stays FOREIGN below and its calls are untraced, unchanged.
    const args = Array.from(
      { length: argumentCount(expr) },
      (_, i) => expr.childForFieldName("arguments")!.namedChild(i)!,
    ).filter((n): n is SyntaxNode => n !== null);
    const accessor = declaredMethod(index, owner.type, name, args, (arg) =>
      expressionType(index, type, method, receivers, arg, depth + 1),
    );
    if (accessor.kind === "ambiguous") {
      return {
        kind: "unestablished",
        why: `the chained call to ${owner.type.name}.${name} has more than one declared overload taking ${args.length} arguments, so its return type is not established`,
      };
    }
    if (accessor.kind === "missing") {
      // Declared by the language (Object/enum/record accessor) or inherited from
      // a supertype the subject does not own: a genuinely foreign value, so its
      // calls are not this tree's behaviour to trace.
      if (implicitlyDeclared(owner.type, name, args.length) || hasForeignSupertype(index, owner.type)) {
        return FOREIGN;
      }
      return {
        kind: "unestablished",
        why: `the chained call to ${owner.type.name}.${name} resolves to no declaration in ${owner.type.path} or its subject supertypes`,
      };
    }
    const returns = accessor.method.returns;
    if (returns === null) return FOREIGN;
    const resolved = named(index, returns, owner.type.path);
    return resolved.kind === "subject" && owner.blind !== undefined
      ? { ...resolved, blind: owner.blind }
      : resolved;
  }
  if (expr.type === "parenthesized_expression") {
    return expressionType(index, type, method, receivers, expr.namedChild(0), depth + 1);
  }
  return FOREIGN;
};

/**
 * A declared type name resolved against the subject index, read as the file that
 * wrote it would read it.
 *
 * `fromPath` is what makes this a resolution rather than a name collision: a
 * simple name means whatever the calling file's imports and package say it
 * means, and a subject type must not shadow a library type that happens to share
 * its simple name.
 */
const named = (index: JavaIndex, declared: string, fromPath: string): Resolved => {
  const simple = simpleTypeName(declared);
  // `var` names no type at all. It is typed from its initialiser at the identifier
  // branch above; reaching here means a declaration that carries none.
  if (simple === "var") {
    return { kind: "unestablished", why: "the receiver is a `var` local whose initialiser this phase does not read" };
  }
  const resolved = uniqueType(index, declared, fromPath);
  if (resolved !== null) return { kind: "subject", type: resolved };
  if (importedForeign(index, fromPath, declared)) return FOREIGN;
  const found = index.bySimpleName.get(simple) ?? [];
  if (found.length > 1) return { kind: "ambiguous", name: simple };
  return FOREIGN;
};

/**
 * Which declared method a call resolves to within one subject type, following
 * subject-owned supertypes.
 *
 * Arity picks between overloads first, because that is what the tree states
 * without inference. Where two overloads share an arity, the argument types are
 * resolved and must select exactly one - an unresolvable pick is a gap, never a
 * guess, and the gate's own re-resolution matches on name and arity, so a
 * producer that guessed here would be confirmed by a check that could not tell
 * the two apart.
 */
const declaredMethod = (
  index: JavaIndex,
  type: TypeSymbol,
  name: string,
  args: SyntaxNode[],
  argTypes: (arg: SyntaxNode) => Resolved,
  seen = new Set<string>(),
):
  | { kind: "found"; type: TypeSymbol; method: MethodSymbol }
  | { kind: "ambiguous" }
  | { kind: "missing" } => {
  if (seen.has(type.qualified + type.path)) return { kind: "missing" };
  seen.add(type.qualified + type.path);
  const byArity = type.methods.filter((m) => m.name === name && m.params.length === args.length);
  if (byArity.length === 1) return { kind: "found", type, method: byArity[0]! };
  if (byArity.length > 1) {
    const matching = byArity.filter((candidate) =>
      candidate.params.every((param, i) => {
        const arg = args[i];
        if (arg === undefined) return false;
        const resolved = argTypes(arg);
        return resolved.kind === "subject" && resolved.type.name === param.type;
      }),
    );
    return matching.length === 1
      ? { kind: "found", type, method: matching[0]! }
      : { kind: "ambiguous" };
  }
  for (const supertype of type.supertypes) {
    const parent = uniqueType(index, supertype, type.path);
    if (!parent) continue;
    const found = declaredMethod(index, parent, name, args, argTypes, seen);
    if (found.kind !== "missing") return found;
  }
  return { kind: "missing" };
};

/**
 * Members Java itself declares on a type, which no source line in the subject
 * spells out.
 *
 * `Object`'s methods are on every type, a record's components are accessors, and
 * an enum carries `values`/`valueOf`/`name`/`ordinal`. A call to one of these is
 * RESOLVED - the declaration that establishes it is the record or enum header -
 * so it is neither a gap nor an architectural landmark. Treating them as
 * unresolvable would report a hole in a story that has none, which is as
 * dishonest as the opposite error.
 */
const OBJECT_MEMBERS = new Map<string, number[]>([
  ["toString", [0]],
  ["hashCode", [0]],
  ["equals", [1]],
  ["getClass", [0]],
  ["clone", [0]],
  ["notify", [0]],
  ["notifyAll", [0]],
  ["wait", [0, 1, 2]],
]);

const ENUM_MEMBERS = new Map<string, number[]>([
  ["values", [0]],
  ["valueOf", [1]],
  ["name", [0]],
  ["ordinal", [0]],
  ["compareTo", [1]],
]);

const implicitlyDeclared = (type: TypeSymbol, name: string, arity: number): boolean => {
  if (OBJECT_MEMBERS.get(name)?.includes(arity)) return true;
  if (type.kind === "enum" && ENUM_MEMBERS.get(name)?.includes(arity)) return true;
  return type.kind === "record" && arity === 0 && type.fields.has(name);
};

/** Whether a type declares a supertype the subject itself does not own. */
const hasForeignSupertype = (index: JavaIndex, type: TypeSymbol): boolean =>
  [...type.supertypes].some((s) => uniqueType(index, s, type.path) === null);

/**
 * Whether a resolved declaration lives somewhere other than the receiver's own
 * type - inherited from a subject supertype, or declared by an enclosing type.
 *
 * PR 4 named this as a limit and drew no arrow, because the gate re-typed a
 * receiver only from the declarations in the calling file and would have
 * overturned a real chain. PR 5 makes the gate's receiver resolution
 * subtype-aware instead - it re-derives the inheritance relation from the blob -
 * so the arrow is drawn, and the claim says which type the call was WRITTEN on
 * beside the type that declares the target. The two derivations stay independent:
 * the producer reads a parse tree, the gate re-reads the source.
 */
const inheritedDeclaration = (owner: TypeSymbol, receiver: TypeSymbol): boolean =>
  owner.qualified !== receiver.qualified || owner.path !== receiver.path;

/**
 * Trace one entry method to its terminals under the bounds above.
 *
 * The traversal is deliberately whole-graph rather than single-path: a real
 * handler writes a record AND returns a response, and drawing only one of them
 * would be a picture of a different program.
 */
export const traceFrom = (
  index: JavaIndex,
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
    const external = externalEffectOf(method);
    // Leaving the program IS an ending. #35's terminal set names "an external
    // side effect" alongside a response and a durable write, and without this a
    // void method that writes a file or starts a process is pruned as a helper
    // that goes nowhere - which is the opposite of what it does.
    if (external !== undefined) terminals.add(methodKey(type, method));
    return {
      key: methodKey(type, method),
      type,
      method,
      ...(external === undefined ? {} : { externalEffect: external }),
      ...(isTransactional(type, method) ? { transactional: true } : {}),
    };
  };

  landmarks.set(entry, landmarkOf(entryType, entryMethod));

  /**
   * One call through an interface or abstract class, resolved against the closed
   * implementation set the subject's own wiring establishes - or named as a gap.
   *
   * A closed set of several members is drawn as a FAN-OUT of separately labelled
   * and separately evidenced arrows, not as a chosen variant. That is the honest
   * shape: the tree establishes that the call reaches one of these and which
   * guard selects each, and it does not establish which one a given request takes.
   * Picking the "obvious" one would assert an execution the tree never stated,
   * and PR 1's edge contract exists precisely so each branch can carry its own
   * label and its own evidence.
   */
  const dispatchInto = (
    base: TypeSymbol,
    name: string,
    arity: number,
    edgeBase: Omit<TraceEdge, "to" | "relation">,
    key: string,
    stack: string[],
    blindReason: string | undefined,
  ): void => {
    const closed = closedDispatch(index, base, name, arity);
    if (closed.kind === "implicit") return;
    if (closed.kind === "open") {
      gap(
        "unresolved_dispatch",
        key,
        `${key} calls ${base.name}.${name} through ${base.kind === "interface" ? "an interface" : "an abstract class"} whose implementation set the subject's wiring does not close: ${closed.why}`,
      );
      return;
    }
    // The guard is how the set was closed, so a call to it is resolved by the
    // same reading that closed the set. It is dispatch machinery rather than a
    // landmark of the story, and drawing an arrow into every implementation's
    // predicate would fill the figure with the mechanism instead of the path.
    if (closed.guardMethod === name) return;
    if (blindReason !== undefined) {
      gap("unresolved_receiver_type", key, `${key} dispatches ${base.name}.${name} on a receiver where ${blindReason}`);
      return;
    }
    // Several branches may share one target - three graders inheriting the same
    // interface default - and that is ONE arrow carrying every label that reaches
    // it, not three arrows drawn on top of each other.
    const byTarget = new Map<string, { member: (typeof closed.members)[number]; labels: string[] }>();
    for (const member of closed.members) {
      const targetKey = methodKey(member.type, member.method);
      const existing = byTarget.get(targetKey);
      if (existing) existing.labels.push(member.label);
      else byTarget.set(targetKey, { member, labels: [member.label] });
    }
    for (const [targetKey, { member, labels }] of byTarget) {
      if (stack.includes(targetKey) || targetKey === key) {
        cyclesCut += 1;
        cycleAt.add(key);
        continue;
      }
      const known = landmarks.has(targetKey);
      if (!known) landmarks.set(targetKey, landmarkOf(member.type, member.method));
      edges.push({
        ...edgeBase,
        to: targetKey,
        relation: "dispatch",
        label: `${name}(${arity === 0 ? "" : "..."}) via ${labels.join(" | ")}`,
        dispatch: {
          via: closed.via,
          base,
          labels,
          memberCount: closed.members.length,
          guards: closed.members.filter((m) => labels.includes(m.label)).map((m) => m.guard),
        },
      });
      if (!known) visit(member.type, member.method, [...stack, key]);
    }
  };

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
    if (!body) return;
    const scope = receiverScope(type, method);
    const lambdaNames = lambdaParameters(index, body, scope.at);
    const subjectRootedLambda = subjectRootedLambdaParameters(index, type, method, body, scope.at);

    const invocations: SyntaxNode[] = [];
    walk(body, (n) => {
      if (n.type === "method_invocation") invocations.push(n);
    });

    for (const invocation of invocations) {
      const name = invocation.childForFieldName("name")?.text;
      if (name === undefined) continue;
      const receiverNode = invocation.childForFieldName("object");
      // Receivers are resolved from the invocation's own scope chain, so a local
      // declared inside a lambda types a call inside that same lambda but not one
      // outside it.
      const receivers = scope.at(invocation);
      const argTypes = (arg: SyntaxNode): Resolved =>
        expressionType(index, type, method, receivers, arg, 1);
      const lambdaType =
        receiverNode?.type === "identifier" && !receivers.has(receiverNode.text)
          ? lambdaNames.get(receiverNode.text)
          : undefined;
      // A lambda parameter the injected collection's element type establishes is
      // typed like any other receiver; one it does not is left to the foreign
      // handler below, which names it rather than passing over it.
      const receiver: Resolved =
        lambdaType != null
          ? { kind: "subject", type: lambdaType }
          : expressionType(index, type, method, receivers, receiverNode);
      // A receiver reached through a chained call is one this phase can type but
      // the gate usually cannot: it re-types a receiver only from named
      // declarations in the calling file. The single exception is an accessor
      // declared in that same file and called with no receiver of its own
      // (`graderFor(x).grade(...)`), because the file states its return type and
      // the gate re-reads exactly that. Every other chained receiver is named
      // where a real edge would otherwise be drawn, rather than traced into an
      // edge the gate would overturn or dropped in silence.
      const chainedReceiver = throughChainedCall(receiverNode) && !localAccessor(type, receiverNode);
      const blindReason =
        chainedReceiver
          ? `a chained call this phase types but the gate re-types a receiver only from the declarations in the calling file`
          : receiver.kind === "subject"
            ? receiver.blind
            : undefined;
      const blindGap = (why: string): void =>
        gap(
          "unresolved_receiver_type",
          key,
          `${key} calls ${name} on \`${receiverNode?.text ?? "this"}\`, where ${why}`,
        );
      if (receiver.kind === "foreign") {
        if (receiverNode?.type === "identifier" && !receivers.has(receiverNode.text)) {
          const on = receiverNode.text;
          if (lambdaNames.has(on)) {
            // A lambda parameter is named only when the collection it iterates is
            // the subject's own. A stream over a library collection (`Files.list`)
            // binds a library element, and gapping on somebody else's library is
            // exactly what this phase must not do - it would report a hole in the
            // subject's story where there is none.
            if (subjectRootedLambda.has(on)) {
              gap(
                "unresolved_receiver_type",
                key,
                `${key} calls ${name} on the lambda parameter ${on}, iterating a subject collection whose element type this phase does not establish`,
              );
            }
          } else if (scope.localNames.has(on)) {
            // A local by this name is declared in the method, but in a scope that
            // does not enclose this call - a sibling lambda or anonymous class, or
            // dropped as an ambiguous redeclaration. It is a subject-shaped
            // receiver this phase declined to type, so it is named rather than
            // skipped: a silent drop here could be a durable write, and the gate
            // re-resolves only emitted claims. A genuinely foreign receiver - a
            // library static, a literal - names no method local and stays foreign
            // and untraced, unchanged.
            gap(
              "unresolved_receiver_type",
              key,
              `${key} calls ${name} on ${on}, a local declared in a scope this call is not inside`,
            );
          }
        }
        continue;
      }
      if (receiver.kind === "depth_exceeded") {
        // The chain nests past the recursion bound, so its root went untyped -
        // not because it is a library call but because the walk stopped short. A
        // chain rooted in a subject type is named like any other chained receiver
        // this phase cannot establish, so a very long fluent chain quarantines by
        // name rather than dropping a possibly load-bearing branch in silence; a
        // chain rooted in a genuinely foreign type stays silent and untraced. The
        // bound itself is unchanged, only its reporting. No fixture: the trigger
        // needs a contrived six-deep receiver chain that would read worse than
        // this note.
        if (
          chainedReceiver &&
          expressionType(index, type, method, receivers, chainRoot(receiverNode)).kind === "subject"
        ) {
          blindGap(blindReason!);
        }
        continue;
      }
      if (receiver.kind === "ambiguous") {
        gap(
          "unresolved_receiver_type",
          key,
          `${key} calls ${name} on ${receiver.name}, a simple name more than one subject type declares`,
        );
        continue;
      }
      if (receiver.kind === "unestablished") {
        gap("unresolved_receiver_type", key, `${key} calls ${name} where ${receiver.why}`);
        continue;
      }
      const target = receiver.type;
      // A call written on a TYPE name is static: it resolves to that type's own
      // declaration, interface or not. Sending it through the dispatch resolver
      // would ask which implementation a static factory belongs to, which is not
      // a question the language poses.
      const staticReceiver =
        receiverNode?.type === "identifier" &&
        !receivers.has(receiverNode.text) &&
        simpleTypeName(receiverNode.text) === target.name;
      const args = Array.from(
        { length: argumentCount(invocation) },
        (_, i) => invocation.childForFieldName("arguments")!.namedChild(i)!,
      ).filter((n): n is SyntaxNode => n !== null);

      const range = citedRange(invocation);
      const heldReceiver =
        receiverNode?.type === "identifier"
          ? type.fieldsDeclared.has(receiverNode.text) || receivers.has(receiverNode.text)
          : receiverNode?.type === "field_access";
      const edgeBase = {
        from: key,
        heldReceiver,
        label: `${name}(${args.length === 0 ? "" : "..."})`,
        path: type.path,
        line_start: range.startPosition.row + 1,
        line_end: range.endPosition.row + 1,
        inReturn: insideReturn(invocation, body),
      };

      // A read or a write against a storage type ends the path. A call on a
      // repository that names neither is an ordinary call and falls through to
      // the resolution below, because a private helper on a repository class is
      // not a data boundary and calling it one would type the arrow wrongly.
      const dataRelation = isRepositoryType(target)
        ? READ_METHOD.test(name)
          ? ("read" as const)
          : WRITE_METHOD.test(name)
            ? ("write" as const)
            : null
        : null;
      if (dataRelation !== null) {
        const declared = target.methods.filter((m) => m.name === name && m.params.length === args.length);
        if (declared.length === 1) {
          if (blindReason !== undefined) {
            blindGap(blindReason);
            continue;
          }
          const targetKey = methodKey(target, declared[0]!);
          if (!landmarks.has(targetKey)) {
            landmarks.set(targetKey, {
              ...landmarkOf(target, declared[0]!),
              dataAccess: { relation: dataRelation },
            });
          }
          terminals.add(targetKey);
          edges.push({ ...edgeBase, to: targetKey, relation: dataRelation });
          continue;
        }
        if (declared.length > 1) {
          gap(
            "ambiguous_overload",
            key,
            `${key} ${dataRelation}s ${target.name}.${name}, where more than one declared overload takes ${args.length} arguments`,
          );
          continue;
        }
        if (target.kind === "interface") {
          gap(
            "unprovable_data_access",
            key,
            `${key} calls ${target.name}.${name}, which ${target.path} inherits rather than declares, so no line in the tree establishes the access`,
          );
          continue;
        }
      }

      if (!staticReceiver && (target.kind === "interface" || target.modifiers.includes("abstract"))) {
        dispatchInto(target, name, args.length, edgeBase, key, stack, blindReason);
        continue;
      }

      const found = declaredMethod(index, target, name, args, argTypes);
      if (found.kind === "ambiguous") {
        gap(
          "ambiguous_overload",
          key,
          `${key} calls ${target.name}.${name} where more than one declared overload takes ${args.length} arguments`,
        );
        continue;
      }
      if (found.kind === "missing") {
        // Declared by the language rather than by a source line: resolved, and
        // not a landmark of its own.
        if (implicitlyDeclared(target, name, args.length)) continue;
        // Inherited from outside the subject: not this tree's behaviour to trace.
        if (hasForeignSupertype(index, target)) continue;
        gap(
          "unresolved_target",
          key,
          `${key} calls ${target.name}.${name}, which no declaration in ${target.path} or its subject supertypes provides`,
        );
        continue;
      }

      // A record component the subject also declares on a sealed supertype: the
      // record header is what establishes the accessor, so it is RESOLVED and not
      // an architectural landmark - the same rule that treats `toString` as
      // declared. Reporting a hole in a story that has none is as dishonest as
      // the opposite error, and this is the shape the reference subject writes
      // (`Exercise.id()`, declared on the sealed `Content` it implements).
      if (inheritedDeclaration(found.type, target) && implicitlyDeclared(target, name, args.length)) {
        continue;
      }
      // A target the tree declares without a body is a dispatch, not a call: an
      // abstract method, or an interface method a default implementation calls on
      // itself. Resolving it needs the same closed set as any other dispatch.
      if (found.method.body === null && (found.type.kind === "interface" || found.type.modifiers.includes("abstract"))) {
        dispatchInto(found.type, name, args.length, edgeBase, key, stack, blindReason);
        continue;
      }
      if (blindReason !== undefined) {
        blindGap(blindReason);
        continue;
      }
      const inherited = inheritedDeclaration(found.type, target);
      const targetKey = methodKey(found.type, found.method);
      if (stack.includes(targetKey) || targetKey === key) {
        // A cycle is cut rather than followed. It is recorded, because a trace
        // that reaches no terminal has to be able to say the recursion is why.
        cyclesCut += 1;
        cycleAt.add(key);
        continue;
      }
      const known = landmarks.has(targetKey);
      // Never overwrite: the same method reached twice keeps the first entry, so
      // a data-access terminal cannot be demoted to an ordinary landmark by a
      // second arrow arriving at it.
      if (!known) landmarks.set(targetKey, landmarkOf(found.type, found.method));
      edges.push({
        ...edgeBase,
        to: targetKey,
        // A call into a method that starts a process or writes the filesystem is
        // a side effect, not an ordinary step: it is what leaves the program.
        relation: landmarks.get(targetKey)!.externalEffect === undefined ? "call" : "side_effect",
        ...(inherited ? { receiver: target } : {}),
      });
      if (!known) visit(found.type, found.method, [...stack, key]);
    }
  };

  visit(entryType, entryMethod, []);

  // A leaf reached by a call inside a `return` statement is the value the caller
  // hands back: a terminal. A leaf reached any other way is a helper the story
  // does not end at, and is pruned below rather than drawn as an ending.
  const outgoing = new Set(edges.map((e) => e.from));
  for (const [key] of landmarks) {
    if (outgoing.has(key) || terminals.has(key)) continue;
    // A landmark whose own call was cut for a cycle is not a leaf: its story
    // continues, into the recursion this trace refused to follow. Calling it a
    // terminal would turn a bound into an ending.
    if (cycleAt.has(key)) continue;
    if (edges.some((e) => e.to === key && e.inReturn)) terminals.add(key);
  }

  return { entry, landmarks, edges, terminals, gaps, cyclesCut, cycleAt };
};

/**
 * The trace reduced to the paths that actually reach a terminal.
 *
 * This is not selection between stories - rank owns that - it is what "a path"
 * means: a helper call that goes nowhere is not part of the execution narrative,
 * and drawing it would pad the figure with boxes the story does not pass through.
 *
 * A gap ANYWHERE the trace visited still quarantines the whole candidate, not
 * merely a gap on a path that survived. That is deliberate and it is the point:
 * a landmark the entry executes is part of what happens, so a call inside it
 * that could not be resolved is a hole in the story whether or not its branch
 * reaches a terminal. Scoping the check to survivors would make pruning a way to
 * walk around an unresolved dispatch and still draw a confident picture.
 */
export const retained = (trace: TraceResult): { landmarks: Set<string>; edges: TraceEdge[] } => {
  const reachesTerminal = new Set<string>(trace.terminals);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of trace.edges) {
      if (reachesTerminal.has(edge.to) && !reachesTerminal.has(edge.from)) {
        reachesTerminal.add(edge.from);
        changed = true;
      }
    }
  }
  if (!reachesTerminal.has(trace.entry)) return { landmarks: new Set(), edges: [] };

  const fromEntry = new Set<string>([trace.entry]);
  const pending = [trace.entry];
  while (pending.length > 0) {
    const key = pending.pop()!;
    for (const edge of trace.edges) {
      if (edge.from !== key || !reachesTerminal.has(edge.to) || fromEntry.has(edge.to)) continue;
      fromEntry.add(edge.to);
      pending.push(edge.to);
    }
  }
  return {
    landmarks: fromEntry,
    edges: trace.edges.filter((e) => fromEntry.has(e.from) && fromEntry.has(e.to)),
  };
};
