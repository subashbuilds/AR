// Physical measurements entered by the user.
//
// One measurement is used to fix the model's scale; any others are kept as an
// independent check. That distinction matters: a scale factor derived from a
// single measurement always makes that one axis exact by construction, so the
// only way to show whether the rest of the shape is trustworthy is to compare
// the other axes against the user's own ruler.

import type { Calibration } from './api'

export type Unit = 'mm' | 'cm' | 'm' | 'in' | 'ft'
export type Axis = 'height' | 'width' | 'depth'

export const UNITS: Unit[] = ['cm', 'm', 'mm', 'in', 'ft']

export const UNIT_TO_METRES: Record<Unit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
}

export type Drafts = Record<Axis, string>

export const EMPTY_DRAFTS: Drafts = { height: '', width: '', depth: '' }

export const AXIS_LABEL: Record<Axis, string> = {
  height: 'Height',
  width: 'Width',
  depth: 'Depth',
}

export function toMetres(value: number, unit: Unit): number {
  return value * UNIT_TO_METRES[unit]
}

/** Mirrors pipeline/calibration.py:format_dimension so both ends agree. */
export function formatMetres(metres: number): string {
  const m = Math.abs(metres)
  if (m < 0.01) return `${(metres * 1000).toFixed(1)} mm`
  if (m < 1) return `${(metres * 100).toFixed(1)} cm`
  return `${metres.toFixed(3)} m`
}

/**
 * Builds the calibration payload from the drafts. The first supplied axis
 * (height, then width, then depth) becomes the primary measurement, because the
 * worker's calibration applies a single factor and the tallest dimension is the
 * one a person can most easily measure.
 */
export function buildCalibration(drafts: Drafts, unit: Unit): Calibration | null {
  const parsed = (['height', 'width', 'depth'] as Axis[]).map((axis) => {
    const value = Number(drafts[axis])
    return { axis, value, unit }
  })
  const usable = parsed.filter((p) => Number.isFinite(p.value) && p.value > 0)
  if (usable.length === 0) return null
  const [primary, ...rest] = usable
  return {
    value: primary.value,
    unit: primary.unit,
    source: 'user_measurement',
    axis: primary.axis,
    checks: rest,
  }
}

export interface AgreementRow {
  axis: Axis
  label: string
  measuredMetres: number
  modelMetres: number
  errorRatio: number
}

/**
 * Compares the user's other measurements with what the reconstruction reports.
 * The primary axis is excluded: it is exact by construction and comparing it
 * would flatter the model.
 */
export function compareMeasurements(
  calibration: Calibration | null,
  modelMetres: Record<Axis, number>,
): AgreementRow[] {
  if (!calibration) return []
  const unit = calibration.unit as Unit
  const primaryAxis = calibration.axis as Axis | undefined
  const rows: AgreementRow[] = []

  const push = (axis: Axis, measured: number, measuredUnit: Unit) => {
    if (axis === primaryAxis) return
    const measuredMetres = toMetres(measured, measuredUnit)
    const model = modelMetres[axis]
    if (!(measuredMetres > 0) || !(model > 0)) return
    rows.push({
      axis,
      label: AXIS_LABEL[axis],
      measuredMetres,
      modelMetres: model,
      errorRatio: (model - measuredMetres) / measuredMetres,
    })
  }

  if (typeof calibration.value === 'number') {
    if (primaryAxis) push(primaryAxis, calibration.value, unit)
  }
  for (const check of calibration.checks ?? []) {
    if (!check) continue
    push(check.axis as Axis, Number(check.value), (check.unit as Unit) ?? unit)
  }
  return rows
}