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
 * `closed_dispatch` and `reachability` deliberately have no resolver in this
 * phase (the gate fails them closed), so no dispatch through an interface is
 * traced here either. The producer and the gate agree about what this phase can
 * prove, and both fail closed on the rest.
 */
import { findAll, walk, type SyntaxNode } from "../java.js";
import {
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
  /**
   * Rendered landmarks. #35's readability criterion compresses a longer story at
   * a verified seam, and that compression is a later phase; until it exists a
   * longer trace is quarantined rather than clipped, because hiding a load-bearing
   * boundary to fit a visual budget is the failure the criterion names.
   */
  maxLandmarks: 8,
} as const;

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
}

export interface TraceEdge {
  from: string;
  to: string;
  relation: "call" | "read" | "write" | "return";
  /** The call this arrow is, as the source wrote it. */
  label: string;
  path: string;
  line_start: number;
  line_end: number;
  /** Set when the call site sits inside a `return` statement of the calling method. */
  inReturn: boolean;
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
 * Every name a method body can use as a receiver, with the type it was declared
 * with: the enclosing type's fields, this method's parameters, and its locals.
 *
 * A name declared twice with different types is dropped rather than guessed, on
 * the same rule the field index uses: an ambiguous receiver must fail closed.
 */
const receiverTypes = (type: TypeSymbol, method: MethodSymbol): Map<string, string> => {
  const names = new Map<string, string>(type.fields);
  const conflicting = new Set<string>();
  const remember = (name: string, declared: string): void => {
    const previous = names.get(name);
    if (previous !== undefined && previous !== declared) conflicting.add(name);
    names.set(name, declared);
  };
  for (const param of method.params) if (param.name) remember(param.name, param.type);
  if (method.body) {
    for (const local of findAll(method.body, "local_variable_declaration")) {
      const declared = local.childForFieldName("type")?.text;
      if (!declared) continue;
      for (const declarator of findAll(local, "variable_declarator")) {
        const name = declarator.childForFieldName("name")?.text;
        if (name) remember(name, simpleTypeName(declared));
      }
    }
  }
  for (const name of conflicting) names.delete(name);
  return names;
};

/**
 * The parameter names a lambda introduces in one method body.
 *
 * Their types come from whichever functional interface the call site expects,
 * which this phase does not resolve. They are collected so that a call ON one of
 * them is recorded as an unresolved receiver rather than passed over as foreign:
 * "I could not type this" and "this is somebody else's library" must not look
 * the same, which is the same rule that makes an inapplicable probe say so by
 * name.
 */
const lambdaParameters = (body: SyntaxNode): Set<string> => {
  const names = new Set<string>();
  for (const lambda of findAll(body, "lambda_expression")) {
    const params = lambda.childForFieldName("parameters");
    if (!params) continue;
    if (params.type === "identifier") {
      names.add(params.text);
      continue;
    }
    walk(params, (n) => {
      if (n.type === "identifier") names.add(n.text);
    });
  }
  return names;
};

type Resolved =
  | { kind: "subject"; type: TypeSymbol }
  | { kind: "foreign" }
  | { kind: "ambiguous"; name: string }
  /** A subject-owned receiver this phase declines to type. Named, never skipped. */
  | { kind: "unestablished"; why: string };

const FOREIGN: Resolved = { kind: "foreign" };

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
  receivers: Map<string, string>,
  expr: SyntaxNode | null,
  depth = 0,
): Resolved => {
  if (expr === null) return { kind: "subject", type };
  if (depth > 4) return FOREIGN;
  if (expr.type === "this") return { kind: "subject", type };
  if (expr.type === "identifier") {
    const declared = receivers.get(expr.text);
    if (declared !== undefined) return named(index, declared);
    // Not a value in scope: a type name is a static call, anything else foreign.
    return named(index, expr.text);
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
    const declared = owner.type.fields.get(field);
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
    return named(index, declared);
  }
  if (expr.type === "object_creation_expression") {
    const created = expr.childForFieldName("type")?.text;
    return created === undefined ? FOREIGN : named(index, created);
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
    return returns === null ? FOREIGN : named(index, returns);
  }
  if (expr.type === "parenthesized_expression") {
    return expressionType(index, type, method, receivers, expr.namedChild(0), depth + 1);
  }
  return FOREIGN;
};

