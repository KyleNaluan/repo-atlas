/**
 * The mutant fixture directory (#8, point 7).
 *
 * > No check ships without a mutant fixture proving it fails.
 *
 * A check nobody has watched fail is a check nobody knows works. The failure
 * mode this prevents is specific and was observed during the audit prototype: a
 * resolver run outside the clone reported all 47 links as missing, and its
 * silently-inverted twin would have reported a clean pass on a broken artifact.
 * Every gate here therefore has one deliberately-broken artifact that it, and
 * only it, must reject.
 *
 * Each mutant is a named transform of the clean reference pair rather than a
 * committed HTML file. That is the same guarantee - the test really does run
 * every check against a really broken artifact - in a form a human can review:
 * nine near-identical 200 KB HTML files would show a reviewer nothing about what
 * makes each one broken, and this shows exactly that and nothing else.
 */
import type { Atlas, Evidence, FlowLink, FlowNode } from "../../src/schema/types.js";
import type { AuditContext } from "../../src/audit/types.js";

export interface Mutant {
  /** The check whose failure this fixture exists to prove. */
  check: string;
  /** What is deliberately wrong, in one line. */
  breaks: string;
  apply: (ctx: AuditContext) => AuditContext;
}

const clone = (atlas: Atlas): Atlas => structuredClone(atlas);

const flowMutant = (
  id: string,
  link: Partial<FlowLink>,
): FlowNode => {
  const observed = (name: string): Evidence => ({
    kind: "command",
    cmd: `show ${name}`,
    output_excerpt: name,
  });
  return {
    type: "flow",
    id,
    title: "Flow audit mutant",
    evidence: [],
    confidence: "verified",
    interview_value: 5,
    steps: [
      { id: "caller", node: "SourceEntry.run", evidence: observed("SourceEntry.run") },
      { id: "target", node: "Target.execute", evidence: observed("Target.execute") },
    ],
    links: [
      {
        id: "caller-target",
        from: "caller",
        to: "target",
        relation: "call",
        label: "execute()",
        evidence: [observed("Caller.run calls Target.execute")],
        ...link,
      },
    ],
  };
};

const withFlow = (ctx: AuditContext, flow: FlowNode): AuditContext => {
  const atlas = clone(ctx.atlas);
  atlas.nodes.push(flow);
  return { ...ctx, atlas };
};

