/**
 * The shared balanced-span reader (`readParenList`), tested directly (#35, PR 8).
 *
 * Three separate review findings were the same literal-blindness in three
 * hand-rolled copies of this scan; the copies were folded into one definition next
 * to the mask it depends on, and these tests watch that one definition against the
 * shapes that broke the copies: a nested paren, a generic comma, a string carrying
 * `)`, and a string carrying `>`. If the mask ever stops being applied, or the
 * `<>` depth handling regresses, exactly one of these fails.
 */
import { describe, expect, it } from "vitest";
import { readParenList } from "../../src/probes/flow/reachability.js";

/** A `(` sits at index `open`; read the list starting there. */
const listAfter = (span: string) => {
  const open = span.indexOf("(");
  return readParenList(span, open);
};

describe("readParenList balances brackets over a length-preserving mask", () => {
  it("splits a plain two-parameter list at its one top-level comma", () => {
    const list = listAfter("m(String a, Order b)");
    expect(list?.elements).toEqual(["String a", " Order b"]);
    expect(list?.inner).toBe("String a, Order b");
  });

  it("returns no elements for an empty list", () => {
    const list = listAfter("main()");
    expect(list?.elements).toEqual([]);
    expect(list?.inner).toBe("");
  });

  it("does not split a generic comma, because `<>` counts toward depth", () => {
    const list = listAfter("m(Map<String, Order> m, String h)");
    expect(list?.elements).toEqual(["Map<String, Order> m", " String h"]);
  });

  it("reads a nested paren in a parameter annotation whole", () => {
    const list = listAfter('m(@Header(name = "trace", required = false) String h, Order o)');
    expect(list?.elements).toEqual([
      '@Header(name = "trace", required = false) String h',
      " Order o",
    ]);
  });

  it("is not fooled by a `)` inside a string literal", () => {
    const list = listAfter('m(@Header("a)b") String h, Order o)');
    // The masked scan ignores the `)` inside the string, so the list ends at the
    // real close paren and the two parameters survive - the sliced text is the
    // ORIGINAL, so the string value is intact.
    expect(list?.elements).toEqual(['@Header("a)b") String h', " Order o"]);
  });

  it("is not fooled by a `>` inside a string literal", () => {
    const list = listAfter('m(@Header("x>y") String h, Order o)');
    expect(list?.elements).toEqual(['@Header("x>y") String h', " Order o"]);
  });

  it("returns null for an unterminated list, failing closed", () => {
    expect(listAfter("m(String a, Order b")).toBeNull();
  });

  it("returns null when the offset is not an opening paren", () => {
    expect(readParenList("m(String a)", 0)).toBeNull();
  });
});
