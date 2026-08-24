/**
 * Closed-set dispatch in Python: what closes an implementation set, and what #52
 * decided does not (D3).
 *
 * `dispatch.ts` closes a Java set three ways - a sole implementation, a `sealed`
 * base, or every implementation carrying a Spring stereotype. Python has none of
 * those, and #52's D3 settles that v1 ships exactly ONE closure rule: a keyed
 * registry that is a literal.
 *
 *     _PAYLOAD_TYPES: dict[RecordType, type[RecordPayload]] = {
 *         RecordType.SIGNAL: SignalRecord,
 *         RecordType.GATE: GateRecord,
 *         RecordType.ORDER_EVENT: OrderEventRecord,
 *         RecordType.OPERATOR_EVENT: OperatorEventRecord,
 *     }
 *
 * consumed as `payload_cls = _PAYLOAD_TYPES[record_type]` and then
 * `payload_cls.from_dict(...)`. Everything the arrow asserts is written down in
 * one file: the members, how many there are, and the key that names each branch.
 * The set fans out into one labelled, separately evidenced arrow per member -
 * never a chosen "obvious" implementation - exactly as PR 5's rule does for Java,
 * and the gate re-enumerates the dict literal textually and refuses a claim whose
 * member count moved.
 *
 * The two rules D3 REJECTED, recorded here because the rejection is the design:
 *
 * - **Type closure** - enumerate the subclasses of an ABC-typed collection's
 *   element type. Provably wrong by one on the dsa subject: eleven classes
 *   subclass `Tool` while the literal list handed to the call site holds ten, so
 *   the arrow would reach a tool that call site never sees. In v1 a call through
 *   an ABC-typed collection is `unresolved_dispatch:`.
 * - **Value closure** - follow the literal collection from the injection site.
 *   Correct on dsa, and it crosses two files (`_DEFAULT_TOOLS` in `cli.py`, the
 *   consumer in `graph.py`) against the single-file rule the gate re-derives
 *   under.
 *
 * A NOTE on the union type alias, which is Python's `sealed` and is deliberately
 * NOT a closure rule here. `RecordPayload = SignalRecord | GateRecord |
 * OrderEventRecord | OperatorEventRecord` names its members in one place, in the
 * subject's own source, and both the producer and the gate can read it - which is
 * exactly what `sealed` gives Java. What it does not give is a CALL SITE: an
 * alias says what the set is, not that some particular call reaches all of it, and
 * closing a set on an alias would mean drawing arrows from a receiver typed only
 * by an annotation naming the alias. The keyed registry ships first because it is
 * the case where the set and the call site are the same declaration. Admitting
 * the alias is a real next rule and it deserves its own resolution.
 */
import type { SyntaxNode } from "../java.js";
import {
  endLineOf,
  findAll,
  lineOf,
  namedChildren,
  unionMembers,
} from "../python.js";
import { boundClass, type Binding, type PythonIndex } from "./py-symbols.js";
import type { TypeSymbol } from "./symbols.js";

export interface RegistryMember {
  /** The branch as the tree names it: the registry key, written exactly as written. */
  label: string;
  type: TypeSymbol;
}

export interface KeyedRegistry {
  /** The registry's own name, which is what the gate re-reads the literal by. */
  name: string;
  path: string;
  /** The declaration span, cited by every arrow the set fans out into. */
  declaration: { path: string; line_start: number; line_end: number };
  members: RegistryMember[];
  /**
   * The union alias the registry's own annotation names, when it names one.
   *
   * Read and recorded, never used to close anything - see the note above. It is
   * kept because a future resolution admitting the alias needs to know whether
   * the two agree on this subject, and the answer is measurable rather than
   * predicted: on ftb the alias names exactly the four members the dict holds.
   */
  aliasMembers?: string[];
}

const registryPairs = (dictionary: SyntaxNode): { key: SyntaxNode; value: SyntaxNode }[] => {
  const out: { key: SyntaxNode; value: SyntaxNode }[] = [];
  for (const child of namedChildren(dictionary)) {
    if (child.type !== "pair") continue;
    const key = child.childForFieldName("key");
    const value = child.childForFieldName("value");
    if (key && value) out.push({ key, value });
  }
  return out;
};

/**
 * The keyed registries one module declares at module level, keyed by name.
 *
 * Module level only, and every value has to be a bare identifier this file binds
 * to a class: a value built by a call, held in a nested structure, or named by
 * something the file does not bind is a member this reader cannot name, and a set
 * missing a member is the one error a closed set must never make.
 *
 * A dictionary with a `dictionary_comprehension` or a `**splat` in it is refused
 * for the same reason - the members are computed, so the literal is not the set.
 */
export const keyedRegistriesIn = (
  index: PythonIndex,
  path: string,
): Map<string, KeyedRegistry> => {
  const out = new Map<string, KeyedRegistry>();
  const root = index.treesByPath.get(path);
  const bindings = index.bindingsByPath.get(path);
  if (!root || !bindings) return out;
  for (const statement of namedChildren(root)) {
    const assignment =
      statement.type === "assignment"
        ? statement
        : statement.type === "expression_statement"
          ? namedChildren(statement).find((child) => child.type === "assignment") ?? null
          : null;
    if (!assignment) continue;
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (left?.type !== "identifier" || right?.type !== "dictionary") continue;
    if (namedChildren(right).some((child) => child.type !== "pair" && child.type !== "comment")) {
      continue;
    }
    const pairs = registryPairs(right);
    if (pairs.length === 0) continue;
    const members: RegistryMember[] = [];
    let complete = true;
    for (const pair of pairs) {
      if (pair.value.type !== "identifier") {
        complete = false;
        break;
      }
      const bound: Binding | undefined = bindings.get(pair.value.text);
      const type = bound === undefined ? null : boundClass(index, bound);
      if (type === null) {
        complete = false;
        break;
      }
      members.push({ label: pair.key.text.trim(), type });
    }
    if (!complete) continue;
    // A key written twice, or two keys that read the same, is a set whose branch
    // labels do not tell the branches apart - the same refusal `closedDispatch`
    // makes when two guards share a label.
    const labels = members.map((member) => member.label);
    if (new Set(labels).size !== labels.length) continue;
    const annotation = assignment.childForFieldName("type");
    const aliasMembers = annotation === null ? [] : aliasMembersOf(index, path, annotation);
    out.set(left.text, {
      name: left.text,
      path,
      declaration: { path, line_start: lineOf(statement), line_end: endLineOf(statement) },
      members,
      ...(aliasMembers.length > 1 ? { aliasMembers } : {}),
    });
  }
  return out;
};

/**
 * The members of the union alias a registry's value annotation names, if any.
 *
 * Recorded, not used - see the module note. `dict[RecordType, type[RecordPayload]]`
 * reduces to `RecordPayload` through the shared annotation reader, and the alias
 * is then looked up as a module-level `X = A | B | C` in the same file.
 */
const aliasMembersOf = (index: PythonIndex, path: string, annotation: SyntaxNode): string[] => {
  const root = index.treesByPath.get(path);
  if (!root) return [];
  const names = new Set<string>();
  for (const piece of findAll(annotation, "identifier")) names.add(piece.text);
  for (const assignment of findAll(root, "assignment")) {
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (left?.type !== "identifier" || !names.has(left.text)) continue;
    const members = unionMembers(right);
    if (members.length > 1) return members;
  }
  return [];
};
