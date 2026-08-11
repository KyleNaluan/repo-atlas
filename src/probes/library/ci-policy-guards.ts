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

      // First pass: find the matched policy STEPS, and the job each one sits in.
      // This probe asserts a guarding step exists, so it may only fire where it
      // has actually identified a step - a match on a bare line (a comment, a
      // block of prose) would mint a "verified" node for a step that is not
      // there, and ci-policy candidates carry no claims for the gate to re-check.
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

interface StepLine {
  /** The line's content, trimmed and with any leading list dash removed. */
  text: string;
  /** Indent of the key itself, past any `- `, so a `run: |` block's body reads as deeper. */
  indent: number;
}

interface RawStep {
  /** The step item's own line, used as the evidence anchor. */
  index: number;
  job: string | null;
  lines: StepLine[];
}

/**
 * The matched policy steps in a workflow file. A step guards policy when its
 * name, run or uses names the boundary and the step is not simply a test run -
 * the two signals the earlier per-line scan conflated, letting a comment or a
 * prose line mint a candidate and letting one step whose name and run both
 * matched double-emit. Each step yields at most one candidate.
 */
const collectMatches = (lines: string[]): PolicyStep[] => {
  const matches: PolicyStep[] = [];
  for (const step of collectSteps(lines)) {
    const { named, signals } = classify(step);
    const guards = signals.some((s) => POLICY.test(s));
    const isTest = signals.some((s) => TEST_RUN.test(s));
    if (guards && !isTest) matches.push({ index: step.index, named, job: step.job });
  }
  return matches;
};

/**
 * The steps in a workflow file, each tagged with its job. Grep-class, so
 * structure is tracked by indentation rather than parsed: the key directly
 * under `jobs:` is the job id, a `steps:` under a job opens a step list, and a
 * `- ` at the item indent begins a step whose body is the deeper-indented lines
 * that follow. A comment or blank line never contributes, so policy vocabulary
 * in a comment cannot fabricate a step.
 */
const collectSteps = (lines: string[]): RawStep[] => {
  const steps: RawStep[] = [];
  let inJobs = false;
  let jobKeyIndent = -1;
  let currentJob: string | null = null;
  let stepsIndent = -1; // indent of the `steps:` key; -1 when outside a steps block
  let itemIndent = -1; // indent of the `- ` step items in the current steps block
  let current: RawStep | null = null;

  const close = () => {
    if (current) steps.push(current);
    current = null;
  };
  const keyIndentOf = (indent: number, content: string, stripped: string): number =>
    indent + (content.length - stripped.length);

  for (const [index, raw] of lines.entries()) {
    const content = raw.trim();
    if (content.length === 0 || content.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      close();
      inJobs = /^jobs:/.test(content);
      currentJob = null;
      jobKeyIndent = -1;
      stepsIndent = -1;
      itemIndent = -1;
      continue;
    }

    // Any line at or above the `steps:` key ends the current step list.
    if (stepsIndent !== -1 && indent <= stepsIndent) {
      close();
      stepsIndent = -1;
      itemIndent = -1;
    }

    // Inside a step, a deeper line is that step's own body (name/run/uses/...).
    if (current && stepsIndent !== -1 && indent > itemIndent) {
      const stripped = content.replace(/^-\s*/, "");
      current.lines.push({ text: stripped, indent: keyIndentOf(indent, content, stripped) });
      continue;
    }

    // A `- ...` at the item indent begins a step.
    if (stepsIndent !== -1 && indent > stepsIndent && (content === "-" || content.startsWith("- "))) {
      if (itemIndent === -1) itemIndent = indent;
      if (indent === itemIndent) {
        close();
        const stripped = content.replace(/^-\s*/, "");
        current = {
          index,
          job: currentJob,
          lines: [{ text: stripped, indent: keyIndentOf(indent, content, stripped) }],
        };
        continue;
      }
    }

    // Outside a step: track the enclosing job and the entry into its steps list.
    if (inJobs && stepsIndent === -1) {
      if (/^steps:/.test(content) && currentJob !== null) {
        stepsIndent = indent;
        itemIndent = -1;
        continue;
      }
      const job = /^([A-Za-z0-9_-]+):/.exec(content);
      if (job) {
        if (jobKeyIndent === -1) jobKeyIndent = indent;
        if (indent === jobKeyIndent) currentJob = job[1]!;
      }
    }
  }
  close();
  return steps;
};

/**
 * The signal lines of a step - its name, uses, and run (including the body of a
 * `run: |` block scalar) - and the step's name. Only these decide whether a
 * step guards policy; a `with:` or `env:` value is not the step's purpose.
 */
const classify = (step: RawStep): { named: string | undefined; signals: string[] } => {
  let named: string | undefined;
  const signals: string[] = [];
  let runBlock = -1; // indent of an open `run: |` block; deeper lines are its body

  for (const { text, indent } of step.lines) {
    if (runBlock !== -1 && indent > runBlock) {
      signals.push(text);
      continue;
    }
    runBlock = -1;
    const m = /^(name|run|uses):\s*(.*)$/.exec(text);
    if (m === null) continue;
    const key = m[1]!;
    const value = m[2]!.trim();
    if (key === "name") {
      named = value.replace(/^["']|["']$/g, "");
      signals.push(text);
    } else if (key === "uses") {
      signals.push(text);
    } else if (/^[|>][+-]?$/.test(value)) {
      runBlock = indent;
    } else {
      signals.push(text);
    }
  }
  return { named, signals };
};
