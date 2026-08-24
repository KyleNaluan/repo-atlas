/**
 * The second structural-parse dependency, and the second grammar pinned to one
 * `web-tree-sitter` ABI (#52, D4).
 *
 * `java.ts` records why the grammar is a vendored WASM asset rather than a
 * package dependency: the only npm package shipping prebuilt grammars bundles
 * about forty of them at 50 MB. That reasoning is unchanged here, and the
 * consequence #52 names is that there are now TWO files that move with a
 * `web-tree-sitter` upgrade rather than one. The pin was closed by measurement,
 * not by assumption: `tree-sitter-python.wasm` from `tree-sitter-wasms@0.1.13`
 * loads under the pinned `web-tree-sitter@0.20.8` and parses all 309 production
 * Python files across both #52 fixture subjects with zero `ERROR` nodes.
 *
 * Reproduction, verbatim from D4:
 *
 *   npm pack tree-sitter-wasms@0.1.13
 *   tar -xzf tree-sitter-wasms-0.1.13.tgz -O package/out/tree-sitter-python.wasm \
 *     > assets/tree-sitter-python.wasm
 *
 * The node surface is shared with `java.ts` (`SyntaxNode`) so the two languages
 * cannot drift into two incompatible readers of one parser, but every helper
 * below is Python's own: Python declares no types the way Java does, so the
 * questions a caller asks of a Python tree are different questions.
 */
import { readFileSync } from "node:fs";
import Parser from "web-tree-sitter";
import { walk, type SyntaxNode } from "./java.js";

const GRAMMAR = new URL("../../assets/tree-sitter-python.wasm", import.meta.url);

type AnyParser = {
  setLanguage: (lang: unknown) => void;
  parse: (source: string) => { rootNode: SyntaxNode };
};

let parserPromise: Promise<AnyParser> | null = null;

