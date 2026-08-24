/**
 * One definition of what a Python file is IMPORTABLE AS, shared by the Flow
 * producer and the Flow gate (#52).
 *
 * Same arrangement and same reason as `route.ts`'s one definition of "the same
 * route" and `manifests.ts`'s one definition of "declared". The producer resolves
 * `decision_logs.query_rows(...)` by reading the importing file's parse tree; the
 * gate re-derives it by matching import statements in the pinned blob. Those two
 * derivations are deliberately INDEPENDENT - that is what makes the gate a check
 * rather than an echo - but they must agree on what a module is CALLED, or a
 * correct arrow comes back contradicted purely because one side read
 * `ds_agent.agent.graph` and the other `src.ds_agent.agent.graph`.
 *
 * Python's own rule is applied rather than approximated: a module's import name
 * starts at the first ancestor directory that is NOT a package, because that is
 * the directory `sys.path` holds. The two #52 subjects are laid out differently
 * and both are read correctly by it - ftb declares `src/__init__.py` so its
 * modules import as `src.decision_log.reader`, while dsa's `src/` is a bare
 * source root (`[tool.setuptools.packages.find] where = ["src"]`) so its modules
 * import as `ds_agent.agent.graph`. The repo-relative dotted path is registered
 * too, and only when it differs, because a namespace package (PEP 420, no
 * `__init__.py` anywhere) is importable from the repo root and would otherwise
 * have no name at all.
 */

/** The directories that declare themselves packages by holding an `__init__.py`. */
export const packageDirsIn = (paths: string[]): Set<string> => {
  const dirs = new Set<string>();
  for (const path of paths) {
    if (!path.endsWith("__init__.py")) continue;
    if (path === "__init__.py") {
      dirs.add("");
      continue;
    }
    if (!path.endsWith("/__init__.py")) continue;
    dirs.add(path.slice(0, path.length - "/__init__.py".length));
  }
  return dirs;
};

/** The dotted module names one `.py` path can be imported as. */
export const dottedNamesOf = (path: string, packageDirs: Set<string>): string[] => {
  const pieces = path.replace(/\.py$/, "").split("/");
  const isInit = pieces[pieces.length - 1] === "__init__";
  const modulePieces = isInit ? pieces.slice(0, -1) : pieces;
  if (modulePieces.length === 0) return [];
  let start = 0;
  for (let i = 0; i < modulePieces.length - (isInit ? 0 : 1); i += 1) {
    if (packageDirs.has(modulePieces.slice(0, i + 1).join("/"))) {
      start = i;
      break;
    }
    start = i + 1;
  }
  const names = new Set<string>([modulePieces.join(".")]);
  if (start > 0) names.add(modulePieces.slice(start).join("."));
  return [...names];
};

/**
 * The name a module pseudo-type is known by - the bare last segment of its
 * import name.
 *
 * This is what `TypeSymbol.qualified` holds for a module, so it is also what a
 * claim's `owner` carries when the target is a module-level `def`. The gate reads
 * it back off the claim's PATH and compares, which is how it tells a module-level
 * claim (check for a `def` at column zero) from a class-level one (check for a
 * `class` and an indented `def` inside it) without the claim declaring which.
 */
export const moduleOwnerName = (path: string): string => {
  const dotted = path.replace(/\.py$/, "").replace(/\/__init__$/, "").split("/").join(".");
  return dotted.split(".").pop() ?? dotted;
};
