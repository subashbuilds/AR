# Capturing an object the solver can place

The app is `apps/web/src/pages/Capture.tsx`; the worker's verdicts are in
`docs/status.md` §3. This guide is what the product *asks the user to do*
and what it honestly reports when they do it.

## The recipe

- **12–24 photographs**, walking a full circle around the object, camera
  level, **15–30° apart**, with plenty of overlap between neighbours.
- Fill the frame: SIFT features need texture, and the wireframe box on the
  capture screen is a *guide* for framing — there is no on-device object
  detector, and the box says nothing about the object's real shape.
- Even lighting; avoid motion blur. The per-photo review will later name any
  photo the solver could not use and *why* (blurred/weak vs could-not-place
  are told apart — §3e).
- **One real measurement** of any dimension (height/width/depth) fixes the
  model's absolute scale. Skip it and the model is published as
  `uncalibrated`, in units that are not metres.

## What the capture screen measures — and what it does not

| Element | What it is |
|---|---|
| Shot counter / thumbnails | exactly what it says |
| **Orbit ring** | compass headings only: which *directions the camera pointed*, never the object's shape. Labelled with the widest arc still unswept; with no compass it reports coverage as **unmeasured** instead of drawing an empty ring that reads 0% (§2, "Capture ring") |
| Wireframe box | framing guide, no detector behind it |
| Progress bar during reconstruction | worker stage progress; percentages from static stage weights are labelled *estimated*, and once a job has completed its measured stage times refine later ETAs |

## After upload

- The worker re-measures the orbit **from the reconstructed camera centres**
  — a stronger version of the ring's compass preview. A partial sweep is
  reported on the model page with the largest gap in degrees, and the width/
  depth warning says those axes can read too small because the unphotographed
  side does not exist in the model (§3).
- Photos the model did not use are listed by name with a reason; the review
  distinguishes *weak* from *unusable* and never claims one photo is better
  than measured (§3e).
- Reconstruction progress, stage names and failures are the worker's own.
  **Cancel** is available the whole time a capture is queued or running; it
  lands in the named `cancelled` state with no model published — never
  `failed`.

## Known limits of a capture (measured, not vibes)

- On the ground-truth fixture, **8/12** views register (10/24 at full orbit);
  the registration limit is not a threshold — five levers were measured
  against ground truth and none wins (§3f, ADR 0003).
- Surface coverage of the sparse cloud is ~78.6% of its own points on the
  true surface at 12 views; dense MVS stays closed because it invents
  geometry in directions the capture never saw (§3c, ADR 0001).
- The texture atlas colours only the surface the cloud actually covers, and
  bakes the resolution of the photos it was given (§3d).

## If the reconstruction fails

Named stage, worker's own message, no model. The usual causes, in order:
too few photos (<12), too little overlap (step too far around the circle),
one side never photographed, motion blur or a reflective surface starving
the matcher. See `docs/troubleshooting/README.md`.