const load = async (): Promise<AnyParser> => {
  if (parserPromise) return parserPromise;
  parserPromise = (async () => {
    const P = Parser as unknown as {
      init: () => Promise<void>;
      new (): AnyParser;
      Language: { load: (b: Uint8Array) => Promise<unknown> };
    };
    await P.init();
    const language = await P.Language.load(readFileSync(GRAMMAR));
    const parser = new P();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
};

export const parsePython = async (source: string): Promise<SyntaxNode> =>
  (await load()).parse(source).rootNode;

/** 1-based line of a node, for evidence line ranges. */
export const lineOf = (node: SyntaxNode): number => node.startPosition.row + 1;
export const endLineOf = (node: SyntaxNode): number => node.endPosition.row + 1;

export const findAll = (root: SyntaxNode, type: string): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  walk(root, (n) => {
    if (n.type === type) out.push(n);
  });
  return out;
};

/** The named children of a node, in order. */
export const namedChildren = (node: SyntaxNode): SyntaxNode[] => {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
};

export const nameOf = (node: SyntaxNode): string | null =>
  node.childForFieldName("name")?.text ?? null;

/**
 * The text of a string literal, or null when the node is not one literal.
 *
 * Every rule in the Python adapter that reads a route, a graph key or a registry
 * key demands a LITERAL, and this is the one place that demand is expressed. An
 * f-string is not a literal - the grammar gives it `interpolation` children, and
 * a path assembled at runtime is exactly the `dynamic_path:` cut the TypeScript
 * seam already names - so it fails closed here rather than at each caller.
 * Implicit concatenation (`"a" "b"`) is likewise refused: it is two nodes, and
 * admitting it would mean this reader and the gate's own reader had to agree
 * about joining them.
 */
export const stringLiteral = (node: SyntaxNode | null): string | null => {
  if (node === null || node.type !== "string") return null;
  if (findAll(node, "interpolation").length > 0) return null;
  const pieces = namedChildren(node).filter((child) => child.type === "string_content");
  if (pieces.length > 1) return null;
  // A grammar that gives no `string_content` child at all is an empty literal
  // (`""`), which is a literal and is returned as one.
  if (pieces.length === 0) {
    const raw = node.text;
    const quoted = /^[A-Za-z]*("""|'''|"|')([\s\S]*)\1$/.exec(raw);
    return quoted?.[2] === undefined ? null : quoted[2];
  }
  return pieces[0]!.text;
};

/**
 * The `def`/`class` statement a node sits in, innermost first, or null.
 *
 * A decorated definition wraps the `def` in a `decorated_definition`, so the
 * decorator's own arguments are INSIDE the definition's span; callers that want
 * "which function is this call written in" therefore ask for the definition and
 * never for the decorated wrapper.
 */
const DEFINITION = /^(function_definition|class_definition)$/;

export const enclosingDefinition = (node: SyntaxNode): SyntaxNode | null => {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (DEFINITION.test(cur.type)) return cur;
  }
  return null;
};

/** The `class` statements enclosing a node, outermost first. */
export const enclosingClassNames = (node: SyntaxNode): string[] => {
  const names: string[] = [];
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type === "class_definition") {
      const name = nameOf(cur);
      if (name) names.unshift(name);
    }
  }
  return names;
};

/**
 * The definition a `decorated_definition` decorates, plus its decorator nodes.
 *
 * Reading a route off the tree rather than off text is the same measurement
 * `entries.ts` records for Java `main`: `@app.get("/x")` appears inside README
 * fences and docstrings in both #52 subjects, and a text scan counts those.
 */
export interface Decorated {
  definition: SyntaxNode;
  decorators: SyntaxNode[];
}

export const decoratedOf = (node: SyntaxNode): Decorated | null => {
  if (DEFINITION.test(node.type)) {
    const parent = node.parent;
    if (parent?.type !== "decorated_definition") return { definition: node, decorators: [] };
    return {
      definition: node,
      decorators: namedChildren(parent).filter((child) => child.type === "decorator"),
    };
  }
  if (node.type !== "decorated_definition") return null;
  const definition = node.childForFieldName("definition");
  if (!definition) return null;
  return {
    definition,
    decorators: namedChildren(node).filter((child) => child.type === "decorator"),
  };
};

/**
 * A decorator read as `<object>.<attribute>(<args>)`, or null.
 *
 * Both halves are required because both are load-bearing: the object is the
 * router or app the route is mounted on, and the attribute is the HTTP verb.
 * A bare `@app` or a `@decorator` with no call is neither and reads as null.
 */
export interface DecoratorCall {
  object: string;
  attribute: string;
  call: SyntaxNode;
  arguments: SyntaxNode | null;
}

export const decoratorCall = (decorator: SyntaxNode): DecoratorCall | null => {
  const expression = namedChildren(decorator)[0];
  if (expression?.type !== "call") return null;
  const callee = expression.childForFieldName("function");
  if (callee?.type !== "attribute") return null;
  const object = callee.childForFieldName("object");
  const attribute = callee.childForFieldName("attribute");
  if (object?.type !== "identifier" || attribute === null) return null;
  return {
    object: object.text,
    attribute: attribute!.text,
    call: expression,
    arguments: expression.childForFieldName("arguments"),
  };
};

/**
 * One parameter's declared name and annotation, or null when the grammar node is
 * not a parameter that binds a plain name.
 *
 * `*args`, `**kwargs`, `/` and `*` bind nothing a receiver can be written on, and
 * the grammar spells the first two as splat patterns rather than identifiers, so
 * they read as null here instead of being attributed a name of `**kw`.
 */
export interface ParameterDecl {
  name: string;
  /** The annotation reduced to one name, or null when it names none. */
  type: string | null;
  /** The annotation node, for a caller that needs the union members. */
  annotation: SyntaxNode | null;
}

export const parameterDecl = (node: SyntaxNode): ParameterDecl | null => {
  if (node.type === "identifier") return { name: node.text, type: null, annotation: null };
  if (node.type === "default_parameter") {
    const name = node.childForFieldName("name");
    return name?.type === "identifier" ? { name: name.text, type: null, annotation: null } : null;
  }
  if (node.type === "typed_parameter" || node.type === "typed_default_parameter") {
    const annotation = node.childForFieldName("type");
    const named =
      node.type === "typed_default_parameter"
        ? node.childForFieldName("name")
        : namedChildren(node)[0];
    if (named?.type !== "identifier") return null;
    return { name: named.text, type: annotationName(annotation), annotation: annotation ?? null };
  }
  return null;
};

/** Every parameter a `def` declares that binds a plain name, in order. */
export const parametersOf = (definition: SyntaxNode): ParameterDecl[] => {
  const params = definition.childForFieldName("parameters");
  if (!params) return [];
  const out: ParameterDecl[] = [];
  for (const child of namedChildren(params)) {
    const decl = parameterDecl(child);
    if (decl) out.push(decl);
  }
  return out;
};

/** The base-class names a `class` statement declares, in order. */
export const superclassNames = (declaration: SyntaxNode): string[] => {
  const supers = declaration.childForFieldName("superclasses");
  if (!supers) return [];
  const out: string[] = [];
  for (const child of namedChildren(supers)) {
    // A keyword base (`metaclass=ABCMeta`) is not a base class; a subscripted one
    // (`Generic[T]`) names its head.
    if (child.type === "keyword_argument") continue;
    const name = annotationName(child);
    if (name !== null) out.push(name);
  }
  return out;
};

/** The positional arguments of a call node, in order. */
export const positionalArguments = (call: SyntaxNode): SyntaxNode[] => {
  const args = call.childForFieldName("arguments");
  if (!args) return [];
  return namedChildren(args).filter(
    (child) => child.type !== "keyword_argument" && child.type !== "comment",
  );
};

/** One keyword argument of a call node by name, or null. */
export const keywordArgument = (call: SyntaxNode, name: string): SyntaxNode | null => {
  const args = call.childForFieldName("arguments");
  if (!args) return null;
  for (const child of namedChildren(args)) {
    if (child.type !== "keyword_argument") continue;
    if (child.childForFieldName("name")?.text === name) {
      return child.childForFieldName("value") ?? null;
    }
  }
  return null;
};

/**
 * An annotation node reduced to the single name it denotes, or null.
 *
 * `Optional[Store]`, `list[Tool]`, `Store | None` and `"Store"` all denote one
 * subject type to a reader, and every one of them appears in the #52 subjects.
 * What is deliberately NOT reduced is a genuine union of two subject types
 * (`SignalRecord | GateRecord`): two names is not one name, and returning either
 * would be a guess. `None` is dropped from a union because `X | None` is an
 * optional `X`, which is what the declaration says.
 */
export const annotationName = (node: SyntaxNode | null): string | null => {
  if (node === null) return null;
  if (node.type === "type") return annotationName(namedChildren(node)[0] ?? null);
  if (node.type === "identifier") return node.text;
  if (node.type === "string") {
    // A forward reference is the declaration written as a string, and the string
    // has to be one bare dotted name or it is not a name this reader can use.
    const text = stringLiteral(node);
    return text !== null && /^[A-Za-z_][\w.]*$/.test(text) ? text.split(".").pop()! : null;
  }
  if (node.type === "attribute") {
    // `models.Store` denotes `Store`; the module half is resolved by the caller's
    // own import bindings, never by this reduction.
    return node.childForFieldName("attribute")?.text ?? null;
  }
  if (node.type === "generic_type" || node.type === "subscript") {
    // In a TYPE position the grammar reads `list[Tool]` as a `generic_type` whose
    // arguments sit in a `type_parameter`; in an EXPRESSION position the same
    // text is a `subscript`. Both spellings appear in the #52 subjects (an
    // annotation and a `TypeAlias` right-hand side), so both are read here.
    const head = namedChildren(node)[0];
    const container = annotationName(node.childForFieldName("value") ?? head ?? null);
    if (container === null) return null;
    const parameter = namedChildren(node).find((child) => child.type === "type_parameter");
    const elements = (parameter ? namedChildren(parameter) : namedChildren(node).slice(1)).filter(
      (child) => child.type !== "comment" && child.type !== "slice",
    );
    // Only the wrappers that denote the SAME OBJECT are unwrapped. `Optional[X]`
    // and `type[X]` are an `X` and the class `X` respectively, and a call written
    // on either is a call on `X`. A CONTAINER is not: `records: list[DecisionRecord]`
    // is a list, and reducing it to its element made `records.append(...)` read as
    // a missing `DecisionRecord.append` - a hole in a story that has none, and the
    // exact false gap this distinction exists to prevent. A container therefore
    // reduces to the container, which resolves as somebody else's type.
    const inner = elements[0];
    if (TRANSPARENT.has(container) && elements.length === 1 && inner !== undefined) {
      return annotationName(inner);
    }
    return container;
  }
  if (node.type === "binary_operator") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (node.childForFieldName("operator")?.text !== "|") return null;
    const leftName = right?.type === "none" ? annotationName(left) : null;
    if (leftName !== null) return leftName;
    return left?.type === "none" ? annotationName(right) : null;
  }
  return null;
};

/**
 * The annotation wrappers that denote the same object as their argument.
 *
 * Kept deliberately short. Every other subscripted annotation - `list`, `dict`,
 * `Sequence`, `Awaitable` - names a DIFFERENT object from its element, and a
 * receiver typed as the element would be a receiver typed as something it is not.
 */
const TRANSPARENT = new Set(["Optional", "type", "Type", "Final", "Annotated", "ClassVar"]);

/**
 * Every union member an annotation names, when it names more than one.
 *
 * `annotationName` refuses a genuine union because no single name is what it
 * denotes; this is the other question - WHICH names - and it is asked in exactly
 * one place: the note in `py-dispatch.ts` recording that a union type alias is
 * Python's `sealed`. `None` is dropped, so `A | B | None` is two members.
 */
export const unionMembers = (node: SyntaxNode | null): string[] => {
  if (node === null) return [];
  if (node.type === "type") return unionMembers(namedChildren(node)[0] ?? null);
  if (node.type === "parenthesized_expression") return unionMembers(namedChildren(node)[0] ?? null);
  if (node.type !== "binary_operator") {
    const single = annotationName(node);
    return single === null ? [] : [single];
  }
  if (node.childForFieldName("operator")?.text !== "|") return [];
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  const members = [
    ...(left?.type === "none" ? [] : unionMembers(left)),
    ...(right?.type === "none" ? [] : unionMembers(right)),
  ];
  return members.some((member) => member === "") ? [] : members;
};

/**
 * The root identifier a receiver expression is written on, or null.
 *
 * This is the decision the tracer actually makes at a call site, and #52's
 * measurement is classified by exactly this: what binds the ROOT of the receiver
 * expression. `a.b.c()` and `a[i].c()` are both rooted in `a`; `f().c()` is
 * rooted in the call, which no declaration in the calling file names.
 */
export const receiverRoot = (node: SyntaxNode | null): SyntaxNode | null => {
  let cur = node;
  while (cur) {
    if (cur.type === "parenthesized_expression") {
      cur = namedChildren(cur)[0] ?? null;
      continue;
    }
    if (cur.type === "attribute" || cur.type === "subscript") {
      cur = cur.childForFieldName("object") ?? cur.childForFieldName("value") ?? null;
      continue;
    }
    return cur;
  }
  return null;
};
