# repo-atlas

Evidence-linked, self-contained static overviews of a repository.

repo-atlas is an **evidence-linker with a strong opinion about what to leave out**, not a summariser.
It reads a repository and its issue tracker at a pinned commit, extracts decisions with their rejected alternatives, the mechanisms that enforce them, the boundaries that carry weight and the edges that are honestly unfinished, ranks them by what is worth saying out loud, deletes the rest, and emits one HTML file that makes zero network requests.

Every claim in that file traces to a file at the pinned SHA, a linked issue or comment, or captured command output.
Anything that could not be traced is cut, not hedged.
On a repository with no decision record, the artifact says so - it never reconstructs a decision trail from commit archaeology.

**Status: under construction.** The complete v1 design is closed on this tracker: issues [#1](https://github.com/KyleNaluan/repo-atlas/issues/1)-[#10](https://github.com/KyleNaluan/repo-atlas/issues/10), each with a binding `## Resolution:` comment recording the decision, the why, and the rejected alternatives.
This build ships the `atlas.json` contract, the render stage, and the audit's deterministic passes with its stamp; the extraction stages and the model pass land stage by stage.

```
npx repo-atlas render atlas.json -o overview.html
npx repo-atlas audit overview.html --atlas atlas.json --clone ../subject
```

## The pipeline

Each stage is a subcommand (per [#2](https://github.com/KyleNaluan/repo-atlas/issues/2)), reading and writing a content-addressed cache keyed on the pinned SHA, with a top-level `run` orchestrator.
The mechanical stages are plain deterministic code; only `rank` and `audit` call a model, and the model controls no flow.

| Stage | What it does | Ticket |
|---|---|---|
| `harvest` | fetch the subject at a pinned SHA through raw API paths, count-verified | [#4](https://github.com/KyleNaluan/repo-atlas/issues/4) |
| `probe` | run the mechanical probe library, emitting candidate nodes | [#5](https://github.com/KyleNaluan/repo-atlas/issues/5) |
| `gate` | confirm each candidate against the tree, in both directions | [#5](https://github.com/KyleNaluan/repo-atlas/issues/5), [#7](https://github.com/KyleNaluan/repo-atlas/issues/7) |
| `rank` | score `interview_value` under a versioned rubric; delete by floor and budget | [#9](https://github.com/KyleNaluan/repo-atlas/issues/9) |
| `render` | `atlas.json` -> one self-contained HTML artifact | [#7](https://github.com/KyleNaluan/repo-atlas/issues/7) |
| `audit` | twenty checks, fifteen hard gates; stamps its own result into the artifact | [#8](https://github.com/KyleNaluan/repo-atlas/issues/8) |
| `validate` | check an `atlas.json` against the generated JSON Schema, fail closed | [#3](https://github.com/KyleNaluan/repo-atlas/issues/3) |

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
- **Three confidence levels**, and the gate is hard: `verified` (a file at the SHA, or command output), `attested` (a primary issue/comment record), `absent` (cut outright - hedged prose is worse than absence).
- **`rejected[]` uses explicit-absence semantics**: a Decision carries either a populated `rejected[]` or `rejected_absent_from_record`. "Decided without recording an alternative" and "no decision record at all" are different states and stay different.
- **Semver, additive-only within a major**; consumers pin the major, and a document from a future major is refused rather than best-effort read.

The published JSON Schema lives at [`schema/atlas.schema.json`](schema/atlas.schema.json) and is **generated** from [`src/schema/types.ts`](src/schema/types.ts) by `npm run schema:gen`.
CI runs `npm run schema:check`, so the types and the contract cannot drift.

Validation fails closed. A document that does not validate is never rendered, never partially rendered, and never repaired.

## Dependencies

The tool is distributed for `npx`, so the footprint is a design constraint rather than an afterthought.

| Package | Why | Where |
|---|---|---|
| `ajv` | validates `atlas.json` against the generated schema | contract |
| `puppeteer-core` | drives an already-installed browser for the audit's pass B | audit |
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
