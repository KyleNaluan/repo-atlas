/**
 * One definition of "this systemd unit launches that program", shared by the CLI
 * Flow adapter, the systemd adapter and the Flow gate (#35, PR 8).
 *
 * A unit file is the one entry surface in this producer that is not source code,
 * and it is read the way `http-client.ts` reads TypeScript: LEXICALLY, with
 * everything that cannot execute removed first. A systemd unit's comments start
 * with `#` or `;` at the beginning of a line, a directive continues while its
 * line ends in a backslash, and directives outside `[Service]` are a different
 * unit section's business. Nothing here parses a shell.
 *
 * What it establishes is deliberately narrow, for the reason the design gives
 * (report 5.2): "a timer file without a resolvable invoked command is an entry
 * candidate that cannot complete, not a Flow". The only launch this reader will
 * pin is one where the ExecStart names a FULLY QUALIFIED class - the way the JVM
 * itself needs it named - that the subject declares with a real `main`. Anything
 * else is a named cut: a bare word in an ExecStart is a program on `PATH` at
 * least as often as it is a class, and a jar or a wrapper script hides its entry
 * point in a manifest or a shell this engine does not read.
 */

/** Every systemd unit file the subject declares, of any type. */
export const UNIT_PATH = /\.(?:service|timer|socket|path|mount|target)$/;

/** Only a `.service` unit declares a program to start. */
export const SERVICE_UNIT_PATH = /\.service$/;

export interface ExecStartDirective {
  /** The command line, continuations joined, exactly as the unit declares it. */
  command: string;
  /** 1-based line span of the directive, continuations included. */
  line_start: number;
  line_end: number;
}

