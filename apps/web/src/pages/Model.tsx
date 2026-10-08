// The model page: what the worker produced, seen honestly.
//
// The quality panel is generated from the worker's own manifest — registered
// views, reprojection error, texture-atlas statistics, calibration state.
// Nothing here is rounded up to look better than it is.

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { AccountLink } from '../components/AccountLink'
import { ModelViewer } from '../components/ModelViewer'
import { QrSheet } from '../components/QrSheet'
import {
  ApiError,
  arPath,
  arShareUrl,
  authPath,
  createShareLink,
  getCapture,
  getResult,
  modelShareUrl,
  modelUrl,
  revokeShareLink,
  shareTokenFromLocation,
} from '../lib/api'
import type { Capture, WorkerResult } from '../lib/api'
import { compareMeasurements, formatMetres } from '../lib/measure'
import { navigate, useTitle } from '../lib/router'

export function ModelPage({ id }: { id: string }) {
  useTitle('Model · ObjectCapture AR')
  const [result, setResult] = useState<WorkerResult | null>(null)
  const [capture, setCapture] = useState<Capture | null>(null)
  const [error, setError] = useState<{ message: string; status: number } | null>(null)
  // The token this page was opened with (a scanned link), and the owner's own
  // live token if sharing is on. They are the same string for a shared visitor.
  const token = shareTokenFromLocation()
  const [shareToken, setShareToken] = useState<string | null>(null)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([getResult(id, token), getCapture(id, token).catch(() => null)])
      .then(([r, c]) => {
        if (!alive) return
        setResult(r)
        setCapture(c)
        setShareToken(c?.shareToken ?? token)
      })
      .catch((err: Error) => {
        if (!alive) return
        setError({
          message: err.message,
          status: err instanceof ApiError ? err.status : 0,
        })
      })
    return () => {
      alive = false
    }
  }, [id, token])

  async function enableSharing() {
    setShareError(null)
    setShareBusy(true)
    try {
      const link = await createShareLink(id)
      setShareToken(link.share_token)
    } catch (err) {
      setShareError(
        err instanceof ApiError ? err.message : 'The share link could not be created.',
      )
    } finally {
      setShareBusy(false)
    }
  }

  async function stopSharing() {
    setShareError(null)
    setShareBusy(true)
    try {
      await revokeShareLink(id)
      setShareToken(null)
    } catch (err) {
      setShareError(err instanceof ApiError ? err.message : 'Sharing could not be stopped.')
    } finally {
      setShareBusy(false)
    }
  }

  if (error) {
    const signedOut = error.status === 401
    const notShared = error.status === 403
    return (
      <Shell>
        <div className="card">
          <h3>
            {signedOut
              ? 'This model is not public'
              : notShared
                ? 'This model is not shared'
                : 'This model is not available'}
          </h3>
          <p>{error.message}</p>
          {signedOut ? (
            <a
              className="btn primary"
              href={authPath(`/model/${id}`)}
              onClick={(e) => (e.preventDefault(), navigate(authPath(`/model/${id}`)))}
            >
              Sign in as the owner
            </a>
          ) : (
            <button className="btn primary" onClick={() => navigate('/capture')}>
              Start a new capture
            </button>
          )}
        </div>
      </Shell>
    )
  }

  if (!result) {
    return (
      <Shell>
        <div className="card">
          <p>Loading the reconstruction result…</p>
        </div>
      </Shell>
    )
  }

  const m = result.manifest
  const dims = result.dimensions
  const isOwner = capture?.role === 'owner'
  // The owner reads their own capture with a cookie, so no token is needed in
  // the URL; a visitor with no account needs the share token on every request.
  const urlToken = isOwner ? null : token
  const calibration = capture?.calibration ?? null
  const agreement = compareMeasurements(calibration, {
    height: dims.height_m,
    width: dims.width_m,
    depth: dims.depth_m,
  })

  return (
    <Shell wide>
      <div className="model-layout">
        <div>
          <ModelViewer
            url={modelUrl(id, urlToken)}
            caption={dims.calibrated ? `calibrated · ${dims.display.height}` : 'uncalibrated scale'}
          />
          <div className="btn-row" style={{ marginTop: 14 }}>
            <a
              className="btn primary"
              href={arPath(id, urlToken)}
              onClick={(e) => (e.preventDefault(), navigate(arPath(id, urlToken)))}
            >
              View in AR
            </a>
          </div>

          {isOwner ? (
            <div className="card" data-share-panel style={{ marginTop: 14 }}>
              <h3>Share this model</h3>
              {shareToken ? (
                <>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Anyone holding this link can read the model — not change it — until you stop
                    sharing. The link is what grants access: the page address on its own does not.
                  </p>
                  <div style={{ textAlign: 'center' }}>
                    <QrSheet url={arShareUrl(id, shareToken)} />
                  </div>
                  <p className="faint" style={{ marginTop: 12 }}>
                    Scan with a second phone. It opens this model in WebXR AR at its reconstructed
                    size — there is no scale slider, so the size you see is the size the worker
                    solved.
                  </p>
                  <div className="btn-row" style={{ justifyContent: 'center' }}>
                    <a
                      className="btn ghost"
                      href={arPath(id, shareToken)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open the AR link
                    </a>
                    <a
                      className="btn quiet"
                      href={modelShareUrl(id, shareToken)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Share this page
                    </a>
                    <button className="btn quiet" onClick={() => void stopSharing()} disabled={shareBusy}>
                      {shareBusy ? 'Stopping…' : 'Stop sharing'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="muted" style={{ marginTop: 0 }}>
                    This model is private to your account. Create a link to let another device view
                    it. You can stop sharing at any time, and a revoked link stops working on the
                    next request.
                  </p>
                  <button
                    className="btn primary"
                    onClick={() => void enableSharing()}
                    disabled={shareBusy}
                  >
                    {shareBusy ? 'Creating the link…' : 'Create a share link'}
                  </button>
                </>
              )}
              {shareError && (
                <div className="note error" role="alert" style={{ marginTop: 12 }}>
                  {shareError}
                </div>
              )}
            </div>
          ) : (
            token && (
              <div className="note" style={{ marginTop: 14 }}>
                <strong>You are viewing a shared model.</strong> The owner can stop sharing at any
                time, and this link will stop opening.
              </div>
            )
          )}
        </div>

        <div>
          <div className="card">
            <h3>What was reconstructed</h3>
            <div className="stat">
              <span className="k">Triangles</span>
              <span className="v">{m.triangle_count.toLocaleString()}</span>
            </div>
            <div className="stat">
              <span className="k">Vertices</span>
              <span className="v">{m.vertex_count.toLocaleString()}</span>
            </div>
            <div className="stat">
              <span className="k">Views registered</span>
              <span className="v">
                {m.registered_views} of {m.total_views}
              </span>
            </div>
            <div className="stat">
              <span className="k">Reprojection error</span>
              <span className="v">{m.mean_reprojection_error_px.toFixed(3)} px</span>
            </div>
            <div className="stat">
              <span className="k">Bundle adjusted</span>
              <span className="v">{m.bundle_adjusted ? 'yes' : 'no'}</span>
            </div>
            <div className="stat">
              <span className="k">Orbit gap</span>
              <span className="v">
                {m.capture_coverage ? `${Math.round(m.capture_coverage.max_gap_deg)}°` : 'n/a'}
              </span>
            </div>
            <div className="stat">
              <span className="k">Pipeline</span>
              <span className="v">v{m.pipeline_version}</span>
            </div>
          </div>

          {m.capture_coverage && !m.capture_coverage.full_orbit && (
            <div className="note warn" role="status">
              <strong>Partial capture.</strong> {m.capture_coverage.note}
              {m.capture_coverage.warnings.length > 0 && (
                <ul className="muted" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
                  {m.capture_coverage.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <p className="muted" style={{ margin: '10px 0 0' }}>
                Re-shoot with photos spread evenly around the object. The geometry here is
                accurate for what was photographed, but the unswept side of the object is
                missing, which is what makes width and depth read low.
              </p>
            </div>
          )}

          {m.view_quality && (
            <div className="card" data-view-review>
              <h3>Photos the model actually used</h3>
              <p className="muted" style={{ margin: '0 0 10px' }}>
                {m.view_quality.note}
              </p>
              {m.view_quality.flagged.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  {m.view_quality.counts.total} photos submitted,{' '}
                  {m.view_quality.counts.ok} used.
                </p>
              ) : (
                <ul style={{ paddingLeft: 18, margin: 0 }}>
                  {m.view_quality.views
                    .filter((v) => v.verdict !== 'ok')
                    .map((v) => (
                      <li key={v.index} style={{ marginBottom: 10 }}>
                        <strong>{v.image_name}</strong>{' '}
                        <span className="muted">
                          — {v.verdict === 'unusable' ? 'not used in the model' : 'used, but carried little'}
                        </span>
                        <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                          {v.notes.join(' ')}
                        </div>
                        <div className="muted" style={{ fontSize: 13 }}>
                          {v.keypoints.toLocaleString()} features ·{' '}
                          {v.tracks_observed} of the model's points seen here
                          {v.best_edge_inliers === null
                            ? ' · matched no other photo'
                            : ` · ${v.best_edge_inliers} verified matches on its best pair`}
                        </div>
                      </li>
                    ))}
                </ul>
              )}
              {!m.view_quality.relative_thresholds_used && (
                <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>
                  Too few photos were placed to compare them against each other, so the
                  used ones are reported without a quality judgement.
                </p>
              )}
            </div>
          )}

          <div className="card">
            <h3>Physical size</h3>
            <div className="stat">
              <span className="k">Height</span>
              <span className="v">{dims.display.height}</span>
            </div>
            <div className="stat">
              <span className="k">Width</span>
              <span className="v">{dims.display.width}</span>
            </div>
            <div className="stat">
              <span className="k">Depth</span>
              <span className="v">{dims.display.depth}</span>
            </div>
            <div className="stat">
              <span className="k">Scale source</span>
              <span className="v">{dims.calibration_source}</span>
            </div>
            {result.calibration.measured_value !== null && result.calibration.measured_value !== undefined && (
              <div className="stat">
                <span className="k">Measured dimension</span>
                <span className="v">
                  {String(result.calibration.measured_value)}{' '}
                  {String(result.calibration.measured_unit ?? '')}
                  {result.calibration.measured_axis ? ` (axis ${result.calibration.measured_axis})` : ''}
                </span>
              </div>
            )}
            {result.calibration.factor !== undefined && result.calibration.factor !== null && (
              <div className="stat">
                <span className="k">Scale factor applied</span>
                <span className="v">
                  {result.calibration.factor.toExponential(3)} m/unit
                </span>
              </div>
            )}
          </div>

          {calibration && (
            <div className="card">
              <h3>Your measurements vs. the reconstruction</h3>
              <p className="faint" style={{ marginTop: 0 }}>
                One measurement fixed the scale, so that axis is exact by construction and is not
                compared. The other axes are the real test.
              </p>
              {agreement.length === 0 ? (
                <div className="note">
                  Only one dimension was supplied, so there is nothing to check the reconstruction
                  against. Measure a second dimension to see whether the shape is trustworthy.
                </div>
              ) : (
                agreement.map((row) => (
                  <div className="agreement" key={row.axis}>
                    <span>{row.label}</span>
                    <span className="muted">
                      you: {formatMetres(row.measuredMetres)} · model: {formatMetres(row.modelMetres)}
                    </span>
                    <span
                      className={`delta ${
                        Math.abs(row.errorRatio) <= 0.05
                          ? 'good'
                          : Math.abs(row.errorRatio) <= 0.2
                            ? 'warn'
                            : 'bad'
                      }`}
                    >
                      {row.errorRatio >= 0 ? '+' : ''}
                      {(row.errorRatio * 100).toFixed(0)}%
                    </span>
                  </div>
                ))
              )}
              {agreement.some((r) => Math.abs(r.errorRatio) > 0.2) && (
                <div className="note warn" style={{ marginTop: 12 }}>
                  A large disagreement means the surface is under-covered: more photos, or more
                  angles around the object, will fix it. The AR placement below is still at the
                  scale you measured — it is the shape that is uncertain, not the size.
                </div>
              )}
            </div>
          )}

          <div className="card">
            <h3>Honest limits of this model</h3>
            <ul className="muted" style={{ paddingLeft: 18, margin: '8px 0 0' }}>
              <li>
                Surface detail comes from sparse SIFT points, so the mesh is faceted rather than a
                smooth scan.
              </li>
              <li>
                {m.texture_atlas ? (
                  <>
                    Colour is baked into a {m.texture_atlas.atlas_size}px texture atlas across{' '}
                    {m.texture_atlas.chart_count} chart{m.texture_atlas.chart_count === 1 ? '' : 's'}
                    , split along {m.texture_atlas.seams} seam
                    {m.texture_atlas.seams === 1 ? '' : 's'}; a seam is a real break in the
                    photographic detail, not a join between two photographs.
                  </>
                ) : (
                  'Colour is per-vertex, sampled from the most frontal camera — this model carries no baked texture atlas.'
                )}
              </li>
              {m.texture_atlas && m.texture_atlas.unassigned_texels > 0 && (
                <li>
                  {m.texture_atlas.unassigned_texels.toLocaleString()} texels of the atlas were
                  visible to no camera and are filled flat, so they show as plain patches wherever
                  you look straight at them.
                </li>
              )}
              <li>
                {m.registered_views < m.total_views
                  ? `${m.total_views - m.registered_views} of ${m.total_views} photos were not registered, so some of the surface is missing. Each one is named, with its reason, above.`
                  : 'Every submitted photo was registered.'}
              </li>
              {m.capture_coverage && !m.capture_coverage.full_orbit && (
                <li>
                  The capture left a {Math.round(m.capture_coverage.max_gap_deg)}° gap in its orbit.
                  Whatever faced that direction was never photographed, so the width and depth
                  below understate the real object.
                </li>
              )}
              {dims.calibrated ? (
                <li>
                  The largest axis was set from your measurement, so it is exact by construction; the
                  other two axes are only as good as the reconstruction.
                </li>
              ) : (
                <li>
                  No physical measurement was supplied, so these dimensions are in uncalibrated
                  units and the AR scale is approximate.
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </Shell>
  )
}

export function Shell({
  children,
  wide,
}: {
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => (e.preventDefault(), navigate('/'))}>
          <span className="mark">AR</span> ObjectCapture
        </a>
        <span className="spacer" />
        <a className="btn ghost" href="/capture" onClick={(e) => (e.preventDefault(), navigate('/capture'))}>
          New capture
        </a>
        <AccountLink />
      </header>
      <main className={`page${wide ? ' wide' : ''}`}>{children}</main>
    </div>
  )
}