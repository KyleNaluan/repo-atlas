/**
 * One definition of "the same HTTP route", shared by the Flow producer and the
 * Flow gate.
 *
 * The producer reads route annotations off a parse tree; the gate re-derives
 * them textually from the pinned blob. Those two derivations are deliberately
 * INDEPENDENT - that is what makes the gate a check rather than an echo. But
 * they must agree on what the derived strings MEAN, or a correct producer looks
 * contradicted purely because one side kept a trailing slash and the other did
 * not. So the normalisation - the definition - lives here and both sides call
 * it, exactly as `manifests.ts` shares one definition of "declared" between the
 * divergence probe and the gate that re-checks it. The RESOLUTION stays split.
 */

/**
 * A route path reduced to the form two independent readers can compare:
 * query string dropped, every path variable collapsed to `{}` whatever syntax
 * named it, leading slash forced, repeated slashes collapsed, trailing slash
 * dropped except on the root.
 */
export const normalizedRoute = (value: string): string => {
  const withoutQuery = value.trim().split("?")[0] ?? value.trim();
  const templated = withoutQuery
    .replace(/\$\{[^}]+\}/g, "{}")
    .replace(/:[A-Za-z_$][\w$]*/g, "{}")
    .replace(/\{[^}]+\}/g, "{}");
  const withSlash = templated.startsWith("/") ? templated : `/${templated}`;
  const collapsed = withSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
};
