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
import type { Atlas } from "../../src/schema/types.js";
import type { AuditContext } from "../../src/audit/types.js";

export interface Mutant {
  /** The check whose failure this fixture exists to prove. */
  check: string;
  /** What is deliberately wrong, in one line. */
  breaks: string;
  apply: (ctx: AuditContext) => AuditContext;
}

const clone = (atlas: Atlas): Atlas => structuredClone(atlas);

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
    check: "L5",
    breaks: "a rendered evidence link pointing at main instead of the pinned commit",
    apply: (ctx) => ({
      ...ctx,
      artifact: ctx.artifact.replace(`/blob/${ctx.atlas.subject.sha}/`, "/blob/main/"),
    }),
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
    check: "G3",
    breaks: "a displayed interview_value that disagrees with the graph",
    apply: (ctx) => ({ ...ctx, artifact: ctx.artifact.replace("value 5/5", "value 2/5") }),
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
