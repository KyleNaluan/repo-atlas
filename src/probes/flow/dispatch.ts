/**
 * Closed-set dispatch: when a call through an interface names a set of targets
 * the tree itself closes (#35, accepted design 5.3, PR 5).
 *
 * PR 4 stopped at every interface, by name, because a phase that guesses the
 * "obvious" implementation is a phase that draws arrows the subject may not
 * execute. That stop is what cut the reference subject's submission story at
 * `ExerciseCatalog.byId`. This module closes it where - and only where - the
 * subject's own wiring makes the answer complete rather than likely:
 *
 * - **One implementation.** Spring injects the sole bean that implements the
 *   interface. There is nothing to choose, so the dispatch is a fact.
 * - **A guarded set.** Every implementation declares the same predicate over a
 *   SEALED hierarchy (`supports(x)` returning `x.y() instanceof Grading.TestCases`),
 *   and the guards' types are exactly the sealed base's permitted subtypes. The
 *   set is closed because the sealed declaration says nothing else can join it,
 *   and each branch is named by the guard the tree wrote.
 * - **A keyed registry.** Every implementation declares the same zero-argument
 *   accessor returning a distinct string literal (`languageId()`), which is the
 *   key a registry stores it under. The branch is named by that literal.
 *
 * Everything else stays open and stays cut. In particular a set is closed only
 * when EVERY member is a Spring-managed bean: an implementation the container
 * does not wire is one the caller may still be handed by some other route, and a
 * set that is missing a member is the one error a closed set must never make.
 *
 * The gate re-derives the same set textually from the pinned blob
 * (`src/gate/flow.ts`), so the producer resolves exactly as far as the gate can
 * independently re-resolve, and the two derivations stay independent.
 */
import { findAll, type SyntaxNode } from "../java.js";
import {
  implementationsOf,
  qualifiedTypeName,
  simpleTypeName,
  uniqueType,
  type JavaIndex,
  type MethodSymbol,
  type TypeSymbol,
} from "./symbols.js";

/** How the tree closed one dispatch set. Carried into the gate claim by name. */
export type DispatchVia =
  | "sole_implementation"
  | "sealed_guard"
  | "keyed_registry"
  /** Closed, but with no guard or key naming which branch is which. */
  | "closed_set";

export interface DispatchMember {
  type: TypeSymbol;
  method: MethodSymbol;
  /** The branch as the tree names it: an implementation, a permitted type, a key. */
  label: string;
  /** The declaration that establishes this branch, cited on the rendered arrow. */
  guard: { path: string; line_start: number; line_end: number };
}

export type ClosedDispatch =
  | {
      kind: "closed";
      via: DispatchVia;
      base: TypeSymbol;
      members: DispatchMember[];
      /**
       * The predicate or accessor the set is closed BY, when there is one.
       *
       * A call to it is the selection itself rather than a step of the story -
       * `graders.stream().filter(g -> g.supports(exercise))` is how the registry
       * chooses, not something that happens to the submission. Naming it here is
       * what lets the tracer resolve such a call without drawing an arrow to
       * every implementation's guard body.
       */
      guardMethod?: string;
    }
  | {
      /**
       * Every implementation answers the call from its own declaration header - a
       * record component accessor. Resolved, and not a landmark: reporting a hole
       * in a story that has none is as dishonest as the opposite error.
       */
      kind: "implicit";
    }
  | { kind: "open"; why: string };

/** A record's component accessor: declared by the header, not by a source line. */
const implicitAccessor = (type: TypeSymbol, name: string, arity: number): boolean =>
  type.kind === "record" && arity === 0 && type.fields.has(name);

