// Landing page. It explains the product in the order the user performs it, and
// is explicit that the reconstruction is a sparse SfM pipeline rather than a
// dense photogrammetry scan.

import { AccountLink } from '../components/AccountLink'
import { navigate, useTitle } from '../lib/router'

export function LandingPage() {
  useTitle('ObjectCapture AR — photograph an object, place it in your room')

  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => (e.preventDefault(), navigate('/'))}>
          <span className="mark">AR</span> ObjectCapture
        </a>
        <span className="spacer" />
        <a className="btn ghost" href="/capture" onClick={(e) => (e.preventDefault(), navigate('/capture'))}>
          Capture
        </a>
        <AccountLink />
      </header>

      <main className="page">
        <section className="hero">
          <div className="eyebrow">Photograph · reconstruct · place</div>
          <h2>Turn a real object into a real-scale 3D model you can walk around and place in a room.</h2>
          <p className="lede">
            Take a guided set of overlapping photos. A real structure-from-motion pipeline solves the
            camera positions, builds a surface, colours it from your photos and writes a validated
            GLB in metres — which the AR view then places on a detected floor, at that size.
          </p>
          <p className="lede">
            Every capture is kept in an account, because a reconstruction is a real pipeline run
            rather than a preview. A model is private until you create a share link for it, and that
            link is revocable at any moment.
          </p>
          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn primary" onClick={() => navigate('/capture')}>
              Start a capture
            </button>
            <button className="btn ghost" onClick={() => navigate('/capture')}>
              I already have photos
            </button>
          </div>
        </section>

        <section className="card" style={{ marginTop: 26 }}>
          <div className="steps">
            <div className="step">
              <div>
                <h3>Shoot around the object</h3>
                <p style={{ margin: 0 }}>
                  A wireframe box frames the volume; the ring counts your photos. Walk sideways with
                  60–80% overlap until you have a ring's worth of angles. 12–24 photos is the useful
                  range.
                </p>
              </div>
            </div>
            <div className="step">
              <div>
                <h3>The worker reconstructs it</h3>
                <p style={{ margin: 0 }}>
                  SIFT features, a verified view graph, MAGSAC++ essential matrices, incremental PnP,
                  Levenberg–Marquardt bundle adjustment, an alpha-shape surface, then your photos
                  baked into a UV-unwrapped texture atlas with per-texel visibility testing, and
                  an independent re-parse of the written GLB before anything is published.
                </p>
              </div>
            </div>
            <div className="step">
              <div>
                <h3>Watch real progress</h3>
                <p style={{ margin: 0 }}>
                  The processing screen shows the worker's actual stage and note. Percentages are
                  labelled as estimates where they are estimated, and a failure is shown as a
                  failure — no model is produced.
                </p>
              </div>
            </div>
            <div className="step">
              <div>
                <h3>Inspect, share, place it</h3>
                <p style={{ margin: 0 }}>
                  Rotate the model in 3D, create a revocable share link and QR code, and on a second
                  phone place it on a real surface through WebXR hit-testing — with no scale slider,
                  so the size on screen is the size the pipeline solved.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="grid" style={{ marginTop: 22 }}>
          <div className="card">
            <h3>What this is</h3>
            <p style={{ margin: 0 }}>
              A sparse structure-from-motion reconstruction with a baked texture atlas, validated on
              every run. Every number on the model page comes from the worker's own manifest.
            </p>
          </div>
          <div className="card">
            <h3>What this is not</h3>
            <p style={{ margin: 0 }}>
              It is not a dense photogrammetry scan. Expect a faceted surface broken into texture
              seams, colour that is only as good as the photos that saw each patch, and a width and
              depth that are only as accurate as the photo coverage — one axis is calibrated, the
              others are inferred.
            </p>
          </div>
        </section>
      </main>
    </div>
  )
}