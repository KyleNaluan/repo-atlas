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
- **Mechanics propose, judgement deletes** (#2, #5). Probes and the write stage emit candidates; the gate verifies; the rank stage owns acceptance and deletion. No other stage may become a second authority over what survives - which is why budgets live in `rank` and not in `render` (#7), and why the audit may reject an artifact but never edit one outside its own slot (#8).
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

## Harvest reads through `gh api` only

Never a convenience wrapper, and never GraphQL `bodyText`. #4's resolution is the finding that a wrapper truncated every one of swe-prep's nine resolution comments to ~15% of its content while reporting a character count that was itself wrong - so a wrapper's self-report is not a fidelity check. `bodyText` is a markdown-stripped projection that reads shorter **by design**; it must not be used even as a length cross-check.

Completeness is verified per issue against the count GitHub itself reports, and a mismatch is a hard failure. `test/harvest/harvest.test.ts` carries the byte-pinned tripwire: a real comment's exact length and SHA-256. It skips without `gh` auth (a statement about the machine) and CI asserts auth so the skip cannot hide a regression.

## Probes and the gate

A probe is a **pure deterministic function** over harvest artifacts: no network, no model calls, ever (#5). Adding one is a module in `src/probes/library/`, an entry in `src/probes/registry.ts`, and a fixture test - no core changes. A probe that finds nothing emits nothing; a probe that does not apply says so **by name**, because a subject with no Java must not look identical to one where every Java probe ran and found nothing.

Probes emit **candidates**, never final nodes. The gate confirms, the rank stage accepts or deletes.

The existence gate runs in **both directions** (#7 point 7), and the single-direction version is the one already found wrong on the reference subject: a stated decision is not evidence of implementation, and an open ticket is not evidence of absence. A confirmed contradiction becomes a `divergence` edge rather than being dropped. A claim nothing in the tree can settle is **demoted, never admitted as checked**.

Flow is the atomic exception to that generic outcome path (#35): every links-based candidate needs one `flow_claims` entry per arrow, and one unresolved, stale, or contradicted arrow quarantines the **whole** Flow as `absent` - never attested, partial, or converted to a subject divergence. Direct-call, exact Spring-route, data-access and closed-dispatch matchers resolve now; `reachability` deliberately fails closed until PR 7's shared-state fan-out adds the closed negative proof it needs. Legacy `calls_next` remains a render input only and cannot enter as a newly verified candidate.

## The Flow producer

`src/probes/flow/` is the shared machinery and `src/probes/library/flow-java-*.ts` are the registered adapters (#35, PRs 4-5). One entry family per adapter, deliberately: "no Spring here" and "no runnable main here" are different findings, which is what the `Probe.applies` hook exists for - a framework-level applicability answer the toolchain test cannot give.

Three rules make it more than a call-graph walker, and each is easy to erase by accident:

- **A gap anywhere the entry reaches quarantines the whole candidate**, not merely a gap on a path that survived pruning.
Scoping it to survivors turns pruning into a way to walk around an unresolved dispatch and still draw a confident picture, which is the "path that stops when resolution becomes difficult" the design forbids.
Every stop is an `absent` candidate whose `absent_reason` starts with a kind token (`unresolved_dispatch:`, `no_terminal_reached:`, ...) so the record can count failures without string-matching a sentence.
- **The producer resolves no further than the gate can re-resolve.**
They are independent derivations - a parse tree against a blob reread - so they must fail closed on the same line, or a real chain returns as a confusing quarantine.
That is why a receiver held in ANOTHER type's field and a chained call other than a bare accessor declared in the calling file are named limits rather than traced edges, and why `normalizedRoute` (`src/probes/flow/route.ts`) is shared by both while the resolution stays split, exactly as `manifests.ts` shares one definition of "declared".
A `var` local is typed from its initialiser so an implicit accessor is not reported as a hole, but it is marked gate-blind and never used to draw an arrow.
- **The producer has no budget expressed in rendered boxes.** `BOUNDS` holds two mechanical explosion guards (16 path edges, 200 symbols) and nothing else.
A box count is a readability judgement, and readability lives in the renderer (which warns above eight steps) and selection lives in rank (#9, and #39's Flow budget of two).
PR 4 carried an eight-landmark quarantine; it deleted a fully verified 23-box story on the reference subject, which is the "second authority over what survives" the whole pipeline forbids.

**Closed-set dispatch** (`src/probes/flow/dispatch.ts`, #35 PR 5) is what lets a call through an interface be traced at all.
A set is closed only when the subject's own wiring closes it: a sole implementation, a `sealed` base, or every implementation carrying a Spring stereotype.
A closed set of several members FANS OUT into one labelled, separately evidenced arrow per member - never a chosen "obvious" implementation - and the branch label comes from the tree: a `supports()` predicate over a sealed hierarchy, a keyed registry's literal, otherwise the implementation's own name.
A call to the guard method itself is dispatch machinery, not a step, so the figure shows what the registry routes to rather than how it decided.
The gate re-enumerates the whole set textually from the blob and refuses a claim whose member count moved - proving the target exists says nothing about whether it is the only thing the call can reach.

**Landmark compression** draws one box per component, where a component is what the subject declares itself to have: a Spring bean, a durable-storage boundary, a terminal, the entry, or a collaborator the caller HOLDS.
A static helper or a `new`-ed value builder is an implementation detail of the component that called it and belongs inside its box.
One box per TYPE, never per method, and every method an arrow touches is named in the box it touches - otherwise the gate's `stepNamesSymbol` check rightly refuses to match the claim to the rendered endpoint.

What the reference subject yields is measured, not predicted: `test/fixtures/swe-prep.flow-producer.json` pins it, carries the command that regenerates it against a swe-prep clone, and is asserted by `test/run/parity.test.ts`.
At `086c999` twenty of twenty-three routes verify, no candidate is cut at a dispatch, and the submission walkthrough #35 exists to recover is verified through the gate at 23 components and 49 independently re-resolved links.

`assets/tree-sitter-java.wasm` is vendored deliberately. The only npm package shipping a prebuilt Java grammar bundles ~40 of them at 50 MB for one 430 KB file, which is not a defensible npx footprint. `web-tree-sitter` is pinned to the ABI that grammar was built against - **the two move together or not at all**.

## Write

The one model stage besides scoring, and the only place a model reads a decision record (#2). Probes are pure deterministic functions and #5 forecloses model-assisted ones, so nothing mechanical can turn a resolution comment into a decision, a why and the alternative that lost. `repo-atlas write` runs the model locally through an authenticated CLI and commits `written.json`, exactly as `score` commits its scores; CI assembles from the pinned file and holds no credential. The prompt is a versioned asset (`prompts/write-v1.md`, #9's rule), and `assertWriteFresh` - the loader, not a caller that must remember - refuses a set whose prompt digest, version or subject SHA no longer matches.

The writer emits **candidates, not nodes**, and runs BEFORE the gate: nothing else could mint a Decision, yet whether one was built is a claim about the tree only the gate may settle. So `clampStatus` allows the model `decided` or `superseded` only, and `settleBuild` in the gate promotes a confirmed present-claim to `decided_and_built` - filling `implemented_by` with the paths the gate itself located - a confirmed absent-claim to `decided_not_built`, and never moves a `superseded` node. Two rules the prompt and `claimOf` enforce: a comment settling nothing yields an `absent` candidate (cut, not dropped, so #6's silence rule holds - and only a well-formed model verdict may produce that cut, an unreadable reply is not a record that a comment settles nothing), and an `implementation_claim` must be about the decision's OWN subject and name something machine-checkable, a path or a compilable pattern, never a prose-matchable word.

`src/model/ask.ts` is the **one SDK call site**, and `test/model/ask-lint.test.ts` fails the build if a second import of `@anthropic-ai/claude-agent-sdk` appears - the same rule as the renderer's `raw()`. The three callers (write, score, the audit judge) each wrote their own options and each got the tool restriction wrong the same way: `allowedTools: []` is a permission allowlist that leaves the built-in tools in the model's context, while `tools: []` removes them. A scorer or judge that can read the tree still returns plausible output, so nothing fails and the guarantee just stops holding - which is why it is structural, not remembered.

## Ranking

`rubric/interview-v1.md` is a **prompt asset**, versioned and changed only by commit (#9). Per-project overrides are data and may pin, boost or suppress; they may not rewrite the rubric. Every override carries a required `why`, because the file is also the calibration record for future rubric revisions.

`src/rank/rank.ts` is the **only** place deletion happens. Both mechanisms are required - floor and per-section budgets - and every cut is recorded with id, score and reason for #8's G2. The Flow section budget is archetype-aware (#39): after the floor it keeps two Flows, one request/response and one shared-state/data-lineage slot, so near-duplicate routes cannot spend both. The mechanical archetype classification and the evidence-free scoring projection both live in `src/rank/flow.ts`; a Flow with no verified entry signal is `unknown` and may only fill a slot the two preferred archetypes leave open, never displace one.

Scoring sits behind the `Scorer` seam in `src/rank/scorer.ts`. `repo-atlas score` runs the model scorer locally through an authenticated CLI; its output is **committed** as `test/fixtures/swe-prep.scores.json`, so CI verifies the deterministic machinery against real scores without holding a credential. CI never calls a model. The score file records the model the SDK reported for the run beside the rubric digest, so refreshing the fixture shows which of the two moved; the digest helper lives in `scorer.ts` (no SDK import) so the credential-free rank path never loads the model SDK.

Refresh the pinned scores with `repo-atlas score` after any rubric change. `scoresFromFile` - the loader, not a caller that must remember - refuses a score set whose **rubric digest** no longer matches: it takes the rubric text and checks freshness itself, so no path into ranking can route around it. A rubric can be reworded without its version moving, and reusing scores made against the old wording would be the "verified, not asserted" failure one level up.

The scorer gets one call for the whole graph (ranking is comparative, and a per-call cost multiplied by node count is real), no tools (it orders what was established and may not add to it), and no evidence in its prompt (the rubric says evidence is a gate, not a score).

Note on the reference fixture: `test/fixtures/swe-prep.atlas.json` keeps two nodes scored below the floor its own deletion record states, because its scores are hand-authored rather than model-produced (see #7's report). The resolution governs over the fixture; the discrepancy is pinned by a test in `test/rank/rank.test.ts` rather than accommodated.

## The audit's two standing rules

- **No check ships without a mutant fixture proving it fails** (#8). `test/mutants/` holds one deliberately-broken artifact per check, and `test/audit/pass-a.test.ts` asserts each check rejects its own mutant and only its own. A check that has never been watched fail is a check nobody knows works.
- **A check that could not run says so by name.** `not_applicable` and `not_run` carry a mandatory reason, and neither ever counts as passing. All four passes are built, but a given invocation may not run every check - `--no-browser`, `--no-model`, an empty harvest cache (L3), or an earlier blocking gate can each leave a pass unrun - and the audit reports all twenty by name regardless, for the same reason #6 forbids communicating absence by silence.

The audit slot is the only part of a rendered artifact the audit may write, and **everything it writes must live inside the slot** - including the state class, which is why the statement wraps itself rather than the slot element carrying an attribute. An attribute on the slot element sits outside the blanked content, so writing it falsifies the hash the statement prints. `stampAudit` asserts the hash is unchanged and refuses otherwise; that assertion caught this exact defect, and a non-greedy slot scanner that ended the slot at the first nested closing tag.

`repo-atlas audit` rewrites the `--atlas` file to mirror its result into `record.audit` (#8, 7.1). Tests must therefore work on a **copy** of a fixture, never the committed one.

Pass B needs a Chrome-family browser (`puppeteer-core` drives one that is already installed; set `CHROME_PATH` if it is somewhere unusual). A missing browser is a **precondition failure** for a real audit, not a skip - an audit that cannot open the file must never report on it. The test suite is the one exception: it skips the browser tests when none exists, and CI asserts one is present so that skip cannot quietly disable five gates.

Anything handed to `page.evaluate` is compiled by the toolchain first, and esbuild's keep-names transform rewrites inner helpers into `__name(...)` calls that do not exist in the browser - the symptom is `__name is not defined` and an audit that crashes rather than reporting. In-page code with helper functions is therefore written as a **source string** (`src/audit/checks/visual.ts`), not as a function.

Audit tests build a synthetic subject (`test/audit/subject.ts`): a real git repo holding exactly the files the reference graph cites, with the graph re-pinned to its commit. That keeps L1/L2 hermetic - no network, no 40 MB checkout - while still exercising the real `git cat-file` comparison.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