/** The method a type resolves `name/arity` to, following subject-owned supertypes. */
const methodOn = (
  index: JavaIndex,
  type: TypeSymbol,
  name: string,
  arity: number,
  seen = new Set<string>(),
): { type: TypeSymbol; method: MethodSymbol } | null => {
  const key = `${type.path}#${type.qualified}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const byArity = type.methods.filter((m) => m.name === name && m.params.length === arity);
  // An overload this resolver cannot separate is not a target it may pick.
  if (byArity.length === 1) return { type, method: byArity[0]! };
  if (byArity.length > 1) return null;
  for (const supertype of type.supertypes) {
    const parent = uniqueType(index, supertype, type.path);
    if (!parent) continue;
    const found = methodOn(index, parent, name, arity, seen);
    if (found) return found;
  }
  return null;
};

/** The single expression a `return <expr>;`-only method body hands back. */
const soleReturn = (method: MethodSymbol): SyntaxNode | null => {
  if (!method.body) return null;
  const returns = findAll(method.body, "return_statement");
  if (returns.length !== 1) return null;
  return returns[0]!.namedChild(0) ?? null;
};

/**
 * The type a guard method tests for: `return <anything> instanceof Grading.TestCases;`.
 *
 * The tested expression is deliberately not analysed. What makes the branch
 * nameable is the type on the right of `instanceof` and the sealed declaration
 * that bounds it, not what the guard happens to read to get there.
 */
const instanceOfGuard = (method: MethodSymbol): string | null => {
  const expression = soleReturn(method);
  if (expression?.type !== "instanceof_expression") return null;
  const tested = expression.childForFieldName("right")?.text;
  return tested === undefined ? null : qualifiedTypeName(tested);
};

/** The literal a `return "java";`-only accessor hands back. */
const literalKey = (method: MethodSymbol): string | null => {
  if (method.params.length > 0) return null;
  const expression = soleReturn(method);
  if (expression?.type !== "string_literal") return null;
  const text = expression.text;
  return text.length >= 2 ? text.slice(1, -1) : null;
};

/**
 * The sealed base whose permitted subtypes are exactly `named`, or null.
 *
 * This is what makes a guarded set CLOSED rather than merely enumerated. Four
 * graders each testing a different record proves four branches exist; the sealed
 * declaration is what proves there is no fifth - the compiler refuses a subtype
 * outside the permits clause, so the subject types implementing it are the whole
 * set by construction.
 */
const sealedOver = (index: JavaIndex, named: string[]): TypeSymbol | null => {
  const guardTypes = named.map((name) => uniqueType(index, name, undefined));
  if (guardTypes.some((type) => type === null)) return null;
  const wanted = new Set(guardTypes.map((type) => type!.qualified));
  const bases = new Set<string>();
  for (const type of guardTypes) for (const supertype of type!.supertypes) bases.add(supertype);
  for (const name of bases) {
    const base = uniqueType(index, name, undefined);
    if (!base || !base.modifiers.includes("sealed")) continue;
    const permitted = new Set(implementationsOf(index, base).map((type) => type.qualified));
    if (permitted.size !== wanted.size) continue;
    if ([...wanted].every((qualified) => permitted.has(qualified))) return base;
  }
  return null;
};

const guardEvidence = (
  type: TypeSymbol,
  method: MethodSymbol,
): { path: string; line_start: number; line_end: number } => ({
  path: type.path,
  line_start: method.line_start,
  line_end: method.line_end,
});

/**
 * The closed implementation set for one call through `base`, or why it is open.
 *
 * Every refusal names itself. "This interface has three implementations and no
 * shared guard" and "this interface has none" are different findings about the
 * subject, and a producer that reported one number for both would hide which.
 */
export const closedDispatch = (
  index: JavaIndex,
  base: TypeSymbol,
  name: string,
  arity: number,
): ClosedDispatch => {
  const implementations = implementationsOf(index, base).filter(
    (type) => type.kind !== "interface" && !type.modifiers.includes("abstract"),
  );
  if (implementations.length === 0) {
    return { kind: "open", why: `no subject type implements ${base.name}` };
  }
  // Every implementation resolving the call implicitly - a record component
  // accessor over a sealed content interface - is a call the tree establishes
  // without any of them being a step of the story. `Content.id()` on the
  // reference subject is exactly this: whichever permitted record it is, the
  // record header declares the accessor.
  if (implementations.every((type) => implicitAccessor(type, name, arity))) {
    return { kind: "implicit" };
  }
  const resolved = implementations.map((type) => ({ type, found: methodOn(index, type, name, arity) }));
  const missing = resolved.find((entry) => entry.found === null);
  if (missing) {
    return {
      kind: "open",
      why: `${missing.type.name} implements ${base.name} but resolves no single ${name}/${arity}`,
    };
  }
  const members = resolved.map((entry) => ({ type: entry.type, found: entry.found! }));

  if (members.length === 1) {
    const only = members[0]!;
    return {
      kind: "closed",
      via: "sole_implementation",
      base,
      members: [
        {
          type: only.found.type,
          method: only.found.method,
          label: only.type.name,
          guard: { path: only.type.path, line_start: only.type.line_start, line_end: only.type.header_line_end },
        },
      ],
    };
  }

  // Past one implementation, either the language or the container has to be what
  // closes the set. A `sealed` base is closed by the compiler, so its permitted
  // subtypes are the whole set by construction. Otherwise the container's wiring
  // decides, and a member it does not manage is one this phase cannot say is in
  // or out - an incomplete set being worse than an open one.
  const unmanaged = base.modifiers.includes("sealed") ? undefined : members.find((member) => !member.type.bean);
  if (unmanaged) {
    return {
      kind: "open",
      why: `${base.name} has ${members.length} implementations and ${unmanaged.type.name} carries no Spring stereotype, so the container does not close the set`,
    };
  }

  // A guarded set: one predicate every implementation declares, over a sealed base.
  for (const guardName of new Set(members[0]!.type.methods.map((m) => m.name))) {
    const guards = members.map((member) => {
      const declared = member.type.methods.filter((m) => m.name === guardName);
      const guard = declared.length === 1 ? instanceOfGuard(declared[0]!) : null;
      return { member, declared: declared[0], guard };
    });
    if (guards.some((entry) => entry.guard === null)) continue;
    const labels = guards.map((entry) => entry.guard!);
    if (new Set(labels).size !== labels.length) continue;
    if (sealedOver(index, labels) === null) continue;
    return {
      kind: "closed",
      via: "sealed_guard",
      base,
      guardMethod: guardName,
      members: guards.map((entry) => ({
        type: entry.member.found.type,
        method: entry.member.found.method,
        label: entry.guard!,
        guard: guardEvidence(entry.member.type, entry.declared!),
      })),
    };
  }

  // A keyed registry: one accessor every implementation declares, each returning
  // a distinct literal - the key a registry stores the bean under.
  for (const keyName of new Set(members[0]!.type.methods.map((m) => m.name))) {
    const keys = members.map((member) => {
      const declared = member.type.methods.filter((m) => m.name === keyName && m.params.length === 0);
      return { member, declared: declared[0], key: declared.length === 1 ? literalKey(declared[0]!) : null };
    });
    if (keys.some((entry) => entry.key === null)) continue;
    const literals = keys.map((entry) => entry.key!);
    if (new Set(literals).size !== literals.length) continue;
    return {
      kind: "closed",
      via: "keyed_registry",
      base,
      guardMethod: keyName,
      members: keys.map((entry) => ({
        type: entry.member.found.type,
        method: entry.member.found.method,
        label: `"${entry.key!}"`,
        guard: guardEvidence(entry.member.type, entry.declared!),
      })),
    };
  }

  // Closed, but with nothing in the tree naming the branches. The set is still
  // the whole set - that is what `sealed` and the container's bean set each
  // guarantee - so the call fans out to every member, labelled by implementation.
  // What is missing is the PREDICATE, not the completeness, and a fan-out whose
  // arrows are named only by their targets says exactly that much and no more.
  return {
    kind: "closed",
    via: "closed_set",
    base,
    members: members.map((member) => ({
      type: member.found.type,
      method: member.found.method,
      label: member.type.name,
      guard: {
        path: member.type.path,
        line_start: member.type.line_start,
        line_end: member.type.header_line_end,
      },
    })),
  };
};
