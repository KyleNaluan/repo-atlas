/**
 * The single link authority: the one place an `Evidence` becomes a URL.
 *
 * Kept as one function so a link shape can never drift between the decision
 * trail, a deep dive and the generated source index (#7).
 *
 * #7's section 7 adds the assertion the prototype lacked: a `file` evidence
 * entry whose `sha` is not the run's pinned SHA is a hard error, not a rendered
 * link. The prototype trusted the data. An artifact whose whole claim is
 * "pinned at this commit" cannot contain a link to a different one, and the
 * cheapest place to make that impossible is here, before the link exists.
 * #8's L5 asserts the same property again from outside, on the rendered file:
 * this guard protects against a bad `Evidence` object, L5 protects against a
 * renderer change that stops calling this function.
 */
import type { Evidence, FileEvidence, Subject } from "../schema/types.js";

export interface RenderedEvidence {
  /** null for a command: there is nothing on GitHub to point at. */
  href: string | null;
  label: string;
  kind: Evidence["kind"];
  note?: string;
  /** A command's captured output, shown verbatim rather than linked. */
  output?: string;
  /** Stable key for de-duplication in the source index. */
  key: string;
}

export class UnpinnedEvidenceError extends Error {
  constructor(e: FileEvidence, subject: Subject) {
    super(
      `evidence for ${e.path} is pinned to ${e.sha}, but this run is pinned to ${subject.sha}. ` +
        `Refusing to render a link that does not resolve at the artifact's own commit.`,
    );
    this.name = "UnpinnedEvidenceError";
  }
}

const lineFragment = (e: FileEvidence): string => {
  if (e.line_start === undefined) return "";
  if (e.line_end === undefined || e.line_end === e.line_start) return `#L${e.line_start}`;
  return `#L${e.line_start}-L${e.line_end}`;
};

const lineLabel = (e: FileEvidence): string => {
  if (e.line_start === undefined) return "";
  if (e.line_end === undefined || e.line_end === e.line_start) return `:${e.line_start}`;
  return `:${e.line_start}-${e.line_end}`;
};

/** A short, readable path label: keep the last two segments. */
export const shortPath = (path: string): string => {
  const parts = path.split("/");
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
};

export const renderEvidence = (e: Evidence, subject: Subject): RenderedEvidence => {
  const base = subject.url;
  switch (e.kind) {
    case "file": {
      if (e.sha !== subject.sha) throw new UnpinnedEvidenceError(e, subject);
      return {
        kind: "file",
        href: `${base}/blob/${e.sha}/${e.path}${lineFragment(e)}`,
        label: `${shortPath(e.path)}${lineLabel(e)}`,
        ...(e.note === undefined ? {} : { note: e.note }),
        key: `file:${e.path}`,
      };
    }
    case "issue":
      return {
        kind: "issue",
        href: e.comment_id
          ? `${base}/issues/${e.number}#issuecomment-${e.comment_id}`
          : `${base}/issues/${e.number}`,
        label: e.comment_id ? `issue #${e.number} (resolution)` : `issue #${e.number}`,
        ...(e.note === undefined ? {} : { note: e.note }),
        key: `issue:${e.number}:${e.comment_id ?? "body"}`,
      };
    case "command":
      return {
        kind: "command",
        href: null,
        label: e.cmd,
        ...(e.note === undefined ? {} : { note: e.note }),
        output: e.output_excerpt,
        key: `command:${e.cmd}`,
      };
  }
};

export const commitUrl = (subject: Subject): string => `${subject.url}/commit/${subject.sha}`;
export const treeUrl = (subject: Subject): string => `${subject.url}/tree/${subject.sha}`;
