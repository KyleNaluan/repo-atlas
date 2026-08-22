/**
 * The subject's Java symbol index: the shared typed graph the Flow entry
 * detectors and the tracer both read (#35, accepted design section 5.3).
 *
 * It is built from parse trees, never from text scans, because the questions the
 * tracer asks are structural and the scout measured what text costs: a raw grep
 * for `main` found four entry points on the reference subject where only two
 * exist, because two generated harnesses carry `main` inside a Java text block.
 * Syntax is the difference between an entry point and a string.
 *
 * The index is memoised per probe context, so the two adapters registered on top
 * of it - Spring routes and real `main` methods - share one parse of the tree
 * rather than paying for it twice. It stays a pure function over the pinned tree:
 * no network, no model, nothing outside what the probe context can read (#5).
 */
import { isSourceFile } from "../../harvest/tree.js";
import {
  endLineOf,
  enclosingTypeNames,
  findAll,
  lineOf,
  nameOf,
  supertypeNamesOf,
  walk,
  type SyntaxNode,
} from "../java.js";
import type { ProbeContext } from "../types.js";

export interface AnnotationRef {
  name: string;
  /** The raw argument text, parentheses included, or "" for a marker annotation. */
  args: string;
}

export interface ParamRef {
  /** The declared type reduced to the simple name a call site would name it by. */
  type: string;
  /** The type exactly as the declaration wrote it, array and varargs marks kept. */
  declared: string;
  name: string;
}

export interface MethodSymbol {
  name: string;
  /** The declaring type's simple name path within its file (`Outer.Inner`). */
  owner: string;
  path: string;
  params: ParamRef[];
  /** The declared return type's simple name; null for `void` and constructors. */
  returns: string | null;
  annotations: AnnotationRef[];
  modifiers: string[];
  body: SyntaxNode | null;
  line_start: number;
  line_end: number;
}

export type TypeKind = "class" | "interface" | "record" | "enum" | "annotation";

export interface TypeSymbol {
  /** Simple name. */
  name: string;
  /** Simple-name path within the file (`Outer.Inner`), which is how a method names its owner. */
  qualified: string;
  path: string;
  kind: TypeKind;
  modifiers: string[];
  supertypes: Set<string>;
  annotations: AnnotationRef[];
  /** Field and constructor-injected member name -> declared type simple name. */
  fields: Map<string, string>;
  methods: MethodSymbol[];
  line_start: number;
  /** The last line of the declaration header: annotations, name and supertypes. */
  header_line_end: number;
  line_end: number;
}

export interface JavaIndex {
  /** Every production type in the subject, keyed by simple name. Several entries means ambiguous. */
  bySimpleName: Map<string, TypeSymbol[]>;
  types: TypeSymbol[];
  /** Production Java paths that were indexed, in tree order. */
  paths: string[];
}

const TYPE_KIND: Record<string, TypeKind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  record_declaration: "record",
  enum_declaration: "enum",
  annotation_type_declaration: "annotation",
};

/** A declared type name reduced to the simple name a call site would name it by. */
export const simpleTypeName = (declared: string): string => {
  const withoutGenerics = declared.replace(/<[\s\S]*$/, "").trim();
  const withoutArray = withoutGenerics.replace(/\[\s*\]/g, "").trim();
  const pieces = withoutArray.split(".");
  return (pieces[pieces.length - 1] ?? withoutArray).trim();
};

const annotationsOf = (node: SyntaxNode): AnnotationRef[] => {
  const out: AnnotationRef[] = [];
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (!child || child.type !== "modifiers") continue;
    for (let j = 0; j < child.childCount; j += 1) {
      const mod = child.child(j);
      if (!mod) continue;
      if (mod.type === "marker_annotation") {
        const name = nameOf(mod);
        if (name) out.push({ name, args: "" });
      }
      if (mod.type === "annotation") {
        const name = nameOf(mod);
        if (name) out.push({ name, args: mod.childForFieldName("arguments")?.text ?? "" });
      }
    }
  }
  return out;
};

const modifiersOf = (node: SyntaxNode): string[] => {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child?.type === "modifiers") {
      return child.text
        .split(/\s+/)
        .filter((word) => /^[a-z]+$/.test(word));
    }
  }
  return [];
};

const paramsOf = (method: SyntaxNode): ParamRef[] => {
  const params = method.childForFieldName("parameters");
  if (!params) return [];
  const out: ParamRef[] = [];
  for (let i = 0; i < params.namedChildCount; i += 1) {
    const p = params.namedChild(i);
    if (!p || (p.type !== "formal_parameter" && p.type !== "spread_parameter")) continue;
    const type = p.childForFieldName("type")?.text;
    const name = p.childForFieldName("name")?.text;
    if (!type) continue;
    // A varargs parameter writes its array-ness in the node rather than the type.
    const declared = p.type === "spread_parameter" ? `${type}...` : type;
    out.push({ type: simpleTypeName(type), declared, name: name ?? "" });
  }
  return out;
};

/**
 * The members a call site can use as a receiver: declared fields, and the
 * parameters of every constructor.
 *
 * Constructor parameters are included because Spring's recommended wiring is
 * constructor injection, and the field it assigns is usually declared with the
 * same type anyway; taking both keeps a receiver resolvable whether the subject
 * writes `private final X x;` or takes `X x` and assigns it. A name declared
 * twice with different types is dropped rather than guessed - an ambiguous
 * receiver must not resolve to whichever declaration was read last.
 */
