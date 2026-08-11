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
      for (const [index, line] of lines.entries()) {
        if (!POLICY.test(line) || TEST_RUN.test(line)) continue;
        const named = /name:\s*(.+)$/.exec(line)?.[1]?.trim().replace(/^["']|["']$/g, "");
        out.push({
          probe_id: "ci-policy-guards",
          node: {
            type: "mechanism",
            id: `m-ci-guard-${index + 1}-${path.split("/").pop()?.replace(/\W+/g, "-") ?? "step"}`,
            title: named ?? "A CI step that guards policy",
            what: `${path} carries a step that fails the build on a policy breach rather than on a failing test.`,
            why_interesting:
              "Enforcing a rule in CI is a decision to stop trusting discipline. The rule is what someone was afraid of.",
            enforcement: "test-level",
            gotchas: [],
            evidence: [
              { kind: "file", path, line_start: index + 1, line_end: index + 1, sha: ctx.sha },
            ],
            confidence: "verified",
            interview_value: 0,
            probe_id: "ci-policy-guards",
          },
        });
      }
    }
    return out;
  },
};
