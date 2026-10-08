// Unit tests for the on-device coverage ring.
//
//   node --test apps/web/test/orbit.test.ts
//
// These are pure Node tests: no browser, no build step. They run directly off
// the TypeScript source thanks to Node's type stripping.
//
// The last group is the important one. `lib/orbit.ts` claims to be a twin of
// `services/reconstruction-worker/pipeline/coverage.py`, and a claim like that
// is worth nothing unless something checks it, so `test_gap_matches_the_python_estimator`
// runs the real Python estimator in a subprocess on the same camera geometry
// and compares the two numbers. If the threshold, the wrap-around handling or
// the azimuth convention ever diverge, this fails.

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FULL_ORBIT_GAP_DEG,
  SECTOR_COUNT,
  createHeadingTracker,
  gapOf,
  headingFrom,
  normaliseDeg,
  sectorsOf,
  summarise,
} from '../src/lib/orbit.ts'
import type { Heading } from '../src/lib/orbit.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const workerRoot = path.resolve(here, '..', '..', '..', 'services', 'reconstruction-worker')

/** The fixture's own 24 camera azimuths: exact 15-degree steps around a ring. */
const FIXTURE_AZIMUTHS = Array.from({ length: 24 }, (_, i) => i * 15)

const heading = (azimuthDeg: number): Heading => ({
  azimuthDeg: normaliseDeg(azimuthDeg),
  elevationDeg: 0,
  source: 'compass',
})

// ----------------------------------------------------------------- angles

test('normaliseDeg folds any angle into [0, 360)', () => {
  assert.equal(normaliseDeg(0), 0)
  assert.equal(normaliseDeg(360), 0)
  assert.equal(normaliseDeg(-90), 270)
  assert.equal(normaliseDeg(725), 5)
  assert.ok(Number.isNaN(normaliseDeg(NaN)))
  assert.ok(Number.isNaN(normaliseDeg(Infinity)))
})

test('gapOf measures the largest empty arc', () => {
  // Evenly spaced ring: every gap is one step.
  assert.equal(gapOf(FIXTURE_AZIMUTHS), 15)
  // Four quadrants leave 90-degree arcs.
  assert.equal(gapOf([0, 90, 180, 270]), 90)
})

test('gapOf counts the wrap-around arc', () => {
  // A ring sampled every 10 degrees from 10 to 350. Every interior gap is 10
  // degrees; the only larger arc is the one crossing north, from 350 back to
  // 10, which measures 20. Ignoring the wrap-around arc and reporting
  // last-minus-first would call this 340 degrees and invert the verdict on the
  // whole capture.
  const ring = Array.from({ length: 35 }, (_, i) => 10 + i * 10)
  assert.equal(gapOf(ring), 20)
  const naive = ring[ring.length - 1] - ring[0]
  assert.equal(naive, 340)

  // Two points alone are NOT a near-full orbit: they define two arcs, and the
  // 340-degree one is the honest answer. This assertion guards the previous
  // version of this test, which wrongly expected 20 here.
  assert.equal(gapOf([350, 10]), 340)

  // All the sweep in one place: the arc from 30 back round to 10 is 340
  // degrees unswept, and that is the largest gap by far.
  assert.equal(gapOf([10, 20, 30]), 340)
})

test('gapOf needs two angles and ignores junk', () => {
  assert.equal(gapOf([]), null)
  assert.equal(gapOf([42]), null)
  assert.equal(gapOf([NaN, Infinity]), null)
  assert.equal(gapOf([0, NaN, 180]), 180)
})

// ---------------------------------------------------------------- sectors

test('sectorsOf marks the wedges that contain a photo', () => {
  const sectors = sectorsOf([0, 15, 45, 359])
  assert.equal(sectors.length, SECTOR_COUNT)
  assert.equal(sectors[0], true) // 0 and 15 share the first wedge
  assert.equal(sectors[1], true) // 45
  assert.equal(sectors[11], true) // 359 is in the last wedge, next to the seam
  assert.equal(sectors[2], false)
  assert.equal(sectors.filter(Boolean).length, 3)
})

test('an empty sector list is empty, not "everything covered"', () => {
  assert.deepEqual(sectorsOf([]), new Array(SECTOR_COUNT).fill(false))
})

// ----------------------------------------------------------------- report

test('a full orbit is recognised', () => {
  const report = summarise(FIXTURE_AZIMUTHS.map(heading))
  assert.ok(report)
  assert.equal(report.maxGapDeg, 15)
  assert.equal(report.fullOrbit, true)
  assert.equal(report.spreadTurns, 1 - 15 / 360)
  assert.equal(report.measured, 24)
  assert.doesNotMatch(report.note, /not photographed/)
})

