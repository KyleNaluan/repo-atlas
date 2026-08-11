/**
 * P1 - no content from a declared-private source appears in the artifact.
 *
 * Discovery's rule 8 is unusually absolute: if a repo declares a public/private
 * split, the generator must never read from the private side, and must never
 * quote from it even if a local clone is present.
 *
 * The mechanic and its one tuning knob are empirical, not theoretical. Shingle
 * both sides into k-word sequences and assert the intersection is empty. At k=5
 * a clean artifact produced 8 hits, every one a false positive, in two
 * predictable classes: generic English ("is only as good as") and shared
 * structural strings ("backend src main java com sweprep"). At k=8 the false
 * positive rate was zero and a real 2.3 KB splice produced 387 overlapping hits.
 * That is not a close call, so k=8 and path-like tokens are stripped first.
 *
 * The applicability rule is the sharp part, and it has THREE states, not two.
 * The third must never be silent: if a future run happens to have the private
 * clone present, it must not inherit a "passed" reputation earned by a run that
 * never had it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spec } from "../register.js";
import { failed, notApplicable, passed, type AuditContext, type CheckResult } from "../types.js";

/** Measured: k=5 false-positives on generic English, k=8 does not. */
export const SHINGLE_K = 8;

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".idea"]);
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Lowercase alphanumeric word sequence, with path-like and identifier-like
 * tokens dropped.
 *
 * Dropping them is what removes the second false-positive class: a public repo
 * and its private content repo legitimately share package paths and file names,
 * and those shared strings say nothing about whether prose leaked.
 */
export const normalise = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s./_-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !/[./_-]/.test(t))
    .filter((t) => !/^\d+$/.test(t));

export const shingles = (words: string[], k = SHINGLE_K): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i + k <= words.length; i += 1) out.add(words.slice(i, i + k).join(" "));
  return out;
};

/**
 * A path the walk could not fold into the corpus even though it wanted to: too
 * large for the cap, unreadable, an unlistable directory, or a stat that threw
 * (a broken symlink, a vanished entry). Tracked rather than dropped, because a
 * corpus missing a file is a partial corpus, and a partial corpus can never
 * clear a truth gate - a leaked passage living in a skipped file would never be
 * shingled, and passing on it would be absence communicated by silence. A throw
 * out of the walk is the same hollow-coverage failure arriving as a crash, so
 * every filesystem call the walk makes records a skip instead of propagating.
 *
 * SKIP_DIRS and binaries are not skips in this sense: they are deliberate
 * exclusions of things that cannot carry shingleable prose, not text the walk
 * failed to read.
 */
const readCorpus = (
  root: string,
): { files: number; bytes: number; skipped: string[]; shingles: Map<string, string> } => {
  const index = new Map<string, string>();
  const skipped: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      skipped.push(dir);
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        skipped.push(path);
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (bytes + stat.size > MAX_BYTES) {
        skipped.push(path);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        skipped.push(path);
        continue;
      }
      // A NUL byte means this is not text; shingling a binary is noise.
      if (text.includes("\u0000")) continue;
      files += 1;
      bytes += stat.size;
      for (const s of shingles(normalise(text))) if (!index.has(s)) index.set(s, path);
    }
  };
  walk(root);
  return { files, bytes, skipped, shingles: index };
};

/** The artifact's visible text: what a reader can actually see. */
export const visibleText = (artifact: string): string =>
  artifact
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

export const privateSourceCheck = (ctx: AuditContext): CheckResult => {
  const declared = ctx.atlas.record.private_source;

  // State 3: the subject declares no split. Stated once, never silent.
  if (!declared?.declared) {
    return notApplicable(
      spec("P1"),
      "the subject declares no public/private split, so there is no private corpus to check against",
    );
  }

  // State 2: a split is declared but harvest never had the private side
  // readable. Passing here would let a later run inherit a reputation this one
  // did not earn, so it is named in the statement instead.
  if (!declared.readable_at_harvest || !ctx.privateClone) {
    return notApplicable(
      spec("P1"),
      `${ctx.atlas.subject.repo} declares a private source${declared.repo ? ` (${declared.repo})` : ""} but nothing private was readable at harvest, so no leak check was performed`,
    );
  }

  // State 1: run it, and gate on it.
  const corpus = readCorpus(ctx.privateClone);
  const artifactShingles = shingles(normalise(visibleText(ctx.artifact)));
  const hits: string[] = [];
  for (const s of artifactShingles) {
    const source = corpus.shingles.get(s);
    if (source) hits.push(`"${s}" appears in the declared-private source ${source}`);
  }

  if (hits.length > 0) return failed(spec("P1"), hits.slice(0, 20), hits.length);

  // No hits, but a passing verdict is only honest against the whole corpus. If
  // any private file was skipped, a leak could be hiding in it, so P1 reports
  // not_applicable by name - naming the skipped files - rather than a pass it
  // did not earn. Absence is never communicated by silence (#6, #8).
  if (corpus.skipped.length > 0) {
    const shown = corpus.skipped.slice(0, 5).join(", ");
    const more = corpus.skipped.length > 5 ? `, and ${corpus.skipped.length - 5} more` : "";
    return notApplicable(
      spec("P1"),
      `${corpus.skipped.length} private file(s) could not be read in full (size cap or unreadable), so the corpus is incomplete and no leak check can be trusted: ${shown}${more}`,
    );
  }

  return passed(spec("P1"), corpus.shingles.size);
};
