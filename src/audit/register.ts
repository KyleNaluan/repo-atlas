/**
 * The twenty-check register (#8, section 4), in one place.
 *
 * The classification rule is uniform and worth stating once, because it decides
 * all twenty:
 *
 *   A check is a HARD GATE if and only if its failure means the artifact makes a
 *   claim that is not true. A check is a WARNING if its failure means the
 *   artifact is worse than it should be.
 *
 * Evidence integrity is truth; layout is quality. That is why every evidence
 * check is a gate and every visual check is a warning.
 *
 * The register is declared in full here even though the passes land across
 * several PRs, so the audit can report a check as `not_run` by name rather than
 * silently omitting it - the same discipline #6 imposes on absent sections.
 */
import type { AuditCheckClass } from "../schema/types.js";

export type PassName = "A" | "B" | "C" | "D";

export interface CheckSpec {
  id: string;
  name: string;
  class: AuditCheckClass;
  pass: PassName;
}

export const REGISTER: readonly CheckSpec[] = [
  { id: "S1", name: "Zero external resource references", class: "gate", pass: "A" },
  { id: "S2", name: "Exactly one network request when loaded", class: "gate", pass: "B" },
  { id: "S3", name: "Console clean on load", class: "gate", pass: "B" },
  { id: "S4", name: "Artifact is one file, no siblings required", class: "gate", pass: "B" },
  { id: "L1", name: "Every file evidence path exists at the pinned SHA", class: "gate", pass: "A" },
  { id: "L2", name: "Every line range is within the file at that SHA", class: "gate", pass: "A" },
  { id: "L3", name: "Every issue and comment citation resolves", class: "gate", pass: "C" },
  { id: "L4", name: "Every internal anchor resolves to an element", class: "gate", pass: "B" },
  { id: "L5", name: "Every rendered evidence link is pinned to the run SHA", class: "gate", pass: "A" },
  { id: "G1", name: "No absent-confidence node appears in the artifact", class: "gate", pass: "A" },
  { id: "G2", name: "No deleted node is resurrected", class: "gate", pass: "A" },
  { id: "G3", name: "Displayed rank, value and rubric match atlas.json", class: "gate", pass: "A" },
  { id: "E1", name: "Every prose passage traces to a graph field or the chrome inventory", class: "gate", pass: "B" },
  { id: "E2", name: "Every present-tense behavioural node carries file or command evidence", class: "gate", pass: "A" },
  { id: "P1", name: "No declared-private source content appears in the artifact", class: "gate", pass: "A" },
  { id: "V1", name: "Page does not scroll horizontally at declared viewports", class: "warning", pass: "B" },
  { id: "V2", name: "No text clipped by a non-scrollable ancestor", class: "warning", pass: "B" },
  { id: "V3", name: "All text meets WCAG AA contrast", class: "warning", pass: "B" },
  { id: "M1", name: "Each node's prose is supported by its own evidence", class: "warning", pass: "D" },
  { id: "M2", name: "Each absence claim's citation actually witnesses absence", class: "warning", pass: "D" },
] as const;

export const GATES = REGISTER.filter((c) => c.class === "gate");

export const spec = (id: string): CheckSpec => {
  const found = REGISTER.find((c) => c.id === id);
  if (!found) throw new Error(`no such check in the register: ${id}`);
  return found;
};

export const checksInPass = (pass: PassName): readonly CheckSpec[] =>
  REGISTER.filter((c) => c.pass === pass);
