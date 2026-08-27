# repo-atlas

Evidence-linked, self-contained static overviews of a repository.

repo-atlas is an **evidence-linker with a strong opinion about what to leave out**, not a summariser.
It reads a repository and its issue tracker at a pinned commit, extracts decisions with their rejected alternatives, the mechanisms that enforce them, the boundaries that carry weight and the edges that are honestly unfinished, ranks them by what is worth saying out loud, deletes the rest, and emits one HTML file that makes zero network requests.

Every claim in that file traces to a file at the pinned SHA, a linked issue or comment, or captured command output.
Anything that could not be traced is cut, not hedged.
On a repository with no decision record, the artifact says so - it never reconstructs a decision trail from commit archaeology.

**Status: under construction.** The complete v1 design is closed on this tracker: issues [#1](https://github.com/KyleNaluan/repo-atlas/issues/1)-[#10](https://github.com/KyleNaluan/repo-atlas/issues/10), each with a binding `## Resolution:` comment recording the decision, the why, and the rejected alternatives.
This build ships the `atlas.json` contract, the harvest stage, the probe library, the write stage that reads each decision record into a candidate, the existence gate over both, the model scorer and the rank stage's deterministic half, the assemble stage that joins a run into the `atlas.json` contract, the render stage, the full audit - its deterministic passes and the advisory model pass - with its stamp, and the `run` orchestrator that drives all nine stages over one SHA-keyed work directory that acts as the cache.
Every registered stage is now built.
What remains is not a missing stage but a shortfall in what the assembled artifact surfaces: the one-flow-end-to-end section now has its full producer - seven JVM and TypeScript adapters covering Java/Spring routes, runnable Java mains, the narrow TypeScript/TSX client that stitches a frontend call to the route it names, the shared-state fan-out that starts at a durable record instead of at an entry, and the three caller-less entries nothing in the tree invokes - a Spring `@Scheduled` clock, a message subscription, and a systemd unit whose `ExecStart` launches a subject-owned main - and on the reference subject that producer verifies the submission narrative browser-to-terminal at 25 components and 32 independently re-resolved links, plus the second archetype #35 named: one record fanning out to three independent derivations, each labelled by its own literal SQL predicate.
The registry interface it once cut at was closed by closed-set dispatch ([#44](https://github.com/KyleNaluan/repo-atlas/issues/44)); the shortfall then moved to the committed end-to-end artifact, which predated any Flow producer and needed a credentialed model score run to regenerate, because rank refuses unscored nodes.
That run has now happened: the committed artifact reports section 04 present, with both the submission narrative and the shared-state fan-out surviving the gate at the same figures this README states above.
The shortfall then moved once more, to the probe library: no boundary candidate survived the floor on this subject, because the only boundary producer compared directory siblings field by field and found three constructor asymmetries in test classes, while the reference's four boundaries are architectural seams.
Three producers now read those seams - two sealed hierarchies a carrier holds one of each of, an implementation set split on whether it holds anything from a package, an enum that is a strict superset of another - beside a fourth that reports the tests which abort themselves rather than fail, so a green suite cannot imply they ran.
How far extraction reaches is now measured node by node rather than summarised as a count: `test/fixtures/swe-prep.probe-coverage.json` accounts for all 33 reference nodes, 22 with a named producer and 11 with the standing decision that forecloses each, and `test/run/parity.test.ts` fails if a single one goes unaccounted for or unexplained.
That run has also now happened: the committed artifact reports 27 nodes, five of them boundaries, all of them new since the pre-#50 artifact carried none.
The eight newly gate-confirmed candidates the previous paragraph named are the ones now scored and ranked in.
The one deviation this run took is pinned rather than implied: `claude-fable-5` was unusable in the environment the run executed in, so `claude-sonnet-5` scored and wrote it instead, recorded in `test/fixtures/swe-prep.probe-coverage.json`'s `committed_artifact` note rather than left for a reader to discover from a model field that moved without explanation.

```
npx repo-atlas run --clone ../subject -o overview.html
```

Or drive the stages by hand; `run` calls the same command functions the subcommands do, so the two cannot diverge:

```
npx repo-atlas harvest --clone ../subject -o harvest.json
npx repo-atlas render atlas.json -o overview.html
npx repo-atlas audit overview.html --atlas atlas.json --clone ../subject
```

## The pipeline

Each stage is a subcommand (per [#2](https://github.com/KyleNaluan/repo-atlas/issues/2)), reading and writing a content-addressed cache keyed on the pinned SHA, with a top-level `run` orchestrator.
The mechanical stages are plain deterministic code; only `write`, `score` and `audit` call a model, and the model controls no flow.

| Stage | What it does | Ticket |
|---|---|---|
| `harvest` | fetch the subject at a pinned SHA through raw API paths, count-verified | [#4](https://github.com/KyleNaluan/repo-atlas/issues/4) |
| `probe` | run the mechanical probe library, emitting candidate nodes | [#5](https://github.com/KyleNaluan/repo-atlas/issues/5) |
| `write` | read each decision record - an issue resolution comment, or one the tree declares - into a decision candidate, and write the prose | [#2](https://github.com/KyleNaluan/repo-atlas/issues/2) |
| `gate` | confirm each candidate against the tree, in both directions | [#5](https://github.com/KyleNaluan/repo-atlas/issues/5), [#7](https://github.com/KyleNaluan/repo-atlas/issues/7) |
| `score` | score `interview_value` with a model under the versioned rubric, one call for the whole graph | [#2](https://github.com/KyleNaluan/repo-atlas/issues/2), [#9](https://github.com/KyleNaluan/repo-atlas/issues/9) |
| `rank` | delete by floor and budget under the pinned scores | [#9](https://github.com/KyleNaluan/repo-atlas/issues/9) |
| `assemble` | join harvest, gate and rank into one `atlas.json`, validated closed - adds no claim of its own | [#3](https://github.com/KyleNaluan/repo-atlas/issues/3), [#6](https://github.com/KyleNaluan/repo-atlas/issues/6) |
| `render` | `atlas.json` -> one self-contained HTML artifact | [#7](https://github.com/KyleNaluan/repo-atlas/issues/7) |
| `audit` | twenty checks, fifteen hard gates; stamps its own result into the artifact | [#8](https://github.com/KyleNaluan/repo-atlas/issues/8) |
| `run` | drive every stage over one SHA-keyed work directory that acts as the cache | [#2](https://github.com/KyleNaluan/repo-atlas/issues/2) |
| `validate` | check an `atlas.json` against the generated JSON Schema, fail closed | [#3](https://github.com/KyleNaluan/repo-atlas/issues/3) |

## Harvest

Issues and comments come through raw `gh api` paths only.
A convenience CLI's issue view truncates comment bodies - it cut every one of the reference subject's nine resolution comments to about 15% of its content, hiding ~39 KB of the richest input the engine has - and its own character accounting was wrong, so a wrapper's self-report is not a fidelity check.

Completeness is **verified**, per issue, against the count GitHub itself reports; a mismatch is a hard failure rather than a warning, because a truncating fetch returns well-formed JSON that simply contains less than it should.
A byte-pinned tripwire test holds a real comment's exact length and SHA-256, so a regression fails loudly instead of quietly shortening the decision record.

The cache is keyed on `(repo, issue, issue.updated_at, comment_count, max(comment.updated_at))`, so editing a comment invalidates the entry - `issue.updated_at` does not move when a comment changes - and comments are stored individually by id, because an issue body and its resolution are different artifacts.

A declared-private side is never read. That it exists is recorded, because the audit's private-source check has three applicability states and the middle one must never be silent.

### The two decision sources

Issue resolution comments are the first source and are not the only one ([#55](https://github.com/KyleNaluan/repo-atlas/issues/55)).
Measured across the corpus, that source is empty on three of the four subjects this engine is meant to run on - 0 of 16 issues on one, 0 of 13 on another, 0 of 39 on a third, against ~10 of 50 and 12 of 27 on the two that use it.
Those three subjects are not decision-poor; they record decisions in the tree, so harvest reads the tree as a second source.

A span of committed markdown is a decision record only where the **subject's own declaration** says so, in one of four ways:

| Family | What declares it |
|---|---|
| `adr_directory` | a file under `docs/adr`, `adr`, `doc/adr`, `docs/decisions` or `docs/architecture` - the same list [#6](https://github.com/KyleNaluan/repo-atlas/issues/6)'s ADR density signal reads, so the signal and the reader cannot disagree |
| `named_file` | a file whose own basename names it a decision record (`adr`/`decision` as a whole word), wherever it sits |
| `memory_section` | a section of a project-memory file under a heading naming a decision |
| `document_section` | a section of any other committed document under such a heading |

A whole-file record is one record and is never also scanned for sections, so an ADR's own `## Decision` heading does not mint a second.
A project-memory file is never admitted whole - it is a mixed document, and only its decision-headed sections are records.

It is a heading match and never a body match.
A heading is the subject writing "what follows is a decision"; a paragraph containing the word is not, and [#28](https://github.com/KyleNaluan/repo-atlas/issues/28) is what matching vocabulary against raw lines already cost this engine once.
The vocabulary deliberately **over-admits** - one subject's `### Decision Log` is a component description, not a decision - because mechanics propose and judgement deletes: the writer already owns the admissibility call, and an inadmissible record becomes an absent cut carrying its reason rather than a silent drop.

**A record establishes nothing about the code.** [#4](https://github.com/KyleNaluan/repo-atlas/issues/4) resolved that project-memory files are indexed and never evidence-quoted; #55 amends that line narrowly and keeps its guarantee whole.
A record is testimony about a *decision*, the same class of artifact as a resolution comment; whether the decision was built stays a claim about the tree that only the gate settles, and `implemented_by` is filled from paths the gate itself located.
Harvest's source table says both, separately: memory files stay `not admissible as evidence about the code`, and the records read out of them are their own line reading `attested (the decision, never the code)`.

## Probes and the existence gate

Eleven discovery probes, each encoding one piece of human judgement about what is worth finding - a sealed hierarchy's closed enumeration, a method that refuses where its siblings return, a predicate repeated across queries until it is an invariant, a CI step that guards policy rather than testing code, and three boundaries that live in the relationship between two declarations rather than in either alone: two sealed hierarchies one carrier type holds one of each of, an implementation set split on whether it holds anything from a whole package, and an enum that strictly contains another.
Three further probes fill node types nothing else in the pipeline mints: one restates the harvest's already-measured figures as the stat tiles the overview opens with, each citing the command that reproduces it at the pinned SHA, and two turn a coverage gap into a `coverage_gap` edge rather than inventing a rationale for it ([#6](https://github.com/KyleNaluan/repo-atlas/issues/6) point 3) - one from a source citation the record never explains, the other from a test that aborts itself with a JUnit assumption rather than failing, so a green suite is not evidence it ran.
Ten Flow adapters trace an execution story ([#35](https://github.com/KyleNaluan/repo-atlas/issues/35), extended to Python by [#52](https://github.com/KyleNaluan/repo-atlas/issues/52)).
Three start from where the outside world reaches the subject: Spring HTTP routes, class-level prefix composed with each method mapping; real `public static void main(String[])` declarations; and the narrow TypeScript/TSX client that stitches a frontend call to the route it names, matched on exact verb and normalized path.
A fourth runs the other way - it starts at a durable record the subject both writes and reads through its own SQL, and fans out to the independent derivations that read it, each labelled by a code identifier and the literal SQL predicate its read writes.
The last three are entries nothing in the tree calls - a Spring `@Scheduled` clock, a message subscription (`@EventListener`, `@KafkaListener`, `@JmsListener`, `@RabbitListener`), and a systemd unit whose `ExecStart` launches a subject-owned main; each re-resolves the declaration that establishes the trigger rather than a call site, and a unit that resolves to a subject main is stitched into that main's Flow as a launch arrow rather than drawn as a Flow of its own.
Three more read Python ([#52](https://github.com/KyleNaluan/repo-atlas/issues/52)): FastAPI routes, each path composed with its router prefix; runnable console entries, a `__main__` block or a declared entry point; and a declared LangGraph topology, whose declared nodes and edges are themselves the Flow even though nothing in the tree calls them.
They are registered separately, because "this subject runs no Spring", "this subject ships no runnable main", "this subject's frontend calls nothing it serves", "this subject stores no record it derives from", "this subject runs no batch work", "this subject consumes no messages", "this subject ships no unit files", "this subject runs no FastAPI", "this subject ships no runnable Python entry" and "this subject declares no LangGraph topology" are different findings and one adapter may not answer for another; an adapter whose framework is absent reports `not_applicable` with its reason rather than running empty.
They are pure deterministic functions: no network, no model calls, cheap enough to be cacheable and small enough to be unit-tested against fixtures.

The Flow tracer resolves receivers from declarations - fields, constructor injection, locals, parameters, static type names, and a `var` local's own initialiser - picks overloads by arity and then by argument type, follows subject-owned supertypes, reads each file's imports so a subject type never shadows a library type of the same simple name, and treats a repository read or write, the value an entry returns, and a call that leaves the process as terminals.

A call written through an interface is traced only where the subject's own wiring closes the implementation set: a sole implementation, a `sealed` base, or every implementation carrying a Spring stereotype.
A closed set of several members fans out into one labelled, separately evidenced arrow per member, named by the `supports()` predicate a sealed hierarchy guards it with, by a keyed registry's literal, or by the implementation itself - never by picking the obvious one.
The figure is drawn at component granularity, one box per Spring bean, storage boundary, terminal or held collaborator, with static helpers and value builders folded into the component that uses them.

It stops, by name, wherever the tree stops establishing the next step: an interface whose set nothing closes, a same-arity overload it cannot pick, a receiver it declines to type, a cycle, or a bound reached before a terminal.
Every stop is an `absent` candidate carrying its reason rather than a shorter diagram, because a path that stops when resolution becomes difficult is not a flow.

A probe may not mint `verified` for what its own reading did not establish ([#28](https://github.com/KyleNaluan/repo-atlas/issues/28)).
A candidate reaches `verified` only when the reading *is* the finding - a parse tree, an enumeration of the tree, a captured command's output, or a literal token cited at the line it was read from - or when the gate confirms a claim it stated; everything else ships `attested`, however well grounded.
This is a property of the probe contract: `Probe.reading` defaults to `heuristic`, so a new grep-class probe inherits the conservative answer without opting in, and the clamp only ever moves confidence downwards and never for a candidate that hands the gate a claim to re-resolve.

Probes propose; they never decide. Every candidate goes to the existence gate, which resolves it against the tree at the pinned SHA and can **overturn the record in either direction**:

> A stated decision is not evidence of implementation, and an open ticket is not evidence of absence.

On the reference subject the gate overturns an open ticket for a "second language adapter" whose implementation fully exists at the pinned commit.
A confirmed contradiction becomes a `divergence` edge rather than being dropped - the record and the build disagreeing is the finding, not noise to filter.
A claim nothing in the tree can settle is demoted rather than admitted, because a claim nobody checked must never arrive looking checked.

Links-based Flow candidates take the deliberately stricter path defined for [#35](https://github.com/KyleNaluan/repo-atlas/issues/35): every step and arrow must be evidenced, endpoints and topology must resolve, and every arrow carries one typed candidate-only claim per call site it cites, each of which the gate re-resolves for a direct call, exact Spring route, data access, closed dispatch, HTTP transport, data lineage, a closed negative reachability check, a scheduled trigger, a message-listener subscription, a systemd process launch, or a declared pipeline topology ([#52](https://github.com/KyleNaluan/repo-atlas/issues/52)) - and it refuses the arrow unless its claims cover exactly the lines it cites.
A dispatch claim is re-checked as a *set*: the gate re-enumerates every subject implementation of the declared type from the blob and refuses the arrow if the count has moved, because proving the target still exists says nothing about whether it is still the only thing the call can reach.
One missing, stale, ambiguous, or contradicted arrow quarantines the **complete** Flow as `absent`; it never becomes an attested or partial diagram, and rank excludes it independently of its score or any pin.
Legacy `calls_next` artifacts remain readable through the schema 1.1 renderer bridge, but cannot be admitted as newly verified Flow candidates because they have no link-owned evidence or atomic claims.

## Writing the decision record

A decision record carries the richest input the engine has - the decision, its reasons, and the alternative that lost - and no deterministic probe can read it, because probes are pure functions over the tree and [#5](https://github.com/KyleNaluan/repo-atlas/issues/5) forecloses model-assisted probes.
So `write` is a model stage, and the second place judgement is allowed to enter (per [#2](https://github.com/KyleNaluan/repo-atlas/issues/2)): it reads each record on its own and returns a decision candidate's fields, while the code stamps the citation from the record so the model can never produce one that does not resolve.
Both sources feed it and nothing downstream tells them apart - same prompt asset, same admissibility verdict, same `attested` ceiling, same gate - the one difference being the citation the code stamps: an issue and comment id, or a `{path, line range, sha}` span the audit's L1 and L2 resolve directly against the tree.
Each record is read **alone** - extraction is not comparative, and a writer shown two records at once can borrow a rationale from the wrong one - which is the exact opposite of the scorer's one call for the whole graph.

The writer proposes; it never decides.
It mints a candidate with `attested` confidence and a status of `decided` or `superseded` only, and names where it would expect the decision to live; that candidate goes through the same existence gate, which settles whether the thing was built and fills `implemented_by` with the paths the gate itself located - never anything the model proposed.
An `implementation_claim` must be about the decision's own subject and name something machine-checkable, a path or a compilable pattern, never a prose-matchable word, or the gate demotes it as unresolvable.
A record that settles no decision yields an inadmissible candidate carrying `absent` confidence rather than no candidate at all, so the record can report that a decision-shaped record existed and did not survive - a different statement from a subject with no decision trail.

A subject that records one decision in both places gets one node with two citations, not two nodes.
The merge is keyed on the in-repo record **naming the issue** in its heading or opening line, which is the subject's own identification rather than a similarity judgement about the prose, and it applies only where that issue's resolution comment produced an admissible decision - otherwise the in-repo record stands on its own, which is how a subject that stopped writing resolution comments still gets its decision trail.
A merged record is recorded in `written.json` with the node id it merged into, never dropped.

The same stage writes the two prose passages the artifact opens with: the product sentence and the annotated tree.
Both read the README at the pinned SHA, the source the file listing is taken from, so the summarized bytes and the `{path, sha}` citation they carry agree by construction rather than by a clean checkout holding; a README absent at that SHA cannot support a product sentence, so the writer reports the prose inadmissible rather than guessing from the working tree.

Like the scorer, the model runs locally through an authenticated CLI and its output is committed, so CI assembles from the pinned file and holds no credential.
The prompt is a versioned asset at [`prompts/write-v1.md`](prompts/write-v1.md), changed only by commit, and a pinned output whose prompt has since been reworded, whose version moved, or whose subject SHA differs is refused rather than reused.

## Ranking, and what gets cut

`interview_value` is the only pure-judgement field in the contract, and it is the field that makes the output usable: fourteen packages, twenty endpoints and forty-eight issues all "deserve" a mention, and almost none do.

The rubric is a written, versioned prompt asset at [`rubric/interview-v1.md`](rubric/interview-v1.md).
It changes by commit, never per run.
A project may pin, boost or suppress specific nodes through config - that is data - but it cannot rewrite the rubric, so runs stay reproducible and the override file doubles as the record of where a human disagreed.

Deletion uses two mechanisms, and needs both: a hard value floor, because budgets alone let weak nodes fill an under-subscribed section, and per-section budgets, because a floor alone caps nothing when everything scores mid-range.
The interview profile caps Flow at two after the floor, with one request/response slot and one shared-state/data-lineage slot, so two near-duplicate routes cannot crowd out the complementary story ([#39](https://github.com/KyleNaluan/repo-atlas/issues/39)).
**Every deletion is recorded** with its id, score and reason.
That record is what makes the ruthlessness defensible rather than arbitrary, and the audit checks it, so the renderer cannot quietly resurrect something the rank stage cut.

This is the only stage that deletes. The renderer renders everything it is handed, or it becomes a second authority over what survives.

Scoring is the one place judgement enters the pipeline, and it is a single model call over the whole graph under the rubric - with no tools, so it can order what was established but never add to it.
For a Flow, that evidence-free projection includes its step titles and details, typed and labelled links, inferred archetype and entry kind - and, when that archetype is `unknown`, the named reason it is unclassified rather than a bare label, because a caller-less entry the closed archetype set has no slot for is a different fact from a topology with no entry at all ([#39](https://github.com/KyleNaluan/repo-atlas/issues/39)) - roots, terminals and architectural-boundary count; evidence text remains withheld because evidence is a gate, not a score.
Its output is pinned as a committed fixture, which is how the ranking is checked without a credential: on the reference subject the rubric reproduces the hand-made overview's five deep dives exactly, in the same order and at the same scores.
Refreshing that fixture is an explicit, credentialed command, and a score set whose rubric has since been edited is refused rather than reused.

## The artifact

One HTML file, nine sections, zero external requests: what this is, the interviewer Q&A index, the real shape, one flow end to end, the decision trail, ranked deep dives, honest edges, the record, and a generated source index.
Diagrams are laid out by Graphviz at build time and inlined - the page never computes its own layout at read time.
It is usable at 390 / 768 / 1280 / 1440 with no horizontal page scroll; wide content scrolls in its own frame and the Q&A index stacks to cards on a phone.

Two properties are worth stating because later stages depend on them:

- **Every prose passage is stamped with where it came from.** `prose(text, provenance)` emits a `data-ev` span naming the node and field; the renderer's own sentences carry `data-chrome` and are pinned by a golden inventory. This cannot be reconstructed after the fact, which is why it is built in rather than checked for.
- **No sentence states an audit conclusion except inside the reserved audit slot.** A freshly rendered artifact says the audit has not run, because it has not. The `audit` stage is the only writer of that slot, and the page's hash excluding the slot is what makes its statement checkable.

## The audit

The line that says the content was checked is the artifact's whole differentiator over a summariser, and the audit stage is the only thing that makes it true rather than decorative.
It is twenty checks in four passes: fifteen hard gates, three computed visual warnings, and two advisory model checks.

One rule decides all twenty classifications:

> A check is a hard gate if and only if its failure means the artifact makes a claim that is not true.
> A check is a warning if its failure means the artifact is worse than it should be.

Evidence integrity is truth; layout is quality.
File citations resolve locally with `git cat-file` at the pinned SHA rather than over HTTP, because GitHub returns 200 for a line range past the end of a file - the fragment never reaches the server, so a network walk is structurally blind to the part of a citation that pins the claim.

Pass B loads the artifact in a headless browser with the network disabled, which is what makes "exactly one request" mean anything, and measures layout, clipping and WCAG AA contrast at 390 / 768 / 1280 / 1440 with every collapsible section forced open.
Screenshots are kept as artifacts *of* the audit, never as inputs *to* a check: no model is asked whether the page looks right, because a model asked that says yes and no fixture can prove such a check works.

Pass C resolves every issue and comment citation cache-first: harvest already fetched each body and comment at full fidelity, so the network is reached only for an id the cache does not hold, and a citation to an issue that does not exist - a 404 - is a false claim, while an unreachable GitHub is a precondition the pass could not check rather than a verdict about the artifact.
Pass D is the model, and it can only ever add warnings: it asks whether a node's prose says more than its own evidence establishes (M1) and whether an absence claim's citation actually witnesses the absence (M2).
A model that is unreachable or dies mid-sweep reports as not run, never as a failure, because making the ship decision depend on model availability is the non-reproducibility the audit design rejected; `--no-model` skips the pass outright and its checks report as not run.

The audit asserts its preconditions before any check runs - clone present, HEAD equal to the pinned SHA, worktree clean, and a browser available for pass B - and a missing precondition is its own failure, never a pass and never a silent skip.

No check ships without a mutant fixture proving it fails.

**The audit stamps its own result into a slot it alone may write.**
It hashes the page with that slot blanked, runs its passes, rewrites only the slot, and asserts the hash is unchanged - so the statement's claim that *this page, excluding this box, hashes to X* is one any reader can check by blanking the box and hashing the file.

There are four outcome states, and every one of them names what was **not** checked.
A statement that lists only successes reads as a marketing claim; naming the boundary is what makes the verified part credible.
`passed with warnings` is a real ship state and enumerates every warning in full - a bare count would be unauditable.

**A failed artifact does not ship.**
It goes to `<out>.failed.html`, a name that cannot be mistaken for the deliverable, and the command exits non-zero.
The banner on that copy is a second line of defence, not the mechanism: a banner is the first thing lost when a reader screenshots a section or shares the file.
`--allow-failed` emits it anyway for local development; CI never sets it.

## The contract

`atlas.json` is the stable output contract, not the HTML.
The rendered page is one view of it, which is what keeps a downstream consumer (an interview-prep tool) a separate project rather than a fork of this one.

- **Six node types**: Decision, Mechanism, Boundary, Edge, Fact, Flow. Every node carries `id`, `title`, `evidence[]`, `confidence`, `interview_value`.
- **Three confidence levels**, and the gate is hard: `verified` (a file at the SHA, or command output), `attested` (a primary issue/comment record, or a text reading that stands behind a finding without establishing it), `absent` (cut outright - hedged prose is worse than absence). The level says what was established, never which parsing technique established it ([#28](https://github.com/KyleNaluan/repo-atlas/issues/28)).
- **`rejected[]` uses explicit-absence semantics**: a Decision carries either a populated `rejected[]` or `rejected_absent_from_record`. "Decided without recording an alternative" and "no decision record at all" are different states and stay different.
- **Semver, additive-only within a major**; consumers pin the major, and a document from a future major is refused rather than best-effort read.

Schema 1.1 adds edge-level Flow links ([#37](https://github.com/KyleNaluan/repo-atlas/issues/37)).
Each `FlowLink` owns its endpoints, typed relation, optional label/kind, and evidence, so a fan-out can preserve a distinct meaning and citation for every arrow.
The renderer prefers `links` while continuing to accept the legacy `FlowStep.calls_next` and `edge_label` fields for 1.x inputs.
Audit E2 checks links-based Flow topology and substantive step/link evidence, M1 weighs the boxes, details, and arrow labels rather than only the caption, and G3 confirms each rendered Flow carries its `atlas.json` value attribution and that any cut-to-budget flows are disclosed against the deletion record.

The published JSON Schema lives at [`schema/atlas.schema.json`](schema/atlas.schema.json) and is **generated** from [`src/schema/types.ts`](src/schema/types.ts) by `npm run schema:gen`.
CI runs `npm run schema:check`, so the types and the contract cannot drift.

Validation fails closed. A document that does not validate is never rendered, never partially rendered, and never repaired.

## Dependencies

The tool is distributed for `npx`, so the footprint is a design constraint rather than an afterthought.

| Package | Why | Where |
|---|---|---|
| `ajv` | validates `atlas.json` against the generated schema | contract |
| `@anthropic-ai/claude-agent-sdk` | the tool-free model calls, reached through one call site: reading decisions, scoring `interview_value`, the audit's judge | write, score, audit |
| `puppeteer-core` | drives an already-installed browser for the audit's pass B | audit |
| `web-tree-sitter` | structural parsing for the probes that need a parse tree, and for the Flow symbol index | probes |
| `@hpcc-js/wasm-graphviz` | diagram layout as WebAssembly - no native binary, no system package | render |
| `shiki` | build-time syntax highlighting, emitted as static HTML | render |

Graphviz-as-WASM is deliberate: a native `graphviz` package breaks `npx repo-atlas` on a clean machine, and a client-side layout library would make the artifact compute its own layout at read time, which a static artifact must not do.

## Development

```
npm ci
npm run typecheck
npm test
npm run schema:gen     # after any change to src/schema/types.ts
npm run build
```

## Why the tracker matters here

repo-atlas is planned and built under the same decision-record discipline it mines: every architecture and scope question is a ticket, closed with a resolution comment recording the decision, the why, and the rejected alternatives.
Running the tool on its own repository is the eventual self-demonstrating demo, so commits and pull requests here cite the ticket they implement.