/** A declared type name resolved against the subject index. */
const named = (index: JavaIndex, declared: string): Resolved => {
  const simple = simpleTypeName(declared);
  // `var` names no type at all: what it holds comes from the initialiser's
  // inferred type, which this phase does not compute. A call on one is a
  // receiver this phase cannot type, and saying so is the honest report - a
  // silent skip would look exactly like a call into somebody else's library.
  if (simple === "var") {
    return { kind: "unestablished", why: "the receiver is a `var` local whose inferred type this phase does not compute" };
  }
  const found = index.bySimpleName.get(simple) ?? [];
  if (found.length === 1) return { kind: "subject", type: found[0]! };
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
    const parent = uniqueType(index, supertype);
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
  [...type.supertypes].some((s) => uniqueType(index, s) === null);

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

  landmarks.set(entry, { key: entry, type: entryType, method: entryMethod });

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
    const receivers = receiverTypes(type, method);
    const untypedLambdaNames = lambdaParameters(body);
    const argTypes = (arg: SyntaxNode): Resolved =>
      expressionType(index, type, method, receivers, arg, 1);

    const invocations: SyntaxNode[] = [];
    walk(body, (n) => {
      if (n.type === "method_invocation") invocations.push(n);
    });

    for (const invocation of invocations) {
      const name = invocation.childForFieldName("name")?.text;
      if (name === undefined) continue;
      const receiverNode = invocation.childForFieldName("object");
      const receiver = expressionType(index, type, method, receivers, receiverNode);
      // A receiver reached through a chained call is one this phase can type but
      // the gate cannot: it re-types a receiver only from named declarations in
      // the calling file. Such a call is named where a real edge would otherwise
      // be drawn, below, rather than traced into an edge the gate would overturn
      // or dropped in silence when the chain's accessor is inherited.
      const chainedReceiver = throughChainedCall(receiverNode);
      const chainGap = (): void =>
        gap(
          "unresolved_receiver_type",
          key,
          `${key} calls ${name} on \`${receiverNode!.text}\`, a chained call this phase types but the gate re-types a receiver only from the declarations in the calling file`,
        );
      if (receiver.kind === "foreign") {
        if (
          receiverNode?.type === "identifier" &&
          !receivers.has(receiverNode.text) &&
          untypedLambdaNames.has(receiverNode.text)
        ) {
          gap(
            "unresolved_receiver_type",
            key,
            `${key} calls ${name} on the lambda parameter ${receiverNode.text}, whose type this phase does not establish`,
          );
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
      const args = Array.from(
        { length: argumentCount(invocation) },
        (_, i) => invocation.childForFieldName("arguments")!.namedChild(i)!,
      ).filter((n): n is SyntaxNode => n !== null);

      const range = citedRange(invocation);
      const edgeBase = {
        from: key,
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
          if (chainedReceiver) {
            chainGap();
            continue;
          }
          const targetKey = methodKey(target, declared[0]!);
          if (!landmarks.has(targetKey)) {
            landmarks.set(targetKey, {
              key: targetKey,
              type: target,
              method: declared[0]!,
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

      if (target.kind === "interface" || target.modifiers.includes("abstract")) {
        gap(
          "unresolved_dispatch",
          key,
          `${key} calls ${target.name}.${name} through ${target.kind === "interface" ? "an interface" : "an abstract class"}, and this phase closes no implementation set`,
        );
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

      if (chainedReceiver) {
        chainGap();
        continue;
      }
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
      if (!known) landmarks.set(targetKey, { key: targetKey, type: found.type, method: found.method });
      edges.push({ ...edgeBase, to: targetKey, relation: "call" });
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