/** The unit's own name, as systemd would refer to it. */
export const unitName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Join the `\`-continued lines of an ExecStart value that begins at `lines[i]`
 * and normalize it, returning the command and the 1-based line it ends on.
 *
 * This is the ONE definition of "what an ExecStart directive's value is": the
 * continuation join and the `-`, `+`, `!`, `@` prefix stripping systemd allows.
 * Both the section-aware whole-file reader below and the span reader E2 uses go
 * through it, so the audit, the producer and the gate cannot drift on how a
 * wrapped directive reads. The prefixes are stripped because they modify how
 * systemd runs the command rather than what the command is.
 */
const readExecStartValue = (
  lines: string[],
  i: number,
  value: string,
): { command: string; line_end: number } => {
  let command = value;
  let end = i;
  while (command.endsWith("\\") && end + 1 < lines.length) {
    end += 1;
    command = `${command.slice(0, -1)} ${lines[end]!.trim()}`;
  }
  return {
    command: command.replace(/^[-+!@]+/, "").replace(/\s+/g, " ").trim(),
    line_end: end + 1,
  };
};

/**
 * The `ExecStart=` a unit declares in its `[Service]` section, or null.
 *
 * The first one wins, which is systemd's own rule for a non-oneshot service and
 * the only one this reader needs: a unit that declares several is a unit whose
 * program this returns the first of, and the gate re-derives the same first one
 * from the same blob, so the two sides cannot disagree about which.
 *
 * The section rule is load-bearing and is NOT shared with the span reader below:
 * this reader sees the whole unit precisely so a directive in another section or
 * behind a comment cannot be taken.
 */
export const execStart = (source: string): ExecStartDirective | null => {
  const lines = source.split("\n");
  let section = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed === "") continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1]!.toLowerCase();
      continue;
    }
    const directive = /^ExecStart\s*=\s*(.*)$/.exec(trimmed);
    if (!directive || section !== "service") continue;
    const { command, line_end } = readExecStartValue(lines, i, directive[1]!);
    return { command, line_start: i + 1, line_end };
  }
  return null;
};

/**
 * The ExecStart command in an arbitrary span, continuations joined, or null.
 *
 * E2 (the audit's present-tense claim check) sees only the link's CITED EVIDENCE
 * SPANS, not the whole unit file, so a span may not carry the `[Service]` header
 * `execStart` requires - which is why this reader drops the section rule while
 * still sharing the continuation join and normalization through
 * `readExecStartValue`. Comment lines are dropped, the same as the whole-file
 * reader; the first directive the span names wins.
 */
export const execStartInSpan = (span: string): string | null => {
  const lines = span.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed === "") continue;
    const directive = /^ExecStart\s*=\s*(.*)$/.exec(trimmed);
    if (!directive) continue;
    return readExecStartValue(lines, i, directive[1]!).command;
  }
  return null;
};

const FULLY_QUALIFIED = /^[a-z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\.[A-Z][\w$]*$/;
const SIMPLE_CLASS = /^[A-Z][\w$]*$/;

/**
 * Split a command into the tokens a class name could be, quotes respected.
 *
 * A token carrying a path separator, an option dash or a file extension is not a
 * class reference, whatever its shape; everything else is handed back for the
 * caller to test against what the subject actually declares.
 */
const tokensOf = (command: string): string[] =>
  (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => token !== "" && !token.startsWith("-") && !token.includes("/"));

/**
 * Every fully-qualified class name an ExecStart command names.
 *
 * This is the ONE shared definition the producer and the gate both resolve
 * against, and the reason the stitch is restricted to qualified names: a
 * qualified name is unique in a Java subject by construction, so the gate can
 * confirm the launch target by rereading one file rather than by re-enumerating
 * every `main` in the tree. `.jar` and other extensioned tokens are excluded by
 * the capitalised-last-segment rule they fail.
 */
export const launchClassTokens = (command: string): string[] =>
  [...new Set(tokensOf(command).filter((token) => FULLY_QUALIFIED.test(token)))];

/**
 * Every bare capitalised word an ExecStart names.
 *
 * Not a launch target - this is what the systemd adapter uses to say WHY it
 * refused one. A unit whose ExecStart says `AuthorContentCli` may well mean the
 * subject's class of that name, but a bare word in a command line is a program
 * name as often as a class name, and picking would be the producer resolving
 * further than the gate can re-resolve.
 */
export const bareClassTokens = (command: string): string[] =>
  [...new Set(tokensOf(command).filter((token) => SIMPLE_CLASS.test(token)))];

/**
 * What every `.service` unit in the subject launches, and what it does not.
 *
 * The shape mirrors `clientIndex` in `http-client.ts` deliberately, because the
 * problem is the same one: an adapter that OWNS an entry (the CLI adapter here,
 * the route adapter there) needs the stitched half, and the adapter that reads
 * the other language needs the half that could not be stitched, so that a seam
 * this engine failed to cross is reported by name instead of vanishing.
 *
 * Every refusal below carries a kind token, and each is a genuinely different
 * fact about the subject: a unit with no `ExecStart`, a command that names a
 * class this reader will not pin without a package, and a command that names no
 * class at all - a wrapper script, a jar whose main class lives in a manifest, a
 * binary. The reference subject is the third of those.
 */
export type UnitGapKind = "no_exec_start" | "ambiguous_exec_target" | "unresolved_exec_target";

export interface UnitLaunch {
  path: string;
  unit: string;
  exec: ExecStartDirective;
  /** The fully-qualified class the command names, which the subject declares with a main. */
  target: string;
  /** Where that main is declared. */
  entry: { path: string; type: string };
}

export interface UnitGap {
  path: string;
  unit: string;
  kind: UnitGapKind;
  detail: string;
  /** The directive that could not be followed; absent when there is none. */
  exec: ExecStartDirective | null;
}

/**
 * Resolve each service unit against the subject's own declared main methods.
 *
 * `mains` is the CLI adapter's own inventory - real `public static void
 * main(String[])` declarations off the parse tree, never a text match - keyed by
 * the fully-qualified name the JVM would need. A command naming one of those keys
 * is a launch; a command naming a bare capitalised word that happens to match one
 * is NOT, and says so, because a bare word in a command line is a program on
 * `PATH` at least as often as a class and picking would resolve further than the
 * gate can independently re-resolve.
 */
export const resolveUnits = (
  paths: string[],
  read: (path: string) => string | null,
  mains: Map<string, { path: string; type: string }>,
): { launches: UnitLaunch[]; gaps: UnitGap[]; units: string[] } => {
  const units = paths.filter((path) => UNIT_PATH.test(path));
  const launches: UnitLaunch[] = [];
  const gaps: UnitGap[] = [];
  for (const path of units.filter((p) => SERVICE_UNIT_PATH.test(p))) {
    const unit = unitName(path);
    const source = read(path);
    const exec = source === null ? null : execStart(source);
    if (exec === null) {
      gaps.push({
        path,
        unit,
        kind: "no_exec_start",
        detail: `${unit} declares no ExecStart in a [Service] section, so it starts no program this engine can follow`,
        exec: null,
      });
      continue;
    }
    const qualified = launchClassTokens(exec.command).filter((token) => mains.has(token));
    if (qualified.length > 0) {
      for (const target of qualified) {
        launches.push({ path, unit, exec, target, entry: mains.get(target)! });
      }
      continue;
    }
    const bySimple = new Map<string, string[]>();
    for (const key of mains.keys()) {
      const simple = key.slice(key.lastIndexOf(".") + 1);
      bySimple.set(simple, [...(bySimple.get(simple) ?? []), key]);
    }
    const bare = bareClassTokens(exec.command).filter((token) => bySimple.has(token));
    gaps.push(
      bare.length > 0
        ? {
            path,
            unit,
            kind: "ambiguous_exec_target",
            detail: `${unit} runs \`${exec.command}\`, which names ${bare
              .map((token) => `${token} (${bySimple.get(token)!.join(", ")})`)
              .join(" and ")} without a package; a bare word in an ExecStart is a program on PATH as often as a class, so this reader will not pin it to a main`,
            exec,
          }
        : {
            path,
            unit,
            kind: "unresolved_exec_target",
            detail: `${unit} runs \`${exec.command}\`, which names no fully-qualified class this subject declares a main for - a wrapper script, a jar whose main class lives in its manifest, or a binary this engine does not read`,
            exec,
          },
    );
  }
  return { launches, gaps, units };
};

/**
 * The subject's real `main` declarations, keyed by the name the JVM would need.
 *
 * The keys are what an `ExecStart` has to write to be followed, and they are
 * built from the entry inventory (a parsed declaration) and `packageByPath` (the
 * file's own package statement) - never from a path or a text match. The gate
 * re-derives the same key from the blob's `package` line, so the two sides agree
 * on what "fully qualified" means without sharing how either found it.
 */
export const declaredMains = (
  index: { packageByPath: Map<string, string> },
  entries: readonly { type: { path: string; qualified: string } }[],
): Map<string, { path: string; type: string }> => {
  const out = new Map<string, { path: string; type: string }>();
  for (const entry of entries) {
    const declared = index.packageByPath.get(entry.type.path) ?? "";
    const qualified = declared === "" ? entry.type.qualified : `${declared}.${entry.type.qualified}`;
    out.set(qualified, { path: entry.type.path, type: entry.type.qualified });
  }
  return out;
};
