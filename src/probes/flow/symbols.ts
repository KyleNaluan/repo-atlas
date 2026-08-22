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
import { SPRING_STEREOTYPES } from "./stereotype.js";

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
  /**
   * The same members, keeping the type EXACTLY as declared - generics included.
   *
   * `fields` reduces `List<Grader>` to `List`, which is what a receiver lookup
   * wants. Closed-set dispatch wants the other half: the element type a Spring
   * collection injection declares is the interface whose bean set the container
   * closes, and that only survives in the unreduced text.
   */
  fieldsDeclared: Map<string, string>;
  /**
   * Whether the container manages this type: it carries a Spring stereotype.
   *
   * This is the architectural granularity of the rendered figure. A bean is a
   * component the subject's own wiring declares to be a part; a plain helper
   * class is an implementation detail of whichever bean calls it. The reference
   * artifact's boxes are exactly this set, which is why the compression below
   * uses it rather than a package or a heuristic.
   */
  bean: boolean;
  methods: MethodSymbol[];
  line_start: number;
  /** The last line of the declaration header: annotations, name and supertypes. */
  header_line_end: number;
  line_end: number;
}

export interface JavaIndex {
  /** Every production type in the subject, keyed by simple name. Several entries means ambiguous. */
  bySimpleName: Map<string, TypeSymbol[]>;
  /**
   * The same types keyed by their simple-name PATH within a file (`Verdict.Outcome`).
   *
   * A nested type is named by its enclosing type at the call site, and reducing
   * that to `Outcome` makes it collide with every other nested `Outcome` in the
   * subject. Keeping both keys lets a qualified declaration resolve exactly where
   * a bare one has to fail closed.
   */
  byQualified: Map<string, TypeSymbol[]>;
  types: TypeSymbol[];
  /** Production Java paths that were indexed, in tree order. */
  paths: string[];
  /**
   * Per file: the simple name each single-type import binds, and to what.
   *
   * Without this a subject type shadows every library type that shares its simple
   * name. The reference subject declares `Grading.ResultSet`, and a file importing
   * `java.sql.ResultSet` was consequently traced as if its JDBC result set were
   * that record - a story about a program that does not exist. An import is the
   * file's own statement of what a name means, so it is read rather than guessed.
   */
  importsByPath: Map<string, Map<string, string>>;
  /** Per file: its declared package. */
  packageByPath: Map<string, string>;
  /** Every package the subject itself declares. */
  packages: Set<string>;
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
const fieldsOf = (
  type: SyntaxNode,
  methods: MethodSymbol[],
  typeName: string,
): { simple: Map<string, string>; declared: Map<string, string> } => {
  const seen = new Map<string, string>();
  const conflicting = new Set<string>();
  const remember = (name: string, declared: string): void => {
    const previous = seen.get(name);
    if (previous !== undefined && previous !== declared) conflicting.add(name);
    seen.set(name, declared);
  };
  const body = type.childForFieldName("body");
  // Only this type's own fields, exactly as methodsOf scopes its members: a field
  // declared in a nested type belongs to that type, not to the one enclosing it.
  // A receiver typed from a declaration the calling scope does not actually have
  // is worse than an untyped one, because the gate re-types receivers by scanning
  // the whole file and would confirm the same wrong attribution rather than catch
  // it - one of the few places producer and gate can agree and both be wrong.
  const ownScope = [...enclosingTypeNames(type), nameOf(type) ?? ""].join(".");
  for (const field of body ? findAll(body, "field_declaration") : []) {
    if (enclosingTypeNames(field).join(".") !== ownScope) continue;
    const declared = field.childForFieldName("type")?.text;
    if (!declared) continue;
    for (const declarator of findAll(field, "variable_declarator")) {
      const name = nameOf(declarator);
      if (name) remember(name, declared);
    }
  }
  for (const method of methods) {
    if (method.name !== typeName) continue;
    for (const param of method.params) if (param.name) remember(param.name, param.declared);
  }
  // A record's components are fields for every purpose a trace cares about.
  const params = type.type === "record_declaration" ? paramsOf(type) : [];
  for (const param of params) if (param.name) remember(param.name, param.declared);
  for (const name of conflicting) seen.delete(name);
  const simple = new Map<string, string>();
  for (const [name, declared] of seen) simple.set(name, simpleTypeName(declared));
  return { simple, declared: seen };
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

/** `import a.b.C;` -> `C` => `a.b.C`. Wildcard imports bind no simple name. */
const importsIn = (root: SyntaxNode): Map<string, string> => {
  const out = new Map<string, string>();
  for (const declaration of findAll(root, "import_declaration")) {
    const text = declaration.text.replace(/\s+/g, " ").replace(/^import\s+(static\s+)?/, "").replace(/;$/, "");
    if (text.endsWith("*")) continue;
    const simple = text.split(".").pop();
    if (simple) out.set(simple, text);
  }
  return out;
};

const packageIn = (root: SyntaxNode): string => {
  const declaration = findAll(root, "package_declaration")[0];
  if (!declaration) return "";
  return declaration.text.replace(/^package\s+/, "").replace(/;$/, "").trim();
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
    const annotations = annotationsOf(node);
    const fields = fieldsOf(node, methods, name);
    out.push({
      name,
      qualified,
      path,
      kind,
      modifiers: modifiersOf(node),
      supertypes: supertypeNamesOf(node),
      annotations,
      fields: fields.simple,
      fieldsDeclared: fields.declared,
      bean: annotations.some((a) => SPRING_STEREOTYPES.includes(a.name)),
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
    const importsByPath = new Map<string, Map<string, string>>();
    const packageByPath = new Map<string, string>();
    const packages = new Set<string>();
    for (const path of paths) {
      const root = await ctx.parse(path);
      if (root === null) continue;
      importsByPath.set(path, importsIn(root));
      const pkg = packageIn(root);
      packageByPath.set(path, pkg);
      if (pkg) packages.add(pkg);
      types.push(...typesIn(root, path));
    }
    const bySimpleName = new Map<string, TypeSymbol[]>();
    const byQualified = new Map<string, TypeSymbol[]>();
    for (const type of types) {
      bySimpleName.set(type.name, [...(bySimpleName.get(type.name) ?? []), type]);
      byQualified.set(type.qualified, [...(byQualified.get(type.qualified) ?? []), type]);
    }
    return { bySimpleName, byQualified, types, paths, importsByPath, packageByPath, packages };
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
export const uniqueType = (index: JavaIndex, simple: string, fromPath?: string): TypeSymbol | null => {
  // A name the calling file imported means what the import says it means. This
  // both rules OUT a library type that shares a subject type's simple name, and
  // rules IN the one subject type an otherwise ambiguous simple name denotes.
  const root = qualifiedTypeName(simple).split(".")[0] ?? "";
  const imported = fromPath === undefined ? undefined : index.importsByPath.get(fromPath)?.get(root);
  if (imported !== undefined) {
    const pkg = imported.slice(0, imported.length - root.length - 1);
    if (!index.packages.has(pkg)) return null;
    const nested = qualifiedTypeName(simple);
    const byQualified = index.byQualified.get(nested) ?? [];
    const inPackage = byQualified.filter((type) => index.packageByPath.get(type.path) === pkg);
    return inPackage.length === 1 ? inPackage[0]! : null;
  }
  // A name written out in full says its own package, and a package the subject
  // does not declare is somebody else's type however familiar the simple name is.
  const written = simple.replace(/<[\s\S]*$/, "").replace(/\[\s*\]/g, "").trim();
  if (/^[a-z][\w$]*(\.[\w$]+)+$/.test(written)) {
    const pkg = written.split(".").filter((piece) => /^[a-z]/.test(piece)).join(".");
    if (!index.packages.has(pkg)) return null;
  }
  // A qualified name is the more specific statement, so it is tried first: a
  // declaration that wrote `Verdict.Outcome` named exactly one nested type, and
  // reducing it to `Outcome` would throw that away and collide with every other
  // nested `Outcome` in the subject.
  const qualified = qualifiedTypeName(simple);
  if (qualified.includes(".")) {
    const nested = index.byQualified.get(qualified) ?? [];
    if (nested.length === 1) return nested[0]!;
  }
  const found = index.bySimpleName.get(simpleTypeName(simple)) ?? [];
  return found.length === 1 ? found[0]! : null;
};

/**
 * Whether the calling file's own imports say a simple name is somebody else's
 * type - or a subject type this index cannot name uniquely.
 *
 * The distinction matters at the call site: a library receiver is untraced in
 * silence, while a subject receiver this phase declines to type must be named.
 */
export const importedForeign = (index: JavaIndex, fromPath: string, simple: string): boolean => {
  const root = qualifiedTypeName(simple).split(".")[0] ?? "";
  const imported = index.importsByPath.get(fromPath)?.get(root);
  if (imported === undefined) return false;
  return !index.packages.has(imported.slice(0, imported.length - root.length - 1));
};

/**
 * A declared type name reduced to the simple-name PATH a nested type is known by
 * within its file: package qualification dropped, the enclosing-type prefix kept.
 *
 * `com.sweprep.grader.Verdict.Outcome` and `Verdict.Outcome` both denote the same
 * nested type; `Outcome` alone denotes any of them. The heuristic that separates
 * a package segment from an enclosing type is Java's own naming convention -
 * package segments are lower case - and it is used only to make a MORE specific
 * match, never to widen one.
 */
export const qualifiedTypeName = (declared: string): string => {
  const withoutGenerics = declared.replace(/<[\s\S]*$/, "").trim();
  const withoutArray = withoutGenerics.replace(/\[\s*\]/g, "").trim();
  return withoutArray
    .split(".")
    .filter((piece) => piece.length > 0 && !/^[a-z]/.test(piece))
    .join(".");
};

/** Whether a simple name denotes more than one subject type. */
export const isAmbiguousType = (index: JavaIndex, simple: string): boolean =>
  (index.bySimpleName.get(simpleTypeName(simple)) ?? []).length > 1;

/**
 * Every subject type that implements or extends `base`, transitively.
 *
 * Supertypes are recorded by simple name, so this walks the whole index rather
 * than an inheritance map: the question "what could this interface be at
 * runtime?" has to be answered over the WHOLE subject or not at all, since a
 * missed implementation would make an open set look closed - the one error a
 * closed-set dispatch must never make.
 */
export const implementationsOf = (index: JavaIndex, base: TypeSymbol): TypeSymbol[] => {
  const found: TypeSymbol[] = [];
  const named = new Set<string>([base.name]);
  // Iterate to a fixed point: an implementation may be reached through an
  // intermediate abstract class declared later in the tree than its subclass.
  for (let changed = true; changed; ) {
    changed = false;
    for (const type of index.types) {
      if (found.includes(type) || type === base) continue;
      if (![...type.supertypes].some((s) => named.has(simpleTypeName(s)))) continue;
      found.push(type);
      named.add(type.name);
      changed = true;
    }
  }
  return found;
};

export const annotationNamed = (
  annotations: AnnotationRef[],
  ...names: string[]
): AnnotationRef | null => annotations.find((a) => names.includes(a.name)) ?? null;

/**
 * The single type argument a declared collection or map type carries, or null.
 *
 * Spring closes an implementation set two ways a call site can read: a `List<T>`
 * of every `T` bean, and a `Map<String, T>` keyed by bean name. Both name `T` in
 * the declaration, which is the only place the container's wiring is visible to
 * a static reader.
 */
export const injectedElementType = (declared: string): string | null => {
  const generics = /<([^<>]*(?:<[^<>]*>)?[^<>]*)>\s*$/.exec(declared.trim());
  if (!generics?.[1]) return null;
  const args = generics[1].split(",").map((piece) => piece.trim()).filter((piece) => piece.length > 0);
  const last = args[args.length - 1];
  if (args.length > 2 || last === undefined || last.includes("<")) return null;
  return simpleTypeName(last);
};
