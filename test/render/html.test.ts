/**
 * The template core: escaping, and the provenance stamp that #8's check E1
 * depends on.
 *
 * The escaping cases are not paranoia. The subject repository's own prose ends
 * up in this output; swe-prep's alone contains `->`, `&&`, quoted strings and
 * generic type parameters. Hand-escaping that is a latent injection bug, which
 * is why #7 rejected bare string concatenation.
 */
import { describe, expect, it } from "vitest";
import { chrome, escape, from, html, join, prose, ProseError, raw } from "../../src/render/html.js";

describe("escaping", () => {
  it("escapes every interpolation by default", () => {
    expect(html`<p>${'<script>alert("x")</script>'}</p>`.toString()).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>",
    );
  });

  it("does not double-escape a nested fragment", () => {
    const inner = html`<b>${"a & b"}</b>`;
    expect(html`<p>${inner}</p>`.toString()).toBe("<p><b>a &amp; b</b></p>");
  });

  it("escapes ampersands first, so an escape cannot be escaped twice", () => {
    expect(escape("&lt;")).toBe("&amp;lt;");
  });

  it("drops null, undefined and false, so conditionals read as expressions", () => {
    expect(html`${null}${undefined}${false}${0}`.toString()).toBe("0");
  });

  it("flattens arrays and joins fragments", () => {
    expect(html`${[1, "<", 3]}`.toString()).toBe("1&lt;3");
    expect(join([html`<i></i>`, "a<b"], "-").toString()).toBe("<i></i>-a&lt;b");
  });

  it("raw() marks a string safe, which is why it has one call site", () => {
    expect(html`${raw("<svg/>")}`.toString()).toBe("<svg/>");
  });
});

describe("the provenance stamp", () => {
  it("wraps prose in a data-ev span naming the owner and field", () => {
    expect(prose("Flyway owns the schema.", from("d-flyway", "decision")).toString()).toBe(
      '<span data-ev="d-flyway:decision">Flyway owns the schema.</span>',
    );
  });

  it("escapes the prose inside the stamp", () => {
    expect(prose("a < b & c", from("n", "f")).toString()).toContain("a &lt; b &amp; c");
  });

  it("renders the one declared inline construct, a backtick code span", () => {
    expect(prose("run `./test.sh` first", from("n", "f")).toString()).toBe(
      '<span data-ev="n:f">run <code>./test.sh</code> first</span>',
    );
  });

  it("escapes inside a code span, so markup in an excerpt cannot escape it", () => {
    expect(prose("`List<String>`", from("n", "f")).toString()).toBe(
      '<span data-ev="n:f"><code>List&lt;String&gt;</code></span>',
    );
  });

  it("fails closed on an unbalanced backtick rather than rendering it as itself", () => {
    // Atlas prose is written by the rank stage, not scraped, so a malformed span
    // is a pipeline bug. Tolerating it is how a "declared subset" becomes a pile
    // of regexes that each subject bends a little further.
    expect(() => prose("a ` b", from("n", "f"))).toThrow(ProseError);
    expect(() => prose("a ` b", from("n", "f"))).toThrow(/unbalanced backtick/);
  });

  it("names the owner and field in the failure, so the fix is one lookup away", () => {
    expect(() => prose("a ` b", from("m-seam", "why_interesting"))).toThrow(
      /m-seam:why_interesting/,
    );
  });

  it("marks the renderer's own sentences as chrome, not as graph evidence", () => {
    const c = chrome`${5} mechanisms, ranked`;
    expect(c.toString()).toBe("<span data-chrome>5 mechanisms, ranked</span>");
    expect(c.toString()).not.toContain("data-ev");
  });
});
