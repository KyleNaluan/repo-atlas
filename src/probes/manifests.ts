/**
 * One definition of "declared" for a build manifest, shared by the probe that
 * finds a divergence and the gate that re-checks it.
 *
 * The dependency-divergence probe decides a technology is undeclared by parsing
 * the declared dependency NAMES out of each manifest - artifactId elements,
 * gradle coordinates, package.json dependencies. If the gate then re-checked
 * with a looser proxy (a bare substring over the raw manifest text) a mention
 * inside an XML comment, a plugin name or a transitive coordinate would read as
 * "declared" and flip a correct finding into a spurious divergence - the engine
 * asserting a contradiction it did not establish. So the parse lives here and
 * both sides call it: the finding and its verification share one rule.
 */

export const MANIFESTS = ["pom.xml", "build.gradle", "build.gradle.kts", "package.json"];

/**
 * What one manifest declares, and whether the rule understood how to read it.
 *
 * `recognized` is the structural half of the W1 unification. Once the probe and
 * the gate share ONE definition of "declared", a rule that is wrong is wrong on
 * both sides and self-confirming: the probe emits "X is named but declared
 * nowhere" and the gate confirms it, purely because neither could parse the
 * manifest. So a manifest present but written in a form this rule cannot read
 * reports `recognized: false`, which the gate turns into an UNRESOLVED verdict -
 * the candidate is demoted, not confirmed. "I did not recognise any
 * declarations here" must never collapse into "nothing is declared here".
 */
export interface DeclaredDeps {
  names: Set<string>;
  recognized: boolean;
}

/** The standard Gradle configurations, groovy and kotlin-DSL alike. */
const GRADLE_CONFIGS = [
  "implementation",
  "api",
  "compileOnly",
  "compile",
  "runtimeOnly",
  "testImplementation",
  "testRuntimeOnly",
  "testCompileOnly",
  "annotationProcessor",
  "developmentOnly",
].join("|");

const GRADLE_DEP = new RegExp(String.raw`^\s*(?:${GRADLE_CONFIGS})\s*[('"]+([^'")]+)`, "gm");

/** Dependency names one manifest declares, however it spells them. */
export const declaredIn = (manifest: string, text: string): DeclaredDeps => {
  const names = new Set<string>();
  if (manifest === "package.json") {
    try {
      const parsed = JSON.parse(text) as { dependencies?: Record<string, string> };
      for (const name of Object.keys(parsed.dependencies ?? {})) names.add(name.toLowerCase());
      return { names, recognized: true };
    } catch {
      // A manifest that does not parse is not evidence a dependency is absent.
      return { names, recognized: false };
    }
  }
  if (manifest === "pom.xml") {
    // Scanning every artifactId in the raw file counts a mention in an XML
    // comment, a <plugin> or a <parent> as a declaration. Shared with the gate,
    // that is not a spurious divergence but the quieter FALSE NEGATIVE: a
    // commented-out or plugin-only dependency reads as declared and silently
    // suppresses a genuine finding. So strip comments and collect artifactIds
    // only from within <dependencies> blocks, where a real dependency lives.
    const stripped = text.replace(/<!--[\s\S]*?-->/g, "");
    for (const block of stripped.matchAll(/<dependencies\b[^>]*>([\s\S]*?)<\/dependencies>/g)) {
      for (const m of (block[1] ?? "").matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
        names.add((m[1] ?? "").toLowerCase());
      }
    }
    // A pom without a single artifactId is not maven as this rule understands it.
    return { names, recognized: /<artifactId>/.test(stripped) };
  }
  // Gradle (build.gradle or build.gradle.kts).
  for (const m of text.matchAll(GRADLE_DEP)) {
    const coord = (m[1] ?? "").split(":");
    if (coord[1]) names.add(coord[1].toLowerCase());
  }
  // A dependencies block whose lines this rule parsed none of is a declaration
  // syntax it does not know - unrecognized, not empty. No block at all declares
  // nothing here and is understood as such.
  const hasDepsBlock = /dependencies\s*\{/.test(text);
  return { names, recognized: !hasDepsBlock || names.size > 0 };
};

/** Every manifest in the tree, paired with what it declares and whether it read. */
export const declaredManifests = (ctx: {
  paths: string[];
  read: (path: string) => string | null;
}): { path: string; names: Set<string>; recognized: boolean }[] => {
  const out: { path: string; names: Set<string>; recognized: boolean }[] = [];
  for (const manifest of MANIFESTS) {
    const found = ctx.paths.filter((p) => p === manifest || p.endsWith(`/${manifest}`));
    for (const path of found) {
      const text = ctx.read(path);
      if (text !== null) {
        const { names, recognized } = declaredIn(manifest, text);
        out.push({ path, names, recognized });
      }
    }
  }
  return out;
};
