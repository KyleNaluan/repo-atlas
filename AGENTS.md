# Project agent memory

## The design is closed on the tracker, and it is binding

Every architecture and scope decision for v1 is already made.
Issues [#1](https://github.com/KyleNaluan/repo-atlas/issues/1)-[#10](https://github.com/KyleNaluan/repo-atlas/issues/10) are closed, each with a `## Resolution:` comment that is the contract for its stage: the decision, the why, and the rejected alternatives.
Read a resolution before touching the stage it owns, and do not re-open a settled question - if a resolution proves genuinely unimplementable as written, escalate rather than silently deviating.

Read them with `gh api`, never a convenience wrapper:

```
gh api "repos/KyleNaluan/repo-atlas/issues/<n>/comments" --jq '.[].body'
```

That is not a style preference. #4's resolution is the finding that a convenience CLI truncates comment bodies at ~800 chars while its `--full` flag expands only the issue body, hiding ~39 KB of resolution text - the same trap the harvest stage exists to avoid.

Commits and PR bodies cite the ticket they implement (`per #7`).
This project measures decision density; its own history is expected to exhibit it.

## The one rule the whole codebase serves

> The artifact may only assert what was independently established, and anything that could not be traced is **cut, not hedged**.

Concretely, and these recur in every stage:

- **Silence is never how absence is communicated** (#6). An empty section renders an explicit panel in its own slot. Two phrasings, deliberately: only the decision section may say "absent from the record", because only it makes a claim *about* a record; every other empty section says "nothing surfaced".
- **Mechanics propose, judgement deletes** (#2, #5). Probes emit candidates; the gate verifies; the rank stage owns acceptance and deletion. No other stage may become a second authority over what survives - which is why budgets live in `rank` and not in `render` (#7), and why the audit may reject an artifact but never edit one outside its own slot (#8).
- **No sentence in the artifact may state an audit conclusion except inside the audit slot** (#8). The render prototype violated this; it is the defect the audit contract was written around.

## Layout

- `src/schema/types.ts` - the `atlas.json` contract as TypeScript. **The single source of truth.**
- `schema/atlas.schema.json` - **generated** from it by `npm run schema:gen`. Never hand-edit. CI runs `npm run schema:check` and fails if it is stale.
- `src/stages.ts` - the stage register; the CLI's help text and its dispatcher read the same list, so a stage cannot be documented without existing. An unbuilt stage exits 70 loudly rather than no-opping.
- `test/fixtures/*.atlas.json` - the #7 prototype's 33-node recast of the hand-made swe-prep overview, and its decision-poor variant. Real evidence, pinned at swe-prep `086c999`.
- `test/golden/` - render CI's goldens: rendered-byte hashes, the two absence phrasings, and the chrome inventory. Rewrite them deliberately with `UPDATE_GOLDEN=1 npx vitest run`, then read the diff.

After any change to `src/schema/types.ts`, run `npm run schema:gen` and commit the result.

## Three render-stage invariants that are easy to break by accident

- **`raw()` has exactly one call site**, the Graphviz SVG, and `test/render/raw-lint.test.ts` fails the build if a second appears. Raw HTML carries no provenance stamp, so a second call site is a hole check E1 cannot see. Syntax highlighting goes through Shiki's `codeToTokens` and back out through the escaping template for exactly this reason.
- **`prose()` requires a provenance argument.** There is no unstamped overload, because the moment one exists the check it protects becomes advisory. The renderer's own sentences use the `chrome` template instead.
- **`src/render/theme.ts` is one big template literal** - a backtick anywhere in it, including in a comment, silently truncates the stylesheet.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
