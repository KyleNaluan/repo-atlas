# repo-atlas

Evidence-linked, self-contained static overviews of a repository.

repo-atlas is an **evidence-linker with a strong opinion about what to leave out**, not a summariser.
It reads a repository and its issue tracker at a pinned commit, extracts decisions with their rejected alternatives, the mechanisms that enforce them, the boundaries that carry weight and the edges that are honestly unfinished, ranks them by what is worth saying out loud, deletes the rest, and emits one HTML file that makes zero network requests.

Every claim in that file traces to a file at the pinned SHA, a linked issue or comment, or captured command output.
Anything that could not be traced is cut, not hedged.
On a repository with no decision record, the artifact says so - it never reconstructs a decision trail from commit archaeology.

**Status: under construction.** The complete v1 design is closed on this tracker: issues [#1](https://github.com/KyleNaluan/repo-atlas/issues/1)-[#10](https://github.com/KyleNaluan/repo-atlas/issues/10), each with a binding `## Resolution:` comment recording the decision, the why, and the rejected alternatives.
This build ships the scaffold and the `atlas.json` contract; the pipeline stages land stage by stage.

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

```
npx repo-atlas validate atlas.json
```

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