export const MUTANTS: Mutant[] = [
  {
    check: "S1",
    breaks: "a stylesheet <link> to a CDN, so the page would fetch on load",
    apply: (ctx) => ({
      ...ctx,
      artifact: ctx.artifact.replace(
        "</head>",
        '<link rel="stylesheet" href="https://cdn.example.com/reset.css"></head>',
      ),
    }),
  },
  {
    check: "L1",
    breaks: "a file citation whose path does not exist at the pinned SHA",
    apply: (ctx) => {
      const atlas = clone(ctx.atlas);
      const node = atlas.nodes.find((n) => n.evidence.some((e) => e.kind === "file"))!;
      const evidence = node.evidence.find((e) => e.kind === "file")!;
      if (evidence.kind === "file") evidence.path = "backend/src/main/java/GhostGrader.java";
      return { ...ctx, atlas };
    },
  },
  {
    check: "L1",
    breaks: "Flow link evidence names a file missing at the pinned SHA",
    apply: (ctx) =>
      withFlow(
        ctx,
        flowMutant("fl-link-missing-file", {
          evidence: [
            {
              kind: "file",
              path: "backend/src/main/java/GhostFlowTarget.java",
              sha: ctx.atlas.subject.sha,
            },
          ],
        }),
      ),
  },
  {
    check: "L2",
    breaks: "a line range past the end of a file that does exist",
    apply: (ctx) => {
      const atlas = clone(ctx.atlas);
      const node = atlas.nodes.find((n) =>
        n.evidence.some((e) => e.kind === "file" && e.line_start !== undefined),
      )!;
      const evidence = node.evidence.find((e) => e.kind === "file" && e.line_start !== undefined)!;
      if (evidence.kind === "file") {
        evidence.line_start = 9000;
        evidence.line_end = 9999;
      }
      return { ...ctx, atlas };
    },
  },
  {
    check: "L2",
    breaks: "Flow link evidence carries a line range past EOF",
    apply: (ctx) =>
      withFlow(
        ctx,
        flowMutant("fl-link-stale-range", {
          evidence: [
            {
              kind: "file",
              path: "backend/src/main/java/com/sweprep/backend/attempt/AttemptService.java",
              line_start: 9000,
              line_end: 9999,
              sha: ctx.atlas.subject.sha,
            },
          ],
        }),
      ),
  },
  {
    check: "L5",
    breaks: "a rendered evidence link pointing at main instead of the pinned commit",
    apply: (ctx) => ({
      ...ctx,
      artifact: ctx.artifact.replace(`/blob/${ctx.atlas.subject.sha}/`, "/blob/main/"),
    }),
  },
  {
    check: "L5",
    breaks: "a rendered Flow evidence link points at main instead of the run SHA",
    apply: (ctx) => {
      const start = ctx.artifact.indexOf('id="fl-submission"');
      const head = ctx.artifact.slice(0, start);
      const tail = ctx.artifact
        .slice(start)
        .replace(`/blob/${ctx.atlas.subject.sha}/`, "/blob/main/");
      return { ...ctx, artifact: `${head}${tail}` };
    },
  },
  {
    check: "G1",
    breaks: "a node the confidence gate cut, rendered anyway",
    apply: (ctx) => {
      const atlas = clone(ctx.atlas);
      const node = atlas.nodes.find((n) => n.confidence !== "absent")!;
      node.confidence = "absent";
      return { ...ctx, atlas };
    },
  },
  {
    check: "G1",
    breaks: "an atomically quarantined Flow is restored as an element id",
    apply: (ctx) => {
      const atlas = clone(ctx.atlas);
      const flow = flowMutant("fl-quarantined-mutant", {});
      flow.confidence = "absent";
      atlas.nodes.push(flow);
      return {
        ...ctx,
        atlas,
        artifact: ctx.artifact.replace(
          '<section id="flow">',
          '<section id="flow"><div id="fl-quarantined-mutant"></div>',
        ),
      };
    },
  },
  {
    check: "G2",
    breaks: "a deleted node resurrected as an element id",
    apply: (ctx) => {
      const id = ctx.atlas.record.deletions[0]!.id;
      return {
        ...ctx,
        artifact: ctx.artifact.replace("<section id=\"deep\">", `<section id="deep"><div id="${id}"></div>`),
      };
    },
  },
  {
    check: "G2",
    breaks: "a Flow cut by the section budget is restored as a rendered element",
    apply: (ctx) => {
      const atlas = clone(ctx.atlas);
      atlas.record.deletions.push({
        id: "fl-submission",
        score: 5,
        reason: "section budget: flows capped at 2",
        kind: "budget",
        section: "flows",
        unit: "node",
      });
      return { ...ctx, atlas };
    },
  },
  {
    check: "G3",
    breaks: "a displayed interview_value that disagrees with the graph",
    apply: (ctx) => ({ ...ctx, artifact: ctx.artifact.replace("value 5/5", "value 2/5") }),
  },
  {
    check: "G3",
    breaks: "a Flow value chip disagrees with atlas.json",
    apply: (ctx) => {
      const start = ctx.artifact.indexOf('id="fl-submission"');
      return {
        ...ctx,
        artifact:
          ctx.artifact.slice(0, start) +
          ctx.artifact.slice(start).replace("value 5/5", "value 1/5"),
      };
    },
  },
  {
    check: "G3",
    breaks: "the Flow-cut disclosure omits one section-budget deletion",
    apply: (ctx) => {
      const atlas = clone(ctx.atlas);
      atlas.record.deletions.push({
        id: "fl-cut-but-undisclosed",
        score: 4,
        reason: "section budget: flows capped at 2",
        kind: "budget",
        section: "flows",
        unit: "node",
      });
      return { ...ctx, atlas };
    },
  },
  {
    check: "E2",
    breaks: "a mechanism whose only evidence is an issue - a record of intent, not of behaviour",
    apply: (ctx) => {
      const atlas = clone(ctx.atlas);
      const mechanism = atlas.nodes.find((n) => n.type === "mechanism")!;
      mechanism.evidence = [{ kind: "issue", number: 3, comment_id: 5180801286 }];
      return { ...ctx, atlas };
    },
  },
  {
    check: "E2",
    breaks: "a Flow link carries no evidence",
    apply: (ctx) => withFlow(ctx, flowMutant("fl-link-no-evidence", { evidence: [] })),
  },
  {
    check: "E2",
    breaks: "a Flow link cites a real source file that names a different target",
    apply: (ctx) =>
      withFlow(
        ctx,
        flowMutant("fl-link-wrong-target", {
          label: "DefinitelyDifferentTarget.execute()",
          evidence: [
            {
              kind: "file",
              path: "backend/src/main/java/com/sweprep/backend/attempt/AttemptService.java",
              line_start: 141,
              line_end: 150,
              sha: ctx.atlas.subject.sha,
            },
          ],
        }),
      ),
  },
  {
    check: "E2",
    breaks: "a transport link's path matches but its HTTP method does not",
    apply: (ctx) =>
      withFlow(
        ctx,
        flowMutant("fl-link-wrong-method", {
          relation: "transport",
          label: "DELETE /{id}/submissions",
          evidence: [
            {
              kind: "file",
              path: "backend/src/main/java/com/sweprep/backend/web/AttemptController.java",
              line_start: 55,
              line_end: 57,
              sha: ctx.atlas.subject.sha,
            },
          ],
        }),
      ),
  },
  {
    check: "E2",
    breaks: "a keyed dispatch branch names a key the guard it cites does not produce",
    apply: (ctx) =>
      withFlow(
        ctx,
        flowMutant("fl-link-wrong-dispatch-key", {
          relation: "dispatch",
          // The cited span IS a keyed guard - `languageId()` returning "java" -
          // and the label claims the branch the registry takes for Python. A word
          // list would pass this: the span is selection-shaped. Comparing the
          // label's key against the source is what catches it.
          label: 'execute(...) via "python"',
          evidence: [
            {
              kind: "file",
              path: "backend/src/main/java/com/sweprep/backend/runner/LocalJavaRunner.java",
              line_start: 32,
              line_end: 35,
              sha: ctx.atlas.subject.sha,
            },
          ],
        }),
      ),
  },
  {
    check: "E2",
    breaks: "an ambiguous interface dispatch is asserted as one concrete implementation",
    apply: (ctx) =>
      withFlow(
        ctx,
        flowMutant("fl-link-ambiguous-dispatch", {
          relation: "dispatch",
          label: "TestCaseGrader",
          evidence: [
            {
              kind: "file",
              path: "backend/src/main/java/com/sweprep/backend/attempt/AttemptService.java",
              line_start: 141,
              line_end: 150,
              sha: ctx.atlas.subject.sha,
            },
          ],
        }),
      ),
  },
  {
    check: "P1",
    breaks: "a passage spliced in from the declared-private corpus",
    apply: (ctx) => ({
      ...ctx,
      artifact: ctx.artifact.replace(
        "<footer>",
        "<footer><p>the studies are not two attempts at one question but two questions</p>",
      ),
    }),
  },
];