test('a half orbit is flagged, and says which way to move', () => {
  // Twelve consecutive shots: a 195-degree hole.
  const report = summarise(FIXTURE_AZIMUTHS.slice(0, 12).map(heading))
  assert.ok(report)
  assert.equal(report.maxGapDeg, 195)
  assert.equal(report.fullOrbit, false)
  assert.match(report.note, /195/)
  assert.match(report.note, /keep circling/i)
})

test('the completeness threshold is the documented 60 degrees', () => {
  // Exactly at the threshold counts as complete; a hair more does not.
  // 0, 60, 120, 180, 240, 300 leaves gaps of 60.
  const atThreshold = [0, 60, 120, 180, 240, 300]
  assert.equal(gapOf(atThreshold), 60)
  assert.ok(summarise(atThreshold.map(heading))?.fullOrbit === true)

  const justOver = [0, 60.5, 120, 180, 240, 300]
  const overGap = gapOf(justOver)
  assert.ok(overGap !== null && overGap > FULL_ORBIT_GAP_DEG)
  assert.ok(summarise(justOver.map(heading))?.fullOrbit === false)
})

test('photos without a heading are counted but never invented', () => {
  const report = summarise([heading(0), null, heading(90), undefined, heading(180)], 2)
  assert.ok(report)
  assert.equal(report.measured, 3)
  assert.equal(report.unknown, 2)
  // Only the three real headings shaped the gap. `assert.ok` is used rather
  // than `assert.equal` because the latter is an assertion signature in
  // @types/node and would narrow the operands out of the comparison.
  assert.ok(report.maxGapDeg === gapOf([0, 90, 180]))
})

test('too few headings yields no report, so the UI can say "unknown"', () => {
  assert.equal(summarise([]), null)
  assert.equal(summarise([null, undefined]), null)
  assert.equal(summarise([heading(10)]), null)
})

// ---------------------------------------------------------------- tracker

test('a real compass bearing is preferred and trusted', () => {
  const h = headingFrom({ alpha: 120, beta: 30, gamma: 0, webkitCompassHeading: 42 })
  assert.deepEqual(h, { azimuthDeg: 42, elevationDeg: 30, source: 'compass' })
})

test('an absolute alpha is a compass bearing, mirrored', () => {
  const h = headingFrom({ alpha: 90, beta: 0, gamma: 0, absolute: true })
  assert.deepEqual(h, { azimuthDeg: 270, elevationDeg: 0, source: 'compass' })
})

test('a relative alpha yields a turn angle, and needs a reference first', () => {
  assert.ok(headingFrom({ alpha: 30, beta: 0, gamma: 0 }) === null)
  const h = headingFrom({ alpha: 30, beta: 0, gamma: 0 }, 10)
  assert.deepEqual(h, { azimuthDeg: 20, elevationDeg: 0, source: 'relative' })
})

test('elevation is clamped to the physically possible range', () => {
  assert.equal(headingFrom({ alpha: 0, beta: 140, gamma: 0, webkitCompassHeading: 0 })?.elevationDeg, 90)
  assert.equal(headingFrom({ alpha: 0, beta: -140, gamma: 0, webkitCompassHeading: 0 })?.elevationDeg, -90)
  assert.equal(headingFrom({ alpha: 0, beta: null, gamma: null, webkitCompassHeading: 0 })?.elevationDeg, 0)
})

test('an event with no direction at all yields null, not a fake zero', () => {
  assert.equal(headingFrom({ alpha: null, beta: null, gamma: null }), null)
  assert.equal(headingFrom({ alpha: NaN, beta: 0, gamma: 0 }), null)
})

test('the tracker latches its reference once and never re-anchors', () => {
  const tracker = createHeadingTracker()
  // Read into locals first: `assert.ok` and `assert.equal` are assertion
  // signatures in @types/node, so asserting on `tracker.live` directly would
  // narrow that property to `null` for the rest of the block.
  const startLive = tracker.live
  const startSource = tracker.source
  assert.ok(startLive === null)
  assert.ok(startSource === null)

  tracker.push({ alpha: 10, beta: 0, gamma: 0 })
  assert.equal(tracker.live?.azimuthDeg, 0)
  assert.equal(tracker.source, 'relative')

  tracker.push({ alpha: 100, beta: 0, gamma: 0 })
  assert.equal(tracker.live?.azimuthDeg, 90)

  // A later jump in the reference must not retroactively rotate earlier shots.
  tracker.push({ alpha: 350, beta: 0, gamma: 0 })
  assert.equal(tracker.live?.azimuthDeg, 340)
})

