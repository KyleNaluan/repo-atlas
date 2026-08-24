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

## v1 acceptance (#1) is now demonstrated on both halves

#1's bar is two credentialed `repo-atlas run`s, not one: parity with the hand-made swe-prep overview, and honest degradation on a decision-poor subject. The second half went undemonstrated for a while - fixtures existed, but never a fresh end-to-end run judged against the bar - until both ran together: `test/fixtures/swe-prep.pipeline.*.json` (27 nodes, up from 18 once #50/#51's probes were scored and ranked in) and `test/fixtures/java-websocket.*.json` (15 nodes; flows, decisions and mechanisms correctly absent; 8 tracker/tree divergences found). Both audits came back `passed_with_warnings`.

Two things worth knowing before touching either subject again:
- **`claude-fable-5` was unusable in the environment both runs executed in** - three spaced `claude --print` smoke tests each timed out with zero output, while the identical call against `claude-sonnet-5` returned in seconds. Both runs used sonnet-5 for write and score, recorded in each fixture's own `model` field. Re-running on fable-5 once it is reachable again is a standing follow-up, not a silent acceptance of the substitution.
- **The hostile subject exposed a real, narrow gate gap**: `decided-but-unbuilt` candidates the gate overturns (a regex pattern found somewhere in a file, contradicting an open "not built" ticket) cite that file with no line range, because `treeHas` (`src/gate/gate.ts`) records which files a pattern matched, never where. The audit's own M1/M2 pass correctly flags the resulting divergence claims as under-evidenced (see `test/run/degradation.test.ts`'s docstring). Advisory only, not a hard-gate failure, and not fixed here - `treeHas` would need to capture match position for every pattern-claim probe, a shared-surface change that deserves its own PR.

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

