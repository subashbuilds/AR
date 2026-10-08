import type { ReactNode } from 'react'

import { SECTOR_COUNT } from '../lib/orbit'
import type { Heading, OrbitReport } from '../lib/orbit'

// Capture overlays drawn over the live camera preview.
//
// These are GUIDES, not measurements, and the distinction matters. The
// wireframe cube says nothing about the object: there is no on-device detector.
// `OrbitRing` is the only overlay that measures anything, and what it measures
// is the set of directions the camera pointed — never the object's own shape.
// It says which it is in the label beneath it, and says so loudest when it
// CANNOT measure, which is the case that matters.

/** Isometric wireframe box showing the volume the capture should fill. */
export function CaptureCube({ size = 190 }: { size?: number }) {
  const w = size
  const h = size * 0.92
  const cx = w / 2
  const cy = h / 2
  const dx = w * 0.3
  const dy = h * 0.18
  const dz = h * 0.34

  // Front face, back face, and the four connecting edges.
  const front: [number, number][] = [
    [cx - dx, cy - dz],
    [cx + dx, cy - dz],
    [cx + dx, cy + dz],
    [cx - dx, cy + dz],
  ]
  const back: [number, number][] = [
    [cx - dx, cy - dz - dy],
    [cx + dx, cy - dz - dy],
    [cx + dx, cy + dz - dy],
    [cx - dx, cy + dz - dy],
  ]
  const poly = (pts: [number, number][]) => pts.map(([x, y]) => `${x},${y}`).join(' ')

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <g fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.4" strokeLinejoin="round">
        <polygon points={poly(front)} fill="rgba(255,255,255,0.04)" strokeDasharray="6 5" />
        <polygon points={poly(back)} stroke="rgba(255,255,255,0.35)" strokeDasharray="4 6" />
        {[0, 1, 2, 3].map((i) => (
          <line
            key={i}
            x1={front[i][0]}
            y1={front[i][1]}
            x2={back[i][0]}
            y2={back[i][1]}
            stroke="rgba(255,255,255,0.35)"
          />
        ))}
      </g>
      <circle cx={cx} cy={cy} r="3" fill="#0a84ff" />
    </svg>
  )
}

const WEDGE = 360 / SECTOR_COUNT

/** Annulus sector path, 0 degrees at the top, clockwise. */
function wedgePath(cx: number, cy: number, rOuter: number, rInner: number, from: number, to: number): string {
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180
  const x0 = cx + rOuter * Math.cos(rad(from))
  const y0 = cy + rOuter * Math.sin(rad(from))
  const x1 = cx + rOuter * Math.cos(rad(to))
  const y1 = cy + rOuter * Math.sin(rad(to))
  const x2 = cx + rInner * Math.cos(rad(to))
  const y2 = cy + rInner * Math.sin(rad(to))
  const x3 = cx + rInner * Math.cos(rad(from))
  const y3 = cy + rInner * Math.sin(rad(from))
  const large = to - from > 180 ? 1 : 0
  return [
    `M ${x0} ${y0}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1}`,
    `L ${x2} ${y2}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x3} ${y3}`,
    'Z',
  ].join(' ')
}

/**
 * Live capture-coverage ring: one wedge per 30 degrees of compass bearing,
 * filled once a photo has been taken in it, plus a marker for where the camera
 * is pointing right now.
 *
 * The rules this component follows, so it cannot quietly overstate:
 *
 *   * A filled wedge means "the camera pointed here", never "this side of the
 *     object is complete". The caption says so.
 *   * With no compass reading the ring renders in an explicitly UNMEASURED
 *     state and says the coverage is unknown. An empty ring drawn as though it
 *     meant "0% covered" would be a lie, because the truth is "not measured".
 *   * The widest unswept arc is printed as a number, because that is the one
 *     figure the user can act on: it says how far round to keep going.
 */
export function OrbitRing({
  report,
  live,
  size = 132,
  children,
}: {
  report: OrbitReport | null
  live: Heading | null
  size?: number
  children?: ReactNode
}) {
  const cx = size / 2
  const rOuter = size / 2 - 3
  const rInner = rOuter - 13
  const measured = report !== null

  return (
    <div className="orbit" data-orbit-ring="" data-measured={measured ? 'true' : 'false'}
      data-full-orbit={report?.fullOrbit ? 'true' : 'false'}
      data-max-gap={report ? report.maxGapDeg.toFixed(1) : ''}
      data-measured-shots={report ? String(report.measured) : '0'}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {Array.from({ length: SECTOR_COUNT }, (_, i) => {
          const from = i * WEDGE
          const covered = report?.sectors[i] ?? false
          return (
            <path
              key={i}
              d={wedgePath(cx, cx, rOuter, rInner, from, from + WEDGE - 1.5)}
              fill={covered ? 'var(--blue)' : 'rgba(255,255,255,0.10)'}
              stroke={covered ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.14)'}
              strokeWidth="0.75"
            />
          )
        })}
        {/* North tick, so the wedge positions mean something. */}
        <line
          x1={cx}
          y1={cx - rOuter - 1}
          x2={cx}
          y2={cx - rOuter + 6}
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="1.5"
        />
        {live && (
          <g transform={`rotate(${live.azimuthDeg} ${cx} ${cx})`}>
            <polygon
              points={`${cx},${cx - rOuter - 5} ${cx - 4.5},${cx - rOuter + 3} ${cx + 4.5},${cx - rOuter + 3}`}
              fill="var(--amber)"
            />
          </g>
        )}
      </svg>
      {children && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            fontSize: 15,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            pointerEvents: 'none',
          }}
        >
          {children}
        </div>
      )}
      <div className="orbit-note faint">
        {!measured && 'Compass unavailable — coverage is not being measured.'}
        {measured && report!.note}
      </div>
    </div>
  )
}