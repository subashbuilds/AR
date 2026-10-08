// Which way was the camera pointing when each photo was taken?
//
// This is the on-device half of the coverage story. The worker measures the
// real orbit AFTER reconstruction, from the camera centres it solved
// (`services/reconstruction-worker/pipeline/coverage.py`). This module lets
// the capture screen tell the user the same thing BEFORE they spend the upload,
// so a half-finished sweep is caught while it is still cheap to fix.
//
// Deliberate limits, because honesty matters more than a green ring:
//
//   * This is a compass reading, not a reconstruction. It knows which way the
//     phone pointed; it does not know where the object is. The ring therefore
//     reports *directions swept*, never "this side of the object is done".
//   * It needs no object detector, and it cannot be as good as the worker's
//     number. When the device reports no orientation at all, the caller must
//     show the ring as unmeasured rather than draw an empty one and let the
//     user read it as "0% covered".
//   * `gapOf()` and `summarise()` are deliberate line-by-line twins of the
//     Python `estimate()` in coverage.py, including its 60-degree threshold and
//     its wrap-around gap. `apps/web/test/orbit.test.ts` asserts the two agree
//     on the ground-truth fixture's own camera angles, so this file cannot
//     quietly drift away from the engine it is meant to preview.
//
// Coverage never needs true north. It only needs to know how far the user has
// rotated around the object, so a relative heading (turn angle since the first
// shot) is as good as a compass bearing -- and it works on devices that expose
// no magnetometer. The tracker prefers a real compass when one is offered and
// says which it used, because the two are not equally trustworthy.

// 30-degree wedges. Twelve of them makes each wedge three average shots apart
// on a 24-photo orbit, which is the smallest number a person can read at a
// glance on a phone.
export const SECTOR_COUNT = 12

// The largest empty arc that still counts as a complete sweep. This MUST stay
// equal to `_FULL_ORBIT_GAP_DEG` in coverage.py; the cross-language test
// asserts the two agree.
export const FULL_ORBIT_GAP_DEG = 60

/** Reduce any angle to [0, 360). */
export function normaliseDeg(deg: number): number {
  if (!Number.isFinite(deg)) return NaN
  const wrapped = deg % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

export type HeadingSource = 'compass' | 'relative'

export interface Heading {
  /** Bearing of the camera's view direction, in [0, 360). */
  azimuthDeg: number
  /** Tilt above the horizon, in degrees, clamped to [-90, 90]. */
  elevationDeg: number
  source: HeadingSource
}

/** The subset of a DeviceOrientationEvent this module reads. */
export interface OrientationSample {
  alpha: number | null
  beta: number | null
  gamma: number | null
  /** True when the platform reports alpha against magnetic north. */
  absolute?: boolean
  /** iOS Safari's own solved compass bearing, already in degrees from north. */
  webkitCompassHeading?: number | null
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Convert one orientation event into a heading, or null when the event carries
 * no usable direction.
 *
 * Preference order, and the reason for it:
 *   1. `webkitCompassHeading` -- iOS has already done the hard rotation maths,
 *      so trusting it beats re-deriving it here.
 *   2. `alpha` with `absolute: true` -- Android's magnetic-north reference.
 *      Alpha counts anticlockwise, a bearing counts clockwise, hence 360 - a.
 *   3. `alpha` alone -- a RELATIVE heading. Magnitude and ordering are all the
 *      gap calculation uses, so a phone with no magnetometer still produces a
 *      correct orbit report; it just cannot be tied to a compass direction.
 */
export function headingFrom(sample: OrientationSample, referenceAlpha?: number | null): Heading | null {
  const elevationDeg = finite(sample.beta) ? Math.max(-90, Math.min(90, sample.beta)) : 0

  if (finite(sample.webkitCompassHeading)) {
    return {
      azimuthDeg: normaliseDeg(sample.webkitCompassHeading as number),
      elevationDeg,
      source: 'compass',
    }
  }
  if (!finite(sample.alpha)) return null
  const alpha = sample.alpha as number
  if (sample.absolute === true) {
    return { azimuthDeg: normaliseDeg(360 - alpha), elevationDeg, source: 'compass' }
  }
  if (finite(referenceAlpha ?? null)) {
    return {
      azimuthDeg: normaliseDeg(alpha - (referenceAlpha as number)),
      elevationDeg,
      source: 'relative',
    }
  }
  // No reference yet, so there is no turn angle to report. Returning a zero
  // heading here would inject a fabricated "facing north" into the orbit and
  // could create a gap that does not exist. `createHeadingTracker` latches the
  // reference from the first sample, so this only affects direct callers.
  return null
}

export interface HeadingTracker {
  /** Fold in an orientation event. Returns null when it carries no direction. */
  push: (sample: OrientationSample) => Heading | null
  /** The most recent usable heading, or null before the first one arrives. */
  readonly live: Heading | null
  /** Which kind of heading is being produced, or null if nothing usable yet. */
  readonly source: HeadingSource | null
}

/**
 * Stateful wrapper over `headingFrom` that remembers the reference alpha for
 * relative mode. Device sensors fire many times a second; the capture screen
 * only reads `live` at the moment the shutter fires.
 */
export function createHeadingTracker(): HeadingTracker {
  let referenceAlpha: number | null = null
  let live: Heading | null = null
  let source: HeadingSource | null = null

  return {
    push(sample: OrientationSample): Heading | null {
      // Latch the reference once, and never re-latch it: re-anchoring to a
      // later sample would silently rotate every earlier photo.
      if (referenceAlpha === null && finite(sample.alpha) && sample.absolute !== true) {
        referenceAlpha = sample.alpha
      }
      const heading = headingFrom(sample, referenceAlpha)
      if (!heading) return null
      live = heading
      source = heading.source
      return heading
    },
    get live() {
      return live
    },
    get source() {
      return source
    },
  }
}

export interface OrbitReport {
  /** One flag per 30-degree wedge: true when a photo was taken in it. */
  sectors: boolean[]
  /** Largest empty arc between consecutive photos, wrap-around included. */
  maxGapDeg: number
  /** Angular range swept, in turns; 1.0 is a full 360 degrees. */
  spreadTurns: number
  /** True when no viewing direction was left unswept. */
  fullOrbit: boolean
  /** How many photos contributed a heading. */
  measured: number
  /** How many photos have no heading and were ignored. */
  unknown: number
  /** Plain-language summary, safe to display verbatim. */
  note: string
}

/**
 * The largest empty arc among a set of azimuths.
 *
 * The wrap-around arc -- from the last azimuth back round to the first -- is
 * the one that matters and the one that is easy to forget: a capture covering
 * 300 degrees with a 60-degree hole is not a full orbit, and only the
 * wrap-around gap says so. Returns null below two usable angles.
 */
export function gapOf(azimuths: number[]): number | null {
  const angles = azimuths.filter(finite).map(normaliseDeg).sort((a, b) => a - b)
  if (angles.length < 2) return null
  let max = angles[0] + 360 - angles[angles.length - 1]
  for (let i = 1; i < angles.length; i += 1) {
    max = Math.max(max, angles[i] - angles[i - 1])
  }
  return max
}

/** Which 30-degree wedges contain a photo. Wedge 0 spans [0, 30). */
export function sectorsOf(azimuths: number[]): boolean[] {
  const sectors = new Array<boolean>(SECTOR_COUNT).fill(false)
  for (const raw of azimuths) {
    if (!finite(raw)) continue
    const index = Math.floor(normaliseDeg(raw) / (360 / SECTOR_COUNT)) % SECTOR_COUNT
    sectors[index] = true
  }
  return sectors
}

/**
 * Describe how completely a set of headings swept around the object.
 *
 * `unknown` counts photos the user supplied or that the shutter caught before
 * the compass woke up. They are counted but ignored, because folding a photo
 * with no known direction into the gap calculation would be inventing data.
 * Returns null when fewer than two photos have a heading -- the caller then
 * says the coverage is unknown instead of drawing an empty ring.
 */
export function summarise(headings: readonly (Heading | null | undefined)[], unknown = 0): OrbitReport | null {
  const azimuths = headings
    .filter((h): h is Heading => !!h && finite(h.azimuthDeg))
    .map((h) => h.azimuthDeg)

  const maxGapDeg = gapOf(azimuths)
  if (maxGapDeg === null) return null

  const spreadTurns = (360 - maxGapDeg) / 360
  const fullOrbit = maxGapDeg <= FULL_ORBIT_GAP_DEG

  const note = fullOrbit
    ? `You have swept every direction, with no gap wider than ${maxGapDeg.toFixed(0)}°.`
    : `The widest stretch you have not photographed yet is ${maxGapDeg.toFixed(0)}°. Keep circling that side.`

  return {
    sectors: sectorsOf(azimuths),
    maxGapDeg,
    spreadTurns,
    fullOrbit,
    measured: azimuths.length,
    unknown,
    note,
  }
}

/**
 * Ask for motion access where the platform requires an explicit grant (iOS 13+).
 *
 * Callers must subscribe to `deviceorientation` BEFORE calling this, and must
 * not treat a `false` return as a reason to stop listening. Both rules came
 * from a real failure: Chromium exposes `requestPermission` but never settles
 * the promise, so gating the subscription on the awaited result left the
 * listener permanently unattached and the ring permanently unmeasured.
 */
export async function requestOrientationPermission(): Promise<boolean> {
  const ctor = (globalThis as {
    DeviceOrientationEvent?: { requestPermission?: () => Promise<string> }
  }).DeviceOrientationEvent
  if (typeof ctor?.requestPermission !== 'function') return true
  try {
    return (await ctor.requestPermission()) === 'granted'
  } catch {
    // A refusal or a browser that throws is not fatal: with no events arriving
    // the screen falls back to saying coverage is unmeasured.
    return false
  }
}
