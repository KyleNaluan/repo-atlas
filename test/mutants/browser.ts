/**
 * Mutant fixtures for the pass B gates.
 *
 * Same contract as the pass A directory (#8, point 7): no check ships without a
 * deliberately-broken artifact proving it fails. These transform the rendered
 * HTML rather than the graph, because pass B's gates are properties of the file
 * as a browser sees it.
 *
 * S4 is the odd one out and deliberately so: "the artifact is one file" cannot
 * be broken by editing the file, so its mutant breaks the thing the check
 * actually asserts - it points the check at something that is not a regular
 * file.
 */
export interface BrowserMutant {
  check: string;
  breaks: string;
  /** Transform the artifact. Undefined when the mutant is about the path itself. */
  apply?: (artifact: string) => string;
  /** Set when the mutant replaces the artifact path rather than its contents. */
  usesDirectoryPath?: boolean;
}

export const BROWSER_MUTANTS: BrowserMutant[] = [
  {
    check: "S2",
    breaks: "an image the page fetches on load, so it makes a second request",
    apply: (artifact) =>
      artifact.replace("<footer>", '<footer><img src="https://example.com/tracker.png" alt="">'),
  },
  {
    check: "S3",
    breaks: "a script that throws, so the collapse and deep-link behaviour is broken",
    apply: (artifact) =>
      artifact.replace("</body>", '<script>throw new Error("boom");</script></body>'),
  },
  {
    check: "S4",
    breaks: "an artifact path that is not a regular file",
    usesDirectoryPath: true,
  },
  {
    check: "L4",
    breaks: "an internal link pointing at an element that does not exist",
    apply: (artifact) =>
      artifact.replace(
        "<footer>",
        '<footer><a href="#no-such-node">where the answer lives</a>',
      ),
  },
  {
    check: "E1",
    breaks: "a prose passage carrying no provenance stamp at all",
    apply: (artifact) =>
      artifact.replace(
        "<footer>",
        "<footer><p>This sentence was never traced to any evidence in the graph.</p>",
      ),
  },
];
