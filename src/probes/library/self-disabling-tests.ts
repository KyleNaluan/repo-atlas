/**
 * Tests that switch themselves off when a precondition is absent.
 *
 * The judgement encoded, from the reference overview's "The real content is never
 * verified in CI": a green suite is not evidence that a named test ran. A JUnit
 * `assumeTrue` aborts its test rather than failing it, so a test guarded by one
 * reports success in the same colour whether it exercised anything or not - and
 * the tests that carry such a guard are, by construction, exactly the ones whose
 * fixture is expensive, external, or private. That is a coverage gap the suite's
 * own summary line hides, and it is the kind of thing this artifact exists to say
 * out loud rather than leave to be discovered.
 *
 * A `coverage_gap` edge and not a mechanism: it is a statement about what the
 * subject's verification does NOT establish, which is #6's territory, and stating
 * it is the difference between "466 tests pass" and "461 tests pass and 5 decline
 * to run without a fixture that is not here".
 *
 * Structural, so `reading: "direct"` (#28), and the direct reading is narrower
 * than a grep for `assumeTrue` would be. Three things are read out of the tree and
 * the emitted sentence asserts exactly them:
 *
 *  - THE TEST METHODS, from the JUnit annotation on the method's own modifiers -
 *    not from a name convention, and not from an annotation mentioned in a
 *    comment or a string, both of which a raw-line scan matches (the #28 defect
 *    verbatim).
 *  - THE GUARD CALL, as a `method_invocation` node inside that method's body,
 *    named `assumeTrue`, `assumeFalse` or `assumingThat`.
 *  - THE IMPORT that makes the call JUnit's. Without it `assumeTrue` is an
 *    identifier this subject could have declared itself, and asserting "this test
 *    aborts" would be a judgement read out of a name rather than the name itself.
 *    The import is cited alongside the guard for exactly that reason.
 *
 * ONE CANDIDATE PER TEST CLASS, not per guarded method. Five guarded methods in
 * one class are one finding - "this class needs a fixture that is not here" - and
 * five edges saying it would be the same thing said five times, which the
 * candidate-finding guard in the register exists to catch and which is better not
 * produced in the first place.
 */
import type { Candidate, Probe } from "../types.js";
import { isTestPath } from "../../harvest/tree.js";
import { findAll, lineOf, endLineOf, nameOf, type SyntaxNode } from "../java.js";
import { pathSlug } from "../id.js";

/** JUnit 5's test-declaring annotations, matched on a method's own modifiers. */
const TEST_ANNOTATION = /@(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;

/** JUnit 5's assumption calls: each aborts its test rather than failing it. */
const ASSUMPTION = /^(?:Assumptions\.)?(assumeTrue|assumeFalse|assumingThat)$/;

/** The line an `org.junit.jupiter.api.Assumptions` import sits on, or null when there is none. */
const assumptionsImport = (source: string): number | null => {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\s+(?:static\s+)?org\.junit\.jupiter\.api\.Assumptions[.;]/.test(lines[i] ?? "")) {
      return i + 1;
    }
  }
  return null;
};

/** The method's own modifier text, which is where its annotations sit. */
const modifiersOf = (method: SyntaxNode): string => {
  const first = method.namedChild(0);
  return first?.type === "modifiers" ? first.text : "";
};

/** The call as the source writes it: `assumeTrue` or `Assumptions.assumeTrue`. */
const calleeOf = (call: SyntaxNode): string => {
  const name = call.childForFieldName("name")?.text;
  if (name === undefined) return "";
  const object = call.childForFieldName("object")?.text;
  return object === undefined ? name : `${object}.${name}`;
};

export const selfDisablingTests: Probe = {
  id: "self-disabling-tests",
  /** The parse tree is the reading: an annotated method, a call inside it, and the import (#28). */
  reading: "direct",
  finds: "a test class whose tests abort themselves when a fixture is absent, so a green suite does not mean they ran",
  toolchain: "java",
  run: async (ctx) => {
    const out: Candidate[] = [];

    for (const path of ctx.paths.filter((p) => p.endsWith(".java") && isTestPath(p))) {
      const source = ctx.read(path);
      if (source === null) continue;
      const importLine = assumptionsImport(source);
      // Without the import the identifier is not JUnit's, and this probe asserts
      // what the bytes say rather than what the name suggests.
      if (importLine === null) continue;
      const root = await ctx.parse(path);
      if (root === null) continue;

      const tests: SyntaxNode[] = [];
      const guarded: SyntaxNode[] = [];
      for (const method of findAll(root, "method_declaration")) {
        if (!TEST_ANNOTATION.test(modifiersOf(method))) continue;
        tests.push(method);
        const body = method.childForFieldName("body");
        if (body === null) continue;
        if (findAll(body, "method_invocation").some((c) => ASSUMPTION.test(calleeOf(c)))) {
          guarded.push(method);
        }
      }
      if (guarded.length === 0) continue;

      const names = guarded.map((m) => nameOf(m) ?? "?");
      const cls = path.split("/").pop()?.replace(/\.java$/, "") ?? path;
      const all = guarded.length === tests.length;
      // The calls as the source writes them, so the sentence names what was read
      // rather than the family the probe recognises.
      const callees = [
        ...new Set(
          guarded.flatMap((m) => {
            const body = m.childForFieldName("body");
            return body === null
              ? []
              : findAll(body, "method_invocation").map(calleeOf).filter((c) => ASSUMPTION.test(c));
          }),
        ),
      ].sort();

      out.push({
        probe_id: "self-disabling-tests",
        node: {
          type: "edge",
          kind: "coverage_gap",
          id: `e-self-disabling-${pathSlug(path)}`,
          title: `${cls} does not run without a fixture that may not be there`,
          statement:
            `${guarded.length} of ${cls}'s ${tests.length} test${tests.length === 1 ? "" : "s"}` +
            `${all ? " - all of them -" : ""} call ${callees.join(" / ")}, JUnit's assumption family, which ` +
            `aborts a test rather than failing it when the condition is false: ${names.join(", ")}. ` +
            `Where the precondition does not hold, those tests report as skipped inside a suite that still ` +
            `reports success.`,
          why_it_matters:
            "A green suite is not evidence that a named test ran. The tests that carry a guard like this are the " +
            "ones whose fixture is expensive, external or private, which makes them exactly the ones a reader " +
            "would most want to know had been exercised.",
          how_to_say_it:
            `Those ${guarded.length} are skipped rather than failed wherever the fixture is missing, so a green ` +
            `run does not tell you they executed - I would rather say that than let the summary line imply it.`,
          evidence: [
            {
              kind: "file",
              path,
              line_start: importLine,
              line_end: importLine,
              sha: ctx.sha,
              note: "the JUnit assumption import that makes the guard calls aborting ones",
            },
            ...guarded.map((m) => ({
              kind: "file" as const,
              path,
              line_start: lineOf(m),
              line_end: endLineOf(m),
              sha: ctx.sha,
              note: `${nameOf(m) ?? "?"} aborts itself when its precondition does not hold`,
            })),
          ],
          confidence: "verified",
          interview_value: 0,
          probe_id: "self-disabling-tests",
        },
      });
    }
    return out;
  },
};