const fieldsOf = (type: SyntaxNode, methods: MethodSymbol[], typeName: string): Map<string, string> => {
  const seen = new Map<string, string>();
  const conflicting = new Set<string>();
  const remember = (name: string, declared: string): void => {
    const previous = seen.get(name);
    if (previous !== undefined && previous !== declared) conflicting.add(name);
    seen.set(name, declared);
  };
  const body = type.childForFieldName("body");
  for (const field of body ? findAll(body, "field_declaration") : []) {
    const declared = field.childForFieldName("type")?.text;
    if (!declared) continue;
    for (const declarator of findAll(field, "variable_declarator")) {
      const name = nameOf(declarator);
      if (name) remember(name, simpleTypeName(declared));
    }
  }
  for (const method of methods) {
    if (method.name !== typeName) continue;
    for (const param of method.params) if (param.name) remember(param.name, param.type);
  }
  // A record's components are fields for every purpose a trace cares about.
  const params = type.type === "record_declaration" ? paramsOf(type) : [];
  for (const param of params) if (param.name) remember(param.name, param.type);
  for (const name of conflicting) seen.delete(name);
  return seen;
};

const methodsOf = (type: SyntaxNode, path: string, owner: string): MethodSymbol[] => {
  const body = type.childForFieldName("body");
  if (!body) return [];
  const out: MethodSymbol[] = [];
  for (const kind of ["method_declaration", "constructor_declaration"]) {
    for (const method of findAll(body, kind)) {
      // Only this type's own members: a nested type's methods belong to it.
      const enclosing = enclosingTypeNames(method).join(".");
      if (enclosing !== [...enclosingTypeNames(type), nameOf(type) ?? ""].join(".")) continue;
      const name = nameOf(method);
      if (!name) continue;
      const returned = method.childForFieldName("type")?.text;
      out.push({
        name,
        owner,
        path,
        params: paramsOf(method),
        returns:
          kind === "constructor_declaration" || returned === undefined || returned === "void"
            ? null
            : simpleTypeName(returned),
        annotations: annotationsOf(method),
        modifiers: modifiersOf(method),
        body: method.childForFieldName("body"),
        line_start: lineOf(method),
        line_end: endLineOf(method),
      });
    }
  }
  return out;
};

const typesIn = (root: SyntaxNode, path: string): TypeSymbol[] => {
  const out: TypeSymbol[] = [];
  walk(root, (node) => {
    const kind = TYPE_KIND[node.type];
    if (!kind) return;
    const name = nameOf(node);
    if (!name) return;
    const qualified = [...enclosingTypeNames(node), name].join(".");
    const methods = methodsOf(node, path, qualified);
    out.push({
      name,
      qualified,
      path,
      kind,
      modifiers: modifiersOf(node),
      supertypes: supertypeNamesOf(node),
      annotations: annotationsOf(node),
      fields: fieldsOf(node, methods, name),
      methods,
      line_start: lineOf(node),
      header_line_end: lineOf(node.childForFieldName("body") ?? node),
      line_end: endLineOf(node),
    });
  });
  return out;
};

const CACHE = new WeakMap<ProbeContext, Promise<JavaIndex>>();

/**
 * The subject's production Java types, parsed once per run.
 *
 * Test sources are excluded through `isSourceFile`, the harvest stage's shared
 * definition: a controller a test declares is not a route the subject serves,
 * and a test double calling a service is not the subject's own execution story.
 */
export const javaIndex = (ctx: ProbeContext): Promise<JavaIndex> => {
  const cached = CACHE.get(ctx);
  if (cached) return cached;
  const built = (async (): Promise<JavaIndex> => {
    const paths = ctx.paths.filter((p) => p.endsWith(".java") && isSourceFile(p));
    const types: TypeSymbol[] = [];
    for (const path of paths) {
      const root = await ctx.parse(path);
      if (root === null) continue;
      types.push(...typesIn(root, path));
    }
    const bySimpleName = new Map<string, TypeSymbol[]>();
    for (const type of types) {
      bySimpleName.set(type.name, [...(bySimpleName.get(type.name) ?? []), type]);
    }
    return { bySimpleName, types, paths };
  })();
  CACHE.set(ctx, built);
  return built;
};

/**
 * The one subject type a simple name denotes, or null.
 *
 * Two types sharing a simple name in different packages are NOT resolved by
 * picking one: the tracer must be able to say "this receiver is a subject type I
 * cannot name uniquely" and fail closed, rather than trace a call into whichever
 * package sorted first.
 */
export const uniqueType = (index: JavaIndex, simple: string): TypeSymbol | null => {
  const found = index.bySimpleName.get(simpleTypeName(simple)) ?? [];
  return found.length === 1 ? found[0]! : null;
};

/** Whether a simple name denotes more than one subject type. */
export const isAmbiguousType = (index: JavaIndex, simple: string): boolean =>
  (index.bySimpleName.get(simpleTypeName(simple)) ?? []).length > 1;

export const annotationNamed = (
  annotations: AnnotationRef[],
  ...names: string[]
): AnnotationRef | null => annotations.find((a) => names.includes(a.name)) ?? null;
