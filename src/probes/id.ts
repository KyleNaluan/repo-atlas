/**
 * A short, stable slug of a file path, minted into every probe-generated id.
 *
 * A node's id is used verbatim as the rendered element id (#7). Two candidates
 * for the same simple name in two different files or packages - the same class
 * name in two packages, the same setting tuned in two config files - would
 * otherwise share an id, and duplicate ids are invalid HTML and confuse the
 * audit's node lookups (G1 absent-node, G2 resurrection, the E1 provenance
 * walk). Uniqueness is minted here, where the id is minted, rather than repaired
 * downstream: including a path-derived component makes it unique by
 * construction. The slug is readable rather than a hash so the id still says
 * where the finding came from.
 */
export const pathSlug = (path: string): string =>
  path
    .replace(/\.[^./]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