**A probe may not mint `verified` for what its own reading did not establish** (#28).
`Probe.reading` is the contract field and `heuristic` is its DEFAULT, so a new grep-class probe inherits the rule without opting in; `clampConfidenceToReading` (`src/probes/types.ts`) applies it once in `runProbes`, where every candidate is collected.
A probe declares `reading: "direct"` only when the reading IS the finding - a parse tree, an enumeration of the tree, a captured command's output, or a literal token cited at the line it was read from - so a reader who follows the citation sees the asserted fact itself.
Everything else ships `attested` unless it hands the gate something to re-resolve (`claims`, or a Flow's `flow_claims`), in which case the gate settles it and reaching `verified` is earned rather than assumed.
The ceiling is not lowered, only unearned confidence removed, and the clamp only ever moves confidence DOWNWARDS: promoting would make it a second authority over what survives.
The defect that closed this: during the #19 build `ci-policy-guards` matched policy vocabulary against any raw line, so a YAML comment minted a `verified` mechanism asserting a CI step that did not exist, and the candidate carried no claim for the gate to catch it on.
#28 rejected both requiring a claim from every text probe (the gate re-deriving the same judgement from the same file is the self-report weakness #4 warns about) and trusting each future probe to be precise (which is what failed).

`src/probes/manifests.ts` (`MANIFESTS`, `declaredIn`) is one definition of "declared" the dependency-divergence probe and the gate both call, so a manifest neither side can read demotes rather than confirms - never the reverse. It covers `pom.xml`, Gradle, `package.json`, and `pyproject.toml` (PEP 621 `dependencies`/`optional-dependencies`, PEP 735 `dependency-groups`, uv's own `tool.uv.dev-dependencies`). A `pyproject.toml` using none of those four sites - legacy Poetry `[tool.poetry.dependencies]`, not yet supported - is unrecognized and demotes, never confirmed empty. TOML is read structurally by a hand-rolled reader (`src/probes/toml.ts`) scoped to tables and string arrays - no vendored TOML grammar or npm dependency exists, the same call the pom.xml/Gradle regex readers already made (#5: grep-class is fine for a text question). `requirements.txt` was deliberately left unsupported: a VCS or direct-reference line's package name is not near-free to read without real false-positive risk.

The existence gate runs in **both directions** (#7 point 7), and the single-direction version is the one already found wrong on the reference subject: a stated decision is not evidence of implementation, and an open ticket is not evidence of absence. A confirmed contradiction becomes a `divergence` edge rather than being dropped. A claim nothing in the tree can settle is **demoted, never admitted as checked**.

Flow is the atomic exception to that generic outcome path (#35): every links-based candidate needs at least one `flow_claims` entry per arrow and a claim for every line that arrow cites, and one unresolved, stale, or contradicted arrow quarantines the **whole** Flow as `absent` - never attested, partial, or converted to a subject divergence. Every matcher now resolves: direct-call, exact Spring-route, data-access, closed-dispatch, `data_lineage`, the closed negative `reachability`, and PR 8's three caller-less entries - `scheduled_trigger`, `message_listener` and `process_launch`. Legacy `calls_next` remains a render input only and cannot enter as a newly verified candidate.

## The boundary producers, and what coverage is measured against

The three boundary probes (`orthogonal-hierarchies`, `partitioned-implementations`, `superset-enum`) each read a RELATIONSHIP BETWEEN TWO DECLARATIONS, which is why no single-declaration probe could ever mint one: two sealed hierarchies a carrier holds one of each of, an implementation set split on whether it holds anything from a package, an enum that is a strict superset of another.
They share `src/probes/declared.ts` - one definition of what Java types this subject declares - for the reason `manifests.ts` shares one definition of "declared" and `sql.ts` one definition of "a read": two boundaries drawn on one subject must not rest on two readings of it.
`partitioned-implementations` splits on a PACKAGE, not a field, and requires at least two abstainers, so a lone dissenter stays `dependency-asymmetry`'s finding rather than being minted twice in two vocabularies.

**How far extraction reaches is measured, not asserted**: `test/fixtures/swe-prep.probe-coverage.json` accounts for all 33 reference nodes - 22 with a named producer, 11 with the standing decision that forecloses each - and `test/run/parity.test.ts` asserts the accounting is complete and that every unminted row states a reason.
Read that fixture before proposing a new probe for this subject: most of the residual is not missing machinery but the write stage's territory (#2 gives reading a decision record to the model alone), a suite run (#5 forecloses execution), or a deliberate refusal to widen a comment vocabulary until it matches (#28).

Note the two numbers move independently. The committed artifact's node count is what SHIPPED and moves only when a credentialed `repo-atlas score` + `repo-atlas run` is repeated; what the engine can ESTABLISH moves whenever the probes do. `rank` refuses an unscored node (`MissingScoreError`), so new gate-confirmed candidates cannot reach a document without refreshing the pinned scores.

## The Flow producer

`src/probes/flow/` is the shared machinery and `src/probes/library/flow-*.ts` are the seven registered adapters (#35, PRs 4-8). One family per adapter, deliberately: "no Spring here", "no runnable main here", "no frontend calls anything here", "nothing here stores a record it derives from", "no batch work here", "nothing consumed here" and "no unit files here" are seven different findings, which is what the `Probe.applies` hook exists for - a framework-level applicability answer the toolchain test cannot give.

Three rules make it more than a call-graph walker, and each is easy to erase by accident:

- **A gap anywhere the entry reaches quarantines the whole candidate**, not merely a gap on a path that survived pruning.
Scoping it to survivors turns pruning into a way to walk around an unresolved dispatch and still draw a confident picture, which is the "path that stops when resolution becomes difficult" the design forbids.
Every stop is an `absent` candidate whose `absent_reason` starts with a kind token (`unresolved_dispatch:`, `no_terminal_reached:`, ...) so the record can count failures without string-matching a sentence.
- **The producer resolves no further than the gate can re-resolve.**
They are independent derivations - a parse tree against a blob reread - so they must fail closed on the same line, or a real chain returns as a confusing quarantine.
That is why a receiver held in ANOTHER type's field and a chained call other than a bare accessor declared in the calling file are named limits rather than traced edges, and why `normalizedRoute` (`src/probes/flow/route.ts`) is shared by both while the resolution stays split, exactly as `manifests.ts` shares one definition of "declared".
A `var` local is typed from its initialiser so an implicit accessor is not reported as a hole, but it is marked gate-blind and never used to draw an arrow.
- **The producer has no budget expressed in rendered boxes.** `BOUNDS` holds two mechanical explosion guards (16 path edges, 200 symbols) and nothing else.
A box count is a readability judgement, and readability lives in the renderer and selection lives in rank (#9, and #39's Flow budget of two).
PR 4 carried an eight-landmark quarantine; it deleted a fully verified 23-box story on the reference subject, which is the "second authority over what survives" the whole pipeline forbids.
Readability is measured as `narrativeDepth` (`src/render/diagram.ts`): the LONGEST PATH a reader follows, not the box count, because a fan-out draws alternatives beside that path rather than extending it, and `rankdir=LR` lays the graph out along exactly that depth. Counting boxes is what would push a producer to hide a branch to fit a budget.

**Closed-set dispatch** (`src/probes/flow/dispatch.ts`, #35 PR 5) is what lets a call through an interface be traced at all.
A set is closed only when the subject's own wiring closes it: a sole implementation, a `sealed` base, or every implementation carrying a Spring stereotype.
A closed set of several members FANS OUT into one labelled, separately evidenced arrow per member - never a chosen "obvious" implementation - and the branch label comes from the tree: a `supports()` predicate over a sealed hierarchy, a keyed registry's literal, otherwise the implementation's own name.
A call to the guard method itself is dispatch machinery, not a step, so the figure shows what the registry routes to rather than how it decided.
The gate re-enumerates the whole set textually from the blob and refuses a claim whose member count moved - proving the target exists says nothing about whether it is the only thing the call can reach.

**Landmark compression** draws one box per component, where a component is what the subject declares itself to have: a Spring bean, a durable-storage boundary, a terminal, the entry, or a collaborator the caller HOLDS.
A static helper or a `new`-ed value builder is an implementation detail of the component that called it and belongs inside its box.
One box per TYPE, never per method, and every method an arrow touches is named in the box it touches - otherwise the gate's `stepNamesSymbol` check rightly refuses to match the claim to the rendered endpoint.
**One arrow per RELATIONSHIP** (PR 6), not per call: two components and one typed relation is one arrow carrying every call site as its own evidence AND its own atomic claim, so the gate still re-resolves each one and `linkEvidenceMatchesClaims` refuses an arrow citing a line no claim covers. `dispatch` is the exception, because its label is a branch predicate the tree names and two branches are two executions. Labels stack one name per line (`\l`); in `rankdir=LR` a comma-joined list is laid out as width.

**The transport seam** (`src/probes/flow/http-client.ts`, #35 PR 6) is the one cross-language stitch, and it is narrow because there is no vendored TypeScript grammar: the module is read LEXICALLY (comments, strings and template substitutions masked before any structural scan) and everything it cannot pin exactly is a named cut - `dynamic_path:`, `generated_path:`, `dynamic_request_init:`, `no_subject_route:`, `route_method_mismatch:`.
A call is an HTTP call only where the subject's own wiring says so: `fetch`, or a function this subject declares that forwards its first parameter into `fetch`'s URL and adds no literal path text of its own - the same shape as closed-set dispatch, which is why `apiFetch` can be followed and an arbitrary `post()` cannot.
Matching is on verb AND normalized path, never path text (swe-prep writes GET and POST against several identical paths). The gate re-derives the endpoint from the CITED SPAN with its own scanner and re-derives the wrapper from the span the claim cites beside the guard, sharing only `normalizedRoute`.
A stitched call emits NO candidate of its own: it is a transport arrow inside that route's Flow, so one route stays one story in front of #39's budget of two. `flow-typescript-http-client` emits only what it could not stitch.
Like every other arrow, a transport arrow carries one atomic claim PER call site (each citing its own call span, the wrapper, and the handler), so a module that POSTs a route from two actions is re-resolved at each site independently and a call site that stops calling cannot ride in on the one beside it - the `clientEstablishes` loop only ever sees the one cited span (plus a same-file wrapper declaration, which establishes no endpoint of its own).

**The shared-state fan-out** (`src/probes/flow/lineage.ts`, #35 PR 7) is the SECOND TRACE MODE, not a request Flow with a different entry, and it is the only place an arrow is drawn backwards from the call that proves it.
It starts at a durable record - a storage type the subject both writes and reads with its own SQL, read by `sql.ts`'s one shared definition rather than by a method-name convention (`cleanPassInstants` matches no read verb and is the subject's most load-bearing read) - and fans out to the services that derive from it.
A branch is admitted on what the subject DECLARES: a container-managed service that holds the record, reads it without writing it, and hands the result to a named pure type it calls ITSELF; three of them are required before there is a story, and a hub with fewer is an absent cut naming its own count and every refusal.
**Within a branch the atomic rule is unchanged** - a gap anywhere the reading method reaches refuses that whole branch, and each such refusal is its own named absent candidate - but the rule is scoped PER BRANCH here, deliberately: the hub executes nothing, so one untraceable reader is not a hole in another reader's execution, and each arrow is its own claim.
Arrows run the way the DATA travels, which is why `data_lineage` is a separate matcher from `data_access` rather than a `read` arrow whose orientation the gate guesses: it declares that the claim names the reader as `from` and the record as `to`, and the gate checks endpoint agreement in that order (accepting either order would accept a swapped arrow).
Labels carry a code identifier and the literal SQL predicate the read's own query writes, and **the label is checked** - once per arrow, over the union of its claims' cited spans, because one arrow bundles every call site between two components.
**The closed negative** ("no derivation drawn here reaches another") is admissible only when a conservative reachability closure over the subject's symbol graph misses every ordered pair, and is OMITTED ENTIRELY otherwise - never weakened to "appear independent".
The closure is coarse on purpose (a file that names a type in code can reach it; a type whose declaration header names something in the closure joins it, which is what stops an implementation behind an interface from hiding) and both sides share only what `mentions` means: comments and string literals are masked, because a javadoc cross-reference is not a call. It is sound modulo reflection, and says so.

**The caller-less entries** (`src/probes/flow/trigger.ts` and `unit.ts`, #35 PR 8) are the three families with nothing in the tree that calls them: a clock, a broker, and a systemd unit.
There is no call site to re-resolve, so what the gate re-resolves is the DECLARATION that establishes the trigger and everything the entry box prints about it.
A `@Scheduled` method needs three things and each is checked: the annotation with the expression the figure shows, a container-managed declaring type, and an `@EnableScheduling` the claim CITES - Spring Boot autoconfigures the listener containers but not scheduling, so a subject that never writes it runs none of those methods.
A listener claims the SUBSCRIPTION and never the publisher (a topic's producer may not be in this subject at all); the in-process `publishEvent` stitch is unbuilt and named as such, exactly as PR 4 claimed a route in a caption until PR 6 had a caller.
A unit is read lexically by `unit.ts` (comment lines dropped, continuations joined, directives outside `[Service]` ignored) and only a FULLY QUALIFIED class the subject declares a `main` for is followed - a bare word in an `ExecStart` is a program on `PATH` as often as a class, so it is `ambiguous_exec_target:` rather than a guess, beside `unresolved_exec_target:` and `no_exec_start:`.
A stitched unit becomes a launch arrow inside `flow-java-cli`'s Flow and `flow-systemd-unit` emits only what it could not stitch, the same split as the HTTP seam.
That arrow is a `transport` relation with NO `request` kind, which is why `flowArchetype` reads the request signal off the `request` KIND rather than the transport relation (#39 reserves the request/response slot for a verified request signal, and a timer firing is not one): all three families classify `unknown` and may fill only capacity the two preferred archetypes leave open.
Note `reachability.ts` now exports two masks - `maskedJava` blanks strings as well as comments and answers "where is code", while `withoutComments` keeps strings and is what reads a trigger expression, because a cron string masked the first way reports an empty schedule.

What the reference subject yields is measured, not predicted: `test/fixtures/swe-prep.flow-producer.json` pins it, carries the command that regenerates it against a swe-prep clone, and is asserted by `test/run/parity.test.ts`.
At `086c999` twenty of twenty-three routes verify, no candidate is cut at a dispatch, every one of the twenty has a verified frontend caller, and the submission walkthrough #35 exists to recover is verified through the gate at 25 components (Practice.tsx and Warmup.tsx included) and 32 independently re-resolved links - eight landmarks deep, with nothing hidden to reach that number.
The second archetype is there too: `SubmissionRepository` fans out to `LearnedCriterion` (`s.outcome = 'PASSED'`), `ConfusionPairs` (`s.outcome = 'FAILED'`) and `ChallengeQuality`, verified at 14 boxes and 14 links with twelve closed negative claims behind its independence sentence - while `AttemptRepository`'s own three-branch story verifies and prints no such sentence, because one of its branches can reach another's read model.
PR 8's three adapters move none of those numbers on this subject, which is the point of re-measuring rather than predicting: the two Spring ones apply and find nothing (0 `@Scheduled`, 0 listeners), and the one `.service` runs `__REPO_PATH__/scripts/daily-cue.sh` - an install-time placeholder in front of a wrapper script - so it is one `unresolved_exec_target:` cut that names itself rather than a drawn Flow.

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
