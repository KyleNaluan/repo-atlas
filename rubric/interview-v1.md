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

## Middle (2-3)

- A decision with no recorded alternative: real, but weaker - the record says what
  was chosen and not what lost.
- A mechanism that is genuinely interesting but enforced only by convention.
- A boundary that matters but that a reader would infer from the tree anyway.

## Bottom marks (0-1)

- **Inventory.** Endpoint listings, package tours, dependency counts. These are
  the identified filler: they read as thorough and say nothing, and they are the
  first thing to cut.
- Anything a reader would assume from the stack. That the web layer has
  controllers is not a finding.
- Anything whose interest is in the domain rather than in the engineering.

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
