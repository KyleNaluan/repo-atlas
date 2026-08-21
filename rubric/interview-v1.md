# Interview ranking rubric, v1

This file is the rubric. It is a **prompt asset**, versioned in the repository and
changed only by commit - never per run (#9). A run may pin, boost or suppress
specific nodes through per-project config, but it may not rewrite what follows.

The rubric is derived from the ranking rationale of the hand-made overview this
engine exists to reproduce, and its ordering is the ground truth that
`rubric_version` refers to.

## What you are scoring

Each node gets an `interview_value` from 0 to 5: **how much this is worth saying
out loud, unprompted, in a technical interview about this codebase.**

You are not scoring importance to the system. A database connection pool may be
load-bearing and still be worth 1, because saying it out loud tells an
interviewer nothing they could not assume.

## Top marks (4-5)

- **A decision with a recorded rejected alternative, on a seam that matters.**
  The rejected alternative is the payload. "We chose X" is a fact; "we chose X
  over Y because Z" is a decision, and it is the thing a summariser destroys.
- **An enforcement mechanism an interviewer will probe.** A rule held in place by
  the type system, a query, or a test is more interesting than the same rule held
  in place by discipline - because the mechanism is what survives the author
  leaving.
- **An honest edge you would rather go first on.** A known risk, a divergence
  between the record and the build, a deliberate tradeoff. Going first on these
  is strictly better than being caught by them, and volunteering one is the
  single strongest signal available.
- **A complete Flow that crosses architectural boundaries and exposes a seam.**
  A request/response narrative earns top marks when its verified landmarks show
  more than a controller wrapper: dispatch, transaction, data, process, return,
  or side-effect boundaries should reveal how the result is actually produced.
  A shared-state/data-lineage narrative earns the same marks when one durable
  state drives independently meaningful derivations with distinct predicates or
  algorithms. Prefer these two complementary stories over several routes through
  the same layers.

## Middle (2-3)

- A decision with no recorded alternative: real, but weaker - the record says what
  was chosen and not what lost.
- A mechanism that is genuinely interesting but enforced only by convention.
- A boundary that matters but that a reader would infer from the tree anyway.

## Orientation figures are not inventory

A measured figure that tells a reader what size and age of thing they are looking
at - how much production source, how long it took, how much of it is tested - is
ORIENTATION, and it is read before anything else rather than said out loud. Score
it in the middle: it earns its place by being measured and load-bearing for
everything after it, not by being interesting on its own.

The distinction from inventory is what the figure does for the reader. "47
commits over 7 calendar days" changes how every other finding is read. "18
packages" is a listing wearing a number. If removing the figure would not change
how a reader interprets the rest, it is inventory.

## Bottom marks (0-1)

- **Inventory.** Endpoint listings, package tours, dependency counts. These are
  the identified filler: they read as thorough and say nothing, and they are the
  first thing to cut. A figure that only counts things is inventory however it is
  displayed; see above for the orientation figures that are not.
- Anything a reader would assume from the stack. That the web layer has
  controllers is not a finding.
- Anything whose interest is in the domain rather than in the engineering.
- A Flow that is only a controller-to-service wrapper, endpoint listing, package
  tour, or raw call graph saying "web code calls service code". These are route
  inventory, not an end-to-end narrative, and score 0-1 even when every arrow is
  verified.

## Scoring against what the subject actually offers

Value is comparative, and the comparison is against THIS subject's record - not
against an imagined well-documented one. A repository whose tracker settles
nothing still has something true to say about itself, and on such a subject the
findings below carry the weight that decisions carry elsewhere. Score them there.

- **An unresolved reference, where the record resolves nothing.** Source citing
  an issue number that the record never explains is a coverage gap, and on a
  subject with no decision trail it is the most informative thing available: it
  locates precisely where the reasoning went, and says out loud that it is not in
  the repository. Score it as you would a decision on a subject that had one.
  Where the record IS rich, the same finding is a footnote beside the decisions
  it sits among, and scores like one.
- The general rule: a finding's value depends on what else the reader has. The
  same node is worth more in a thin record than in a dense one, and scoring every
  subject against a mental picture of a well-documented codebase leaves the thin
  ones with nothing rendered at all - which is the one outcome that would make
  the artifact silent about a subject rather than honest about it.

## How to weigh evidence

- A node is not more interesting because it has more citations. Evidence is a
  gate, not a score.
- A node whose confidence is `attested` rather than `verified` is not thereby
  less interesting: a decision record is the richest source in the corpus. Score
  the content, not the provenance.

## What you must not do

- Do not invent a rejected alternative for a decision that records none. The
  explicit-absence flag exists for exactly that case, and ranking simply favours
  decisions that have one.
- Do not score for coverage. There is no requirement that every section be full,
  and the budgets below exist precisely because completeness pressure is the
  biggest quality risk this engine has.
