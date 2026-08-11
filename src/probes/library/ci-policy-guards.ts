/**
 * A CI step that guards policy rather than testing code.
 *
 * The judgement encoded: most CI steps run the tests, and those are not
 * interesting. A step that exists to stop a HUMAN doing something - leaking
 * private content, committing a secret, breaking a licence rule - is a
 * boundary someone decided to enforce mechanically, and that is a decision the
 * tree is keeping on the record's behalf.
 *
 * Grep-class: this is a question about what a workflow file says it is for.
 */
import type { Candidate, Probe } from "../types.js";
import { slug } from "../id.js";

const WORKFLOW = /^\.github\/workflows\/.+\.ya?ml$/;

/** Steps whose names read as policy rather than as a test run. */
const POLICY = /\b(no|never|forbid|deny|block|guard|check|verify|ensure|assert)\b[^\n]*\b(content|secret|credential|licen[cs]e|private|leak|token|key|commit)\b/i;

const TEST_RUN = /\b(npm test|mvn test|pytest|go test|cargo test|gradle test)\b/i;

export const ciPolicyGuards: Probe = {
  id: "ci-policy-guards",
  finds: "a CI step that guards policy rather than running the tests",
  toolchain: "any",
  run: (ctx) => {
    const out: Candidate[] = [];
    for (const path of ctx.paths.filter((p) => WORKFLOW.test(p))) {
      const text = ctx.read(path);
      if (text === null) continue;
      const lines = text.split("\n");
      const filename = path.split("/").pop()?.replace(/\W+/g, "-") ?? "step";

      // First pass: find the matched policy steps, and the job each one sits in.
      // The job scopes the id, because GitHub step names are not required to be
      // unique - two jobs in one workflow commonly carry the same policy step -
      // and a duplicate id would corrupt the audit's element-id lookups.
      const matches = collectMatches(lines);

      // Second pass: a step's name (scoped by its job) is the stable semantic
      // discriminator - an id is an anchor a reader links to, and a line-derived
      // one churns whenever anything above the step moves. Where job+name still
      // repeats within one file, an occurrence index disambiguates it, the last
      // resort for a matched step with no discriminator of its own; the line
      // number is never used.
      const base = matches.map((m) => {
        const parts = [m.job, m.named].filter((p): p is string => Boolean(p)).map(slug);
        return parts.length > 0 ? parts.join("-") : `${m.index + 1}`;
      });
      const total = new Map<string, number>();
      for (const b of base) total.set(b, (total.get(b) ?? 0) + 1);
      const seen = new Map<string, number>();

      matches.forEach((m, i) => {
        const b = base[i]!;
        let discriminator = b;
        if ((total.get(b) ?? 0) > 1) {
          const n = (seen.get(b) ?? 0) + 1;
          seen.set(b, n);
          discriminator = `${b}-${n}`;
        }
        out.push({
          probe_id: "ci-policy-guards",
          node: {
            type: "mechanism",
            id: `m-ci-guard-${filename}-${discriminator}`,
            title: m.named ?? "A CI step that guards policy",
            what: `${path} carries a step that fails the build on a policy breach rather than on a failing test.`,
            why_interesting:
              "Enforcing a rule in CI is a decision to stop trusting discipline. The rule is what someone was afraid of.",
            enforcement: "test-level",
            gotchas: [],
            evidence: [
              { kind: "file", path, line_start: m.index + 1, line_end: m.index + 1, sha: ctx.sha },
            ],
            confidence: "verified",
            interview_value: 0,
            probe_id: "ci-policy-guards",
          },
        });
      });
    }
    return out;
  },
};

interface PolicyStep {
  index: number;
  named: string | undefined;
  job: string | null;
}

/**
 * The matched policy steps in a workflow file, each tagged with the job it sits
 * in. Grep-class, so the job is tracked by indentation rather than parsed: the
 * key directly under `jobs:` is the job id, and any deeper key is that job's own
 * property. That is enough to scope a step name that two jobs share.
 */
const collectMatches = (lines: string[]): PolicyStep[] => {
  const matches: PolicyStep[] = [];
  let inJobs = false;
  let jobKeyIndent = -1;
  let currentJob: string | null = null;

  for (const [index, line] of lines.entries()) {
    const content = line.trim();
    if (content.length > 0 && !content.startsWith("#")) {
      const indent = line.length - line.trimStart().length;
      if (indent === 0) {
        inJobs = /^jobs:/.test(content);
        currentJob = null;
        jobKeyIndent = -1;
      } else if (inJobs) {
        const job = /^([A-Za-z0-9_-]+):/.exec(content);
        if (job) {
          if (jobKeyIndent === -1) jobKeyIndent = indent;
          if (indent === jobKeyIndent) currentJob = job[1]!;
        }
      }
    }
    if (!POLICY.test(line) || TEST_RUN.test(line)) continue;
    const named = /name:\s*(.+)$/.exec(line)?.[1]?.trim().replace(/^["']|["']$/g, "");
    matches.push({ index, named, job: currentJob });
  }
  return matches;
};
