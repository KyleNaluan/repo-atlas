/**
 * The TypeScript/TSX client half of an HTTP story (#35, accepted design 5.1).
 *
 * Registered separately from the two Java adapters for the reason #5 gives one
 * level up and #6 gives everywhere: "this subject has no frontend", "the frontend
 * exists and calls nothing this backend serves", and "a submit button whose URL
 * this engine could not resolve" are three different findings, and silence would
 * make them read alike.
 *
 * What it emits is only half of what it finds, deliberately. A client call it can
 * pin exactly becomes a TRANSPORT ARROW into the Spring route it names, drawn by
 * the adapter that owns that route's entry - one story per route, told from where
 * a person starts it, rather than a second telling competing for the same budget
 * (#39). What it emits here is the other half: every call whose story this engine
 * could NOT trace, as an `absent` cut with a kind-tokened reason, because a UI
 * action that reaches no traceable route is exactly the absence #6 refuses to
 * communicate by saying nothing.
 */
import { httpEntries } from "../flow/entries.js";
import { clientIndex, type ClientCallSite } from "../flow/http-client.js";
import { javaIndex } from "../flow/symbols.js";
import { shortHash, slug } from "../id.js";
import type { Candidate, Probe, ProbeContext } from "../types.js";
import type { FlowNode } from "../../schema/types.js";

const moduleOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const cut = (
  ctx: ProbeContext,
  where: { path: string; action: string; line_start: number; line_end: number },
  title: string,
  reason: string,
): Candidate => {
  const node: FlowNode = {
    type: "flow",
    id: `fl-ts-${slug(moduleOf(where.path))}-${slug(where.action)}-${shortHash(
      `${where.path}#${where.action}@${where.line_start}`,
    )}`,
    title,
    evidence: [
      {
        kind: "file",
        path: where.path,
        line_start: where.line_start,
        line_end: where.line_end,
        sha: ctx.sha,
      },
    ],
    confidence: "absent",
    interview_value: 0,
    probe_id: "flow-typescript-http-client",
    steps: [],
  };
  return { probe_id: "flow-typescript-http-client", node, absent_reason: reason };
};

export const flowTypescriptHttpClient: Probe = {
  id: "flow-typescript-http-client",
  finds: "one TypeScript HTTP call stitched to the Spring route it names, by exact verb and path",
  toolchain: "typescript",
  applies: async (ctx) => {
    const client = clientIndex(ctx);
    if (client.calls.length === 0 && client.gaps.length === 0) {
      return {
        ok: false,
        reason:
          "not applicable to this subject: no production TypeScript module calls `fetch` or a function this subject declares as a fetch client, so there is no client half of an HTTP story to stitch",
      };
    }
    // This phase stitches to Spring routes and to nothing else (#38's parity-first
    // scope). Without one, a call this adapter cannot match says nothing about the
    // subject - there is no route inventory to have missed - so reporting those
    // calls as cuts would be the engine blaming a subject for a backend adapter
    // it does not have.
    const routes = httpEntries(await javaIndex(ctx));
    return routes.length === 0
      ? {
          ok: false,
          reason:
            "not applicable to this subject: it declares no Spring HTTP route, and this phase can stitch a TypeScript client call to no other backend surface",
        }
      : { ok: true };
  },
  run: async (ctx) => {
    const client = clientIndex(ctx);
    const routes = httpEntries(await javaIndex(ctx));
    const out: Candidate[] = [];

    for (const gap of client.gaps) {
      out.push(
        cut(
          ctx,
          { path: gap.path, action: gap.action, line_start: gap.line_start, line_end: gap.line_end },
          `${moduleOf(gap.path)}.${gap.action} calls the backend, entry to terminal`,
          `${gap.kind}: ${gap.path}#${gap.action} calls ${gap.callee} but ${gap.detail}`,
        ),
      );
    }

    for (const call of client.calls) {
      const exact = routes.some(
        (route) =>
          route.protocol.method === call.protocol.method &&
          route.protocol.path === call.protocol.path,
      );
      // A stitched call is not this adapter's candidate: it is an arrow into the
      // route's own Flow, evidenced at both ends there.
      if (exact) continue;
      const samePath = routes.filter((route) => route.protocol.path === call.protocol.path);
      out.push(cut(ctx, where(call), title(call), reason(call, samePath.map((r) => r.protocol.method))));
    }
    return out;
  },
};

const where = (call: ClientCallSite) => ({
  path: call.path,
  action: call.action.name,
  line_start: call.call.line_start,
  line_end: call.call.line_end,
});

const title = (call: ClientCallSite): string =>
  `${call.protocol.method} ${call.protocol.path} from ${moduleOf(call.path)}.${call.action.name}, entry to terminal`;

/**
 * Why one resolved client call could not be stitched.
 *
 * The two reasons are kept apart because they are different facts about the
 * subject. A path no route serves is a call into nothing this tree declares; a
 * path served under another verb is a contract disagreement between two files
 * that both exist - and matching on path text alone is precisely the mistake
 * report 5.2 forbids, so the second must never quietly become a stitch.
 */
const reason = (call: ClientCallSite, verbsAtPath: string[]): string =>
  verbsAtPath.length === 0
    ? `no_subject_route: ${call.path}#${call.action.name} calls ${call.protocol.method} ${call.protocol.path}, which no Spring mapping in this subject declares`
    : `route_method_mismatch: ${call.path}#${call.action.name} calls ${call.protocol.method} ${call.protocol.path}, and this subject declares that path only for ${verbsAtPath.join(", ")}`;