test('a later compass reading upgrades the source without losing the reference', () => {
  const tracker = createHeadingTracker()
  tracker.push({ alpha: 10, beta: 0, gamma: 0 })
  assert.equal(tracker.source, 'relative')
  tracker.push({ alpha: 10, beta: 0, gamma: 0, webkitCompassHeading: 200 })
  assert.equal(tracker.source, 'compass')
  assert.equal(tracker.live?.azimuthDeg, 200)
})

test('a tracker that never receives a usable event reports nothing', () => {
  const tracker = createHeadingTracker()
  assert.equal(tracker.push({ alpha: null, beta: null, gamma: null }), null)
  const live = tracker.live
  const source = tracker.source
  assert.ok(live === null)
  assert.ok(source === null)
})

// ------------------------------------------------- cross-language contract

/**
 * The strongest test in this file: run the REAL Python estimator over the same
 * camera centres and require the browser-side number to match it.
 *
 * The geometry is a tilted orbit rather than a flat ring, because a flat ring
 * cannot tell a correct azimuth convention from a rotated one -- the estimated
 * centre is the ring's centre either way. `coverage.py` derives azimuth with
 * `atan2(z, x)`; this test requires the TypeScript to agree on which axis is
 * which, on how elevation is handled, and on the 60-degree threshold.
 */
test('gapOf matches the Python estimator on a tilted orbit', () => {
  const centres: number[][] = []
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * 2 * Math.PI
    centres.push([7 * Math.cos(a), 2.4 * Math.sin(2 * a), 7 * Math.sin(a)])
  }
  // Twelve consecutive frames of that orbit: the half-circle with a hole.
  const half = centres.slice(0, 12)

  const run = (points: number[][]): number => {
    const script = [
      'import json, sys',
      'import numpy as np',
      'from pipeline import coverage',
      'pts = json.load(sys.stdin)',
      'rep = coverage.estimate(np.array(pts, float), point_count=0)',
      'print(rep.max_gap_deg)',
    ].join('\n')
    const out = execFileSync('python3', ['-c', script], {
      input: JSON.stringify(points),
      cwd: workerRoot,
      encoding: 'utf8',
    })
    return Number(out.trim())
  }

  // The Python side is the reference, so a failure here means the browser-side
  // estimate drifted, not that the engine is wrong. The tolerance is 1e-9
  // degrees: the two languages do not sum their trigonometry in the same
  // order, so bit-identical results are not available, but agreement to a
  // billionth of a degree is far tighter than anything physical.
  const TOL = 1e-9
  const close = (a: number | null, b: number, what: string) => {
    assert.ok(a !== null, `${what}: gapOf returned no gap for this geometry`)
    assert.ok(Math.abs((a as number) - b) < TOL, `${what}: TypeScript ${a} vs Python ${b}`)
  }
  close(gapOf(azimuthsOf(centres)), run(centres), 'full orbit gap')
  close(gapOf(azimuthsOf(half)), run(half), 'half orbit gap')

  // And the verdict, not just the number, has to match.
  const pythonVerdict = (points: number[][]): boolean => {
    const script = [
      'import json, sys',
      'import numpy as np',
      'from pipeline import coverage',
      'rep = coverage.estimate(np.array(json.load(sys.stdin), float), point_count=0)',
      'print(rep.full_orbit)',
    ].join('\n')
    const out = execFileSync('python3', ['-c', script], {
      input: JSON.stringify(points),
      cwd: workerRoot,
      encoding: 'utf8',
    })
    return out.trim() === 'True'
  }
  assert.equal(summarise(azimuthsOf(centres).map(heading))?.fullOrbit, pythonVerdict(centres))
  assert.equal(summarise(azimuthsOf(half).map(heading))?.fullOrbit, pythonVerdict(half))
})

/** Azimuth exactly as coverage.py computes it, from raw camera centres. */
function azimuthsOf(centres: number[][]): number[] {
  const n = centres.length
  const mean = [0, 1, 2].map((axis) => centres.reduce((s, p) => s + p[axis], 0) / n)
  return centres.map((p) => {
    const x = p[0] - mean[0]
    const z = p[2] - mean[2]
    return normaliseDeg((Math.atan2(z, x) * 180) / Math.PI)
  })
}
