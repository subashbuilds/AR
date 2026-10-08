// The AR route opened by a shared QR code. It is a standalone page: no app
// chrome, because a phone scanning a code wants the camera immediately.
//
// If the device cannot run an immersive-AR session, the page says so plainly and
// falls back to the 3D model rather than showing a dead black screen.

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { ArView } from '../components/ArView'
import { ModelViewer } from '../components/ModelViewer'
import { getCapture, getResult, modelUrl, shareTokenFromLocation } from '../lib/api'
import type { Capture, WorkerResult } from '../lib/api'
import { probeAr } from '../lib/model'
import type { ArCapability } from '../lib/model'
import { navigate, useTitle } from '../lib/router'

export function ArPage({ id }: { id: string }) {
  useTitle('AR · ObjectCapture AR')
  const [result, setResult] = useState<WorkerResult | null>(null)
  const [capture, setCapture] = useState<Capture | null>(null)
  const [capability, setCapability] = useState<ArCapability | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A phone that scanned the owner's QR has no account, so the share token in
  // the URL is the only thing that authorises its model fetch. It must be
  // carried through to every request this page makes.
  const token = shareTokenFromLocation()

  useEffect(() => {
    let alive = true
    probeAr().then((cap) => alive && setCapability(cap))
    Promise.all([getResult(id, token), getCapture(id, token).catch(() => null)])
      .then(([r, c]) => {
        if (!alive) return
        setResult(r)
        setCapture(c)
      })
      .catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [id, token])

  if (error) {
    return (
      <PlainPage>
        <div className="card">
          <h3>Model unavailable</h3>
          <p>{error}</p>
          <button className="btn primary" onClick={() => navigate('/')}>
            Back to start
          </button>
        </div>
      </PlainPage>
    )
  }

  if (!result || !capability) {
    return (
      <PlainPage>
        <p>Checking this device and loading the model…</p>
      </PlainPage>
    )
  }

  const dims = result.dimensions

  if (!capability.supported) {
    return (
      <PlainPage>
        <div className="eyebrow">{capture?.name ?? 'Captured object'}</div>
        <h2>AR is not available on this device</h2>
        <div className="note warn">{capability.reason}</div>
        <div style={{ marginTop: 14 }}>
          <ModelViewer url={modelUrl(id, token)} caption={dims.display.height} />
        </div>
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button
            className="btn primary"
            onClick={() => navigate(token ? `/model/${id}?t=${encodeURIComponent(token)}` : `/model/${id}`)}
          >
            Open the full model page
          </button>
          <button className="btn ghost" onClick={() => probeAr().then(setCapability)}>
            Re-check this device
          </button>
        </div>
        <p className="faint" style={{ marginTop: 14 }}>
          {dims.calibrated
            ? `This model measures ${dims.display.height} tall.`
            : `This model has no physical measurement, so ${dims.display.height} is a reconstructed estimate, not a measured size.`}
        </p>
      </PlainPage>
    )
  }

  return (
    <ArView
      url={modelUrl(id, token)}
      objectName={capture?.name ?? 'This object'}
      calibrated={dims.calibrated}
      heightLabel={dims.calibrated ? dims.display.height : `${dims.display.height} (uncalibrated)`}
    />
  )
}

function PlainPage({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="mark">AR</span> ObjectCapture
        </span>
      </header>
      <main className="page">{children}</main>
    </div>
  )
}