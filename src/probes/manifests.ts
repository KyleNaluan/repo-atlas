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

/** Dependency names one manifest declares, however it spells them. */
export const declaredIn = (manifest: string, text: string): Set<string> => {
  const names = new Set<string>();
  if (manifest === "package.json") {
    try {
      const parsed = JSON.parse(text) as { dependencies?: Record<string, string> };
      for (const name of Object.keys(parsed.dependencies ?? {})) names.add(name.toLowerCase());
    } catch {
      /* a manifest that does not parse is not a divergence finding */
    }
    return names;
  }
  for (const m of text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
    names.add((m[1] ?? "").toLowerCase());
  }
  for (const m of text.matchAll(/^\s*(?:implementation|api|compile)\s*[('"]+([^'")]+)/gm)) {
    const coord = (m[1] ?? "").split(":");
    if (coord[1]) names.add(coord[1].toLowerCase());
  }
  return names;
};

/** Every manifest in the tree, paired with the dependency names it declares. */
export const declaredManifests = (ctx: {
  paths: string[];
  read: (path: string) => string | null;
}): { path: string; names: Set<string> }[] => {
  const out: { path: string; names: Set<string> }[] = [];
  for (const manifest of MANIFESTS) {
    const found = ctx.paths.filter((p) => p === manifest || p.endsWith(`/${manifest}`));
    for (const path of found) {
      const text = ctx.read(path);
      if (text !== null) out.push({ path, names: declaredIn(manifest, text) });
    }
  }
  return out;
};
