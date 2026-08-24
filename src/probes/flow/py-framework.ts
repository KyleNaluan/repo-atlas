/**
 * One definition of "the subject runs this Python framework", shared by the
 * adapters that need it and, where the answer is load-bearing, by the gate (#52).
 *
 * Same arrangement and same reason as `stereotype.ts:declaresSpring`: the
 * toolchain test above it answers "does this subject have Python", and this
 * answers the framework question, so "no FastAPI here" and "FastAPI runs here and
 * declares no route" stay two different findings on the run's own report (#5,
 * #6). Two adapters keeping two copies of "does this subject import fastapi"
 * would eventually answer differently.
 *
 * Both read IMPORTS rather than a text scan, because an import is the file's own
 * statement and a mention in a docstring is not. `withoutComments` is not enough
 * on its own here - a framework named inside a string literal is still not an
 * import - so the test is anchored to the statement keyword.
 */

const importsModule = (source: string, root: string): boolean =>
  new RegExp(String.raw`^\s*(?:from\s+${root}(?:\.[\w.]+)?\s+import\b|import\s+${root}\b)`, "m").test(
    source,
  );

const declaresModule = (
  paths: string[],
  read: (path: string) => string | null,
  root: string,
): boolean => paths.some((path) => importsModule(read(path) ?? "", root));

/** Whether the subject imports FastAPI at all - the HTTP adapter's prerequisite. */
export const declaresFastAPI = (paths: string[], read: (path: string) => string | null): boolean =>
  declaresModule(paths, read, "fastapi");

/** Whether the subject imports LangGraph at all - the pipeline adapter's prerequisite. */
export const declaresLangGraph = (paths: string[], read: (path: string) => string | null): boolean =>
  declaresModule(paths, read, "langgraph");
