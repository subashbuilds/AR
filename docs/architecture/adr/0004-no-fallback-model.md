# 0004 · No fallback model, ever

Status: **accepted**

## Context

Every pressure on a reconstruction pipeline points the same way: produce
*something* when it fails. A blank screen is bad; a plausible-looking wrong
model is worse — it is a lie that a user cannot detect, and it is
particularly poisonous here, because the product's promise is
**true physical scale in AR**: a wrong model placed on a real table is a
measured untruth.

## Decision

There is no path from a failed stage to a published model.

- The pipeline returns a **named failure stage** and writes no GLB when a
  stage fails; random noise without multi-view consistency is *required* to
  fail explicitly rather than emit a model (gated by
  `test_pipeline_returns_failure_not_exception`).
- The API reports the **worker's own error message** and marks the capture
  `failed`; it never retries a failed capture into success, and the UI shows
  the failure with its stage and the worker's text.
- The GLB endpoint refuses anything but status `completed` with the file
  present (`409`), and the independent validator re-parses the written GLB
  (container, accessors, index ranges, finiteness, plausible metres, texture
  decode) before anything calls it done — the writer is not trusted.
- Numbers that cannot be known are labelled, not guessed: `units:
  "uncalibrated"` without a user measurement, coverage "unmeasured" without
  compass headings, percentages marked estimated when they come from static
  stage weights.

## Consequences

- A user with a bad capture gets an honest failure and a "try another
  capture" affordance (or `cancelled` if they stop it themselves) — never a
  model they would then measure or share.
- New features inherit the rule: any fallback that *produces output* where
  the pipeline previously failed is a regression by definition, and gates
  like `test_pipeline_returns_failure_not_exception` are what keep it that
  way.
