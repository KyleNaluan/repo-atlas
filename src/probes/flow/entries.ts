/**
 * Entry-point detection: where an execution story is allowed to begin.
 *
 * Two adapters live here in this phase - Spring HTTP routes and real Java `main`
 * methods - and both read declarations, never text. That is not fastidiousness:
 * a raw `main` grep over the reference subject found four entries where two
 * exist, because two generated harnesses carry a `main` inside a Java text
 * block. A string that looks like an entry point is not an entry point.
 *
 * Each detector reports what it found; whether the subject SUPPORTS it at all is
 * decided by the adapter's own applicability check, so "this subject runs no
 * Spring" and "Spring runs here and declares no route" stay different findings
 * (#5, and #6's refusal to communicate absence by silence).
 */
import { normalizedRoute } from "./route.js";
import { annotationNamed, type JavaIndex, type MethodSymbol, type TypeSymbol } from "./symbols.js";

export type HttpVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface HttpEntry {
  kind: "http";
  type: TypeSymbol;
  method: MethodSymbol;
  protocol: { method: HttpVerb; path: string };
}

export interface MainEntry {
  kind: "cli";
  type: TypeSymbol;
  method: MethodSymbol;
}

const VERB_ANNOTATION: Record<string, HttpVerb> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
};

const CONTROLLER_ANNOTATIONS = ["RestController", "Controller"];

/**
 * The path one mapping annotation declares.
 *
 * `path =`/`value =` are read by name first and a bare string literal second,
 * which is what the annotation means. Where the subject writes some other
 * attribute first, this and the gate's independent text re-derivation can
 * disagree - and a disagreement quarantines the Flow rather than rendering it,
 * which is the outcome that keeps a producer from being its own verifier.
 */
export const mappingPath = (args: string): string => {
  const named = /(?:^|[(,\s])(?:path|value)\s*=\s*(?:\{\s*)?["']([^"']*)["']/.exec(args);
  if (named?.[1] !== undefined) return named[1];
  const bare = /^\(\s*\{?\s*["']([^"']*)["']/.exec(args.trim());
  return bare?.[1] ?? "";
};

const REQUEST_METHOD = /RequestMethod\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/;

/** The HTTP verb a mapping annotation declares, or null when it declares several. */
const verbOf = (name: string, args: string): HttpVerb | null => {
  const direct = VERB_ANNOTATION[name];
  if (direct) return direct;
  if (name !== "RequestMapping") return null;
  // A @RequestMapping with no explicit method serves every verb. This phase does
  // not pick one for it: a route claim naming a verb the annotation never named
  // would be the engine asserting what it did not read.
  return (REQUEST_METHOD.exec(args)?.[1] as HttpVerb | undefined) ?? null;
};

/**
 * Every Spring HTTP handler the subject declares, class-level prefix composed.
 *
 * A controller is a type annotated `@RestController` or `@Controller`; a handler
 * is a method carrying a mapping annotation that names exactly one verb.
 */
export const httpEntries = (index: JavaIndex): HttpEntry[] => {
  const out: HttpEntry[] = [];
  for (const type of index.types) {
    if (!annotationNamed(type.annotations, ...CONTROLLER_ANNOTATIONS)) continue;
    const classMapping = annotationNamed(type.annotations, "RequestMapping");
    const prefix = classMapping ? mappingPath(classMapping.args) : "";
    for (const method of type.methods) {
      for (const annotation of method.annotations) {
        const verb = verbOf(annotation.name, annotation.args);
        if (!verb) continue;
        out.push({
          kind: "http",
          type,
          method,
          protocol: { method: verb, path: normalizedRoute(`${prefix}/${mappingPath(annotation.args)}`) },
        });
        break;
      }
    }
  }
  return out;
};

const MAIN_PARAMETER = /^String\s*(?:\[\s*\]|\.\.\.)$/;

/**
 * Every real `public static void main(String[])` the subject declares.
 *
 * The signature is checked in full against the declaration, which is what
 * separates a program entry point from a method that happens to be called main
 * and from generated source sitting inside a string.
 */
export const mainEntries = (index: JavaIndex): MainEntry[] => {
  const out: MainEntry[] = [];
  for (const type of index.types) {
    for (const method of type.methods) {
      if (method.name !== "main") continue;
      if (!method.modifiers.includes("static") || !method.modifiers.includes("public")) continue;
      if (method.returns !== null) continue;
      const only = method.params.length === 1 ? method.params[0] : undefined;
      if (!only || !MAIN_PARAMETER.test(only.declared.replace(/\s+/g, " ").trim())) continue;
      out.push({ kind: "cli", type, method });
    }
  }
  return out;
};
