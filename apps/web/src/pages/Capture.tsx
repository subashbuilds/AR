// The capture flow: set up, shoot a guided set of photos, then hand them to the
// real reconstruction worker and report its actual progress.
//
// Honesty rules baked into this screen:
//   * The wireframe box and the photo counter are guides. There is no on-device
//     object detector, so nothing here claims to know the object's shape.
//   * The orbit ring DOES measure one thing: which compass directions the
//     camera has pointed. It is not a claim about the object's geometry, it is
//     labelled with the widest arc still unswept, and when the device reports no
//     orientation it says the coverage is unmeasured instead of drawing an empty
//     ring that reads as zero percent.
//   * Progress is the worker's own stage progress, derived from its JSON logs.
//     Percentages are labelled as estimates where they are estimated.
//   * A failed reconstruction is shown as a failure, never retried into a
//     plausible-looking success.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { AccountLink } from '../components/AccountLink'
import { CaptureCube, OrbitRing } from '../components/CaptureGuides'
import { ApiError, cancelCapture, getCapture, getHealth } from '../lib/api'
import { directUploadsOffered, submitShots } from '../lib/upload'
import type { Capture as CaptureRecord, Health } from '../lib/api'
import { filesToShots, formatDuration, grabFrame, openCamera } from '../lib/camera'
import type { CameraHandle, Shot } from '../lib/camera'
import { buildCalibration, EMPTY_DRAFTS, UNITS } from '../lib/measure'
import type { Drafts, Unit } from '../lib/measure'
import {
  createHeadingTracker,
  requestOrientationPermission,
  summarise,
} from '../lib/orbit'
import type { Heading, OrbitReport } from '../lib/orbit'
import { navigate, useTitle } from '../lib/router'

type Step = 'setup' | 'shoot' | 'measure' | 'processing'

const TARGET_SHOTS = 24
const MIN_SHOTS = 12

export function CapturePage() {
  useTitle('Capture · ObjectCapture AR')
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<CameraHandle | null>(null)

  const [step, setStep] = useState<Step>('setup')
  const [name, setName] = useState('')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraStarting, setCameraStarting] = useState(false)
  const [shots, setShots] = useState<Shot[]>([])
  // One entry per photo, parallel to `shots`. `null` means the compass gave no
  // usable direction for that photo (a file picked from disk, or a shutter
  // press before the sensor woke), which is counted as unknown rather than
  // guessed at.
  const [headings, setHeadings] = useState<(Heading | null)[]>([])
  const [liveHeading, setLiveHeading] = useState<Heading | null>(null)
  // Mirrors of state that the shutter and the sensor listener need to read
  // without being re-created (and re-bound) on every photo.
  const shotsRef = useRef<Shot[]>([])
  const trackerRef = useRef(createHeadingTracker())

  const orbitReport = useMemo(
    () => summarise(headings, headings.filter((h) => !h).length),
    [headings],
  )

  useEffect(() => {
    shotsRef.current = shots
  }, [shots])
  const [drafts, setDrafts] = useState<Drafts>(EMPTY_DRAFTS)
  const [unit, setUnit] = useState<Unit>('m')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [record, setRecord] = useState<CaptureRecord | null>(null)

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => setHealth(null))
    return () => cameraRef.current?.stop()
  }, [])

  const startCamera = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    setCameraStarting(true)
    setCameraError(null)
    try {
      cameraRef.current = await openCamera(video)
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      setCameraError(
        name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access, or pick photos from this device below.'
          : err instanceof Error
            ? err.message
            : 'The camera could not be started.',
      )
    } finally {
      setCameraStarting(false)
    }
  }, [])

  useEffect(() => {
    if (step !== 'setup') return
    void startCamera()
  }, [step, startCamera])

  // The setup and shoot steps each render their own <video>, so the stream has
  // to be re-attached whenever the element changes. Without this the shutter
  // would read a dead element the moment the step changes.
  useEffect(() => {
    const video = videoRef.current
    const handle = cameraRef.current
    if (!video || !handle) return
    if (video.srcObject === handle.stream) {
      void video.play().catch(() => undefined)
      return
    }
    video.srcObject = handle.stream
    video.muted = true
    void video.play().catch(() => undefined)
  }, [step])

  const shoot = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    // Guard on the ref, not on `shots`: the setter form below cannot read the
    // current length, and reaching into another setter from inside an updater
    // double-appends under StrictMode.
    if (shotsRef.current.length >= TARGET_SHOTS) return
    try {
      const shot = grabFrame(video)
      const heading = trackerRef.current.live
      setShots((prev) => [...prev, shot])
      setHeadings((prev) => [...prev, heading])
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : 'Could not read a frame from the camera.')
    }
  }, [])

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setSubmitError(null)
    try {
      const picked = await filesToShots(Array.from(files))
      setShots((prev) => [...prev, ...picked].slice(0, TARGET_SHOTS))
      // Photos chosen from disk were not taken by this app, so this device has
      // no idea which way they pointed. They are recorded as unknown rather
      // than inheriting the current heading, which would be a fabrication.
      setHeadings((h) => [...h, ...picked.map(() => null)])
      setStep('shoot')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Those files could not be read as images.')
    }
  }

  async function submit() {
    setSubmitError(null)
    try {
      // Direct-to-store when the deployment offers it; the request-body path
      // otherwise, and as the fallback for any failure on the way. Which one was
      // used is decided in submitShots, not guessed here.
      const { capture } = await submitShots({
        shots,
        name: name.trim() || 'Captured object',
        calibration: buildCalibration(drafts, unit),
        direct: directUploadsOffered(health),
      })
      setRecord(capture)
      setStep('processing')
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : 'The capture could not be sent to the reconstruction service.',
      )
      setStep('measure')
    }
  }

  const closeCamera = () => cameraRef.current?.stop()

  // Listen for orientation only while the shoot screen is up. If the sensor
  // never fires, `orbitReport` stays null and the ring says the coverage is
  // unmeasured -- which is the honest outcome, not an error.
  useEffect(() => {
    if (step !== 'shoot') return
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return

    const onOrientation = (event: DeviceOrientationEvent) => {
      const heading = trackerRef.current.push({
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
        absolute: event.absolute,
        webkitCompassHeading: (event as DeviceOrientationEvent & {
          webkitCompassHeading?: number | null
        }).webkitCompassHeading,
      })
      if (heading) setLiveHeading(heading)
    }

    // Subscribe FIRST, then ask for permission.
    //
    // Subscribing is harmless without permission -- the platform simply never
    // delivers an event -- whereas gating the subscription on the permission
    // promise silently disables the whole feature on any browser that exposes
    // `requestPermission` and then never settles it. Headless Chromium does
    // exactly that, and the end-to-end run caught it: the ring sat at
    // "unmeasured" through thirteen perfectly good headings.
    window.addEventListener('deviceorientation', onOrientation)
    void requestOrientationPermission()

    return () => window.removeEventListener('deviceorientation', onOrientation)
  }, [step])

  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => (e.preventDefault(), navigate('/'))}>
          <span className="mark">AR</span> ObjectCapture
        </a>
        <span className="spacer" />
        {health && (
          <span className={`pill`} style={{ color: health.worker.available ? 'var(--green)' : 'var(--red)' }}>
            {health.worker.available ? 'worker online' : 'worker offline'}
          </span>
        )}
        <AccountLink returnTo="/capture" />
      </header>

      {step === 'setup' && (
        <SetupStep
          videoRef={videoRef}
          name={name}
          setName={setName}
          cameraError={cameraError}
          cameraStarting={cameraStarting}
          onRetryCamera={() => void startCamera()}
          onPickFiles={() => fileRef.current?.click()}
          onStart={() => setStep('shoot')}
          onSkipToShoot={() => setStep('shoot')}
          picked={shots.length}
        />
      )}

      {step === 'shoot' && (
        <ShootStep
          videoRef={videoRef}
          shots={shots}
          orbitReport={orbitReport}
          liveHeading={liveHeading}
          cameraError={cameraError}
          onShoot={shoot}
          onPickFiles={() => fileRef.current?.click()}
          onRemoveLast={() => {
            setShots((prev) => prev.slice(0, -1))
            setHeadings((prev) => prev.slice(0, -1))
          }}
          onBack={() => {
            closeCamera()
            setStep('setup')
          }}
          onDone={() => {
            closeCamera()
            setStep('measure')
          }}
          submitError={submitError}
        />
      )}

      {step === 'measure' && (
        <MeasureStep
          shots={shots}
          name={name.trim() || 'Captured object'}
          drafts={drafts}
          setDrafts={setDrafts}
          unit={unit}
          setUnit={setUnit}
          submitError={submitError}
          onBack={() => setStep('shoot')}
          onSubmit={() => void submit()}
        />
      )}

      {step === 'processing' && (
        <ProcessingStep
          initial={record}
          onReady={(id) => navigate(`/model/${id}`)}
          onRetry={() => {
            setRecord(null)
            setShots([])
            setDrafts(EMPTY_DRAFTS)
            setStep('setup')
            void startCamera()
          }}
        />
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function SetupStep({
  videoRef,
  name,
  setName,
  cameraError,
  cameraStarting,
  onRetryCamera,
  onPickFiles,
  onStart,
  onSkipToShoot,
  picked,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  name: string
  setName: (v: string) => void
  cameraError: string | null
  cameraStarting: boolean
  onRetryCamera: () => void
  onPickFiles: () => void
  onStart: () => void
  onSkipToShoot: () => void
  picked: number
}) {
  return (
    <div className="capture">
      <video ref={videoRef} playsInline muted />
      <div className="veil" />
      <div className="chrome">
        <div className="top">
          <div>
            <div className="title">Fit the object in the box</div>
            <div className="faint" style={{ marginTop: 4 }}>
              Put it on a plain surface with even light.
            </div>
          </div>
        </div>
        <div className="mid">
          <CaptureCube />
        </div>
        <div>
          <label className="faint" htmlFor="object-name">
            Object name (optional)
          </label>
          <input
            id="object-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. garden statue"
            maxLength={80}
            style={{
              width: '100%',
              margin: '6px 0 12px',
              padding: '13px 16px',
              borderRadius: 14,
              background: 'rgba(14,16,21,0.72)',
              border: '1px solid rgba(255,255,255,0.16)',
              color: 'inherit',
            }}
          />
          {cameraError && (
            <div className="note warn" style={{ marginBottom: 12 }}>
              {cameraError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button className="btn pill" onClick={onStart} disabled={cameraStarting}>
              {cameraStarting ? 'Starting camera…' : 'Start Capture'}
            </button>
            <button className="btn quiet" onClick={onPickFiles}>
              Choose photos
            </button>
            {cameraError && (
              <button className="btn quiet" onClick={onRetryCamera}>
                Retry camera
              </button>
            )}
            {picked > 0 && (
              <button className="btn ghost" onClick={onSkipToShoot}>
                {picked} picked · continue
              </button>
            )}
          </div>
          <p className="faint" style={{ marginTop: 14 }}>
            A capture of {MIN_SHOTS}–{TARGET_SHOTS} overlapping photos, walked around the object,
            reconstructs far better than a handful. The reconstruction runs on the server, so the
            photo resolution the camera actually delivers matters.
          </p>
        </div>
      </div>
    </div>
  )
}

function ShootStep({
  videoRef,
  shots,
  orbitReport,
  liveHeading,
  cameraError,
  onShoot,
  onPickFiles,
  onRemoveLast,
  onBack,
  onDone,
  submitError,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  shots: Shot[]
  orbitReport: OrbitReport | null
  liveHeading: Heading | null
  cameraError: string | null
  onShoot: () => void
  onPickFiles: () => void
  onRemoveLast: () => void
  onBack: () => void
  onDone: () => void
  submitError: string | null
}) {
  const ready = shots.length >= MIN_SHOTS

  return (
    <div className="capture">
      <video ref={videoRef} playsInline muted />
      <div className="veil" />
      <div className="thumbstrip">
        {shots.map((shot, i) => (
          <img key={i} src={shot.dataUrl} alt={`Photo ${i + 1}`} />
        ))}
      </div>
      <div className="chrome">
        <div className="top">
          <button className="icon-btn" onClick={onBack} aria-label="Back">
            ‹
          </button>
          <div>
            <div className="title">Walk around the object</div>
            <div className="faint" style={{ marginTop: 4 }}>
              Step sideways and keep 60–80% overlap between shots.
            </div>
          </div>
          <span className="spacer" />
          <OrbitRing report={orbitReport} live={liveHeading}>
            {shots.length}
          </OrbitRing>
        </div>
        <div className="mid" />

        <div className="bottom">
          <span className="badge">
            {shots.length}/{TARGET_SHOTS}
          </span>
          <div style={{ display: 'grid', placeItems: 'center', gap: 10 }}>
            <button className="shutter" onClick={onShoot} aria-label="Take a photo">
              <span className="dot" />
            </button>
            <div className="faint" style={{ textAlign: 'center' }}>
              {ready ? 'Ready to reconstruct' : `At least ${MIN_SHOTS} photos needed`}
            </div>
          </div>
          <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
            <button className="btn primary" onClick={onDone} disabled={!ready}>
              Continue
            </button>
            <button className="btn quiet" onClick={onPickFiles}>
              Add photos
            </button>
            {shots.length > 0 && (
              <button className="btn quiet" onClick={onRemoveLast}>
                Undo last
              </button>
            )}
          </div>
        </div>
      </div>
      {cameraError && (
        <div style={{ position: 'absolute', left: 16, right: 16, bottom: 150, zIndex: 8 }}>
          <div className="note warn">{cameraError} You can still add photos from this device.</div>
        </div>
      )}
      {submitError && (
        <div style={{ position: 'absolute', left: 16, right: 16, bottom: 150, zIndex: 8 }}>
          <div className="note error">{submitError}</div>
        </div>
      )}
    </div>
  )
}

/**
 * Physical measurement. Optional, and skippable — but without it the model is
 * explicitly uncalibrated and the AR size is approximate, which the screen says
 * before the user decides.
 */
function MeasureStep({
  shots,
  name,
  drafts,
  setDrafts,
  unit,
  setUnit,
  submitError,
  onBack,
  onSubmit,
}: {
  shots: Shot[]
  name: string
  drafts: Drafts
  setDrafts: (d: Drafts) => void
  unit: Unit
  setUnit: (u: Unit) => void
  submitError: string | null
  onBack: () => void
  onSubmit: () => void
}) {
  const calibration = buildCalibration(drafts, unit)
  const primary = calibration ? calibration.axis : undefined
  return (
    <div className="page">
      <div className="eyebrow">Step 3 of 3 · {name}</div>
      <h2>Measure the object</h2>
      <p className="lede">
        {shots.length} photos are ready. One real dimension fixes the model's scale; any others you
        add are used only to check how well the reconstruction matches your ruler.
      </p>

      <div className="card">
        <div className="field">
          <label htmlFor="unit">Units</label>
          <select
            id="unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value as Unit)}
            style={{ maxWidth: 140 }}
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>

        <div className="grid" style={{ marginTop: 4 }}>
          {(['height', 'width', 'depth'] as const).map((axis) => (
            <div className="field" key={axis}>
              <label htmlFor={`measure-${axis}`}>
                {axis[0].toUpperCase() + axis.slice(1)} {primary === axis && '(sets the scale)'}
              </label>
              <input
                id={`measure-${axis}`}
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder={axis === 'height' ? 'e.g. 45' : 'optional'}
                value={drafts[axis]}
                onChange={(e) => setDrafts({ ...drafts, [axis]: e.target.value })}
              />
            </div>
          ))}
        </div>

        {!calibration && (
          <div className="note warn" style={{ marginTop: 12 }}>
            No measurement yet. You can reconstruct without one, but the model will be marked
            <strong> uncalibrated</strong> and AR will place it at its reconstructed size, not a
            measured one.
          </div>
        )}
        {calibration && primary && (
          <div className="note ok" style={{ marginTop: 12 }}>
            Scale will be fixed from your {primary} measurement ({calibration.value} {calibration.unit}).
            The worker applies that single factor uniformly — it never stretches geometry to fit a
            bounding box.
          </div>
        )}
        {submitError && (
          <div className="note error" style={{ marginTop: 12 }}>
            {submitError}
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={onSubmit}>
            {calibration ? 'Reconstruct with scale' : 'Reconstruct without scale'}
          </button>
          <button className="btn ghost" onClick={onBack}>
            Back to photos
          </button>
        </div>
      </div>
    </div>
  )
}

const STAGE_LABELS: Record<string, string> = {
  validate_input: 'Checking the photos',
  feature: 'Finding features',
  sfm: 'Solving camera positions',
  filter: 'Removing stray points',
  review: 'Reviewing each photo',
  surface: 'Building the surface',
  texture: 'Unwrapping and baking the texture',
  calibrate: 'Applying physical scale',
  export_glb: 'Writing the model',
  validate_output: 'Validating the model',
  starting: 'Starting the worker',
  spawn: 'Starting the worker',
  worker: 'Reconstruction',
  cancelling: 'Stopping the worker',
  cancelled: 'Reconstruction cancelled',
}

function ProcessingStep({
  initial,
  onReady,
  onRetry,
}: {
  initial: CaptureRecord | null
  onReady: (id: string) => void
  onRetry: () => void
}) {
  const [record, setRecord] = useState<CaptureRecord | null>(initial)
  const idRef = useRef<string | null>(initial?.id ?? null)
  // Cancellation is a real server operation (DELETE /api/captures/:id), not a
  // client-side pause: `cancelling` only covers the round-trip until the
  // server's own `cancelled` status arrives on the next poll.
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  useEffect(() => {
    const id = idRef.current
    if (!id) return
    let alive = true
    const poll = async () => {
      try {
        const next = await getCapture(id)
        if (!alive) return
        setRecord(next)
        if (next.status === 'completed') {
          window.setTimeout(() => alive && onReady(id), 700)
          return
        }
        // Terminal: failed, or cancelled at the user's request. Either way
        // there is nothing left to poll for.
        if (next.status === 'failed' || next.status === 'cancelled') return
      } catch {
        // A transient poll failure is not fatal; the next tick retries.
      }
      if (alive) window.setTimeout(poll, 2000)
    }
    const timer = window.setTimeout(poll, 1200)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [onReady])

  const stage = record?.stage ?? 'starting'
  const fraction = record?.progress ?? null
  const eta = record?.etaSeconds ?? null
  const failed = record?.status === 'failed'
  const cancelled = record?.status === 'cancelled'
  const active =
    record != null && (record.status === 'queued' || record.status === 'running')

  const onCancel = async () => {
    const id = idRef.current
    if (!id) return
    setCancelling(true)
    setCancelError(null)
    try {
      await cancelCapture(id)
      // The next poll picks up the server's `cancelled` status; if the
      // capture finished in the meantime the server answers 409 and the
      // poll resolves the race in the only direction that can be true.
    } catch (err) {
      setCancelling(false)
      setCancelError(
        err instanceof ApiError ? err.message : 'Could not cancel: the request did not reach the service.',
      )
    }
  }

  return (
    <div className="page">
      <div className="processing">
        <div className="eyebrow">Reconstructing</div>
        <h2>{STAGE_LABELS[stage] ?? stage}</h2>
        <p>
          {record?.note ?? 'Sending your photos to the reconstruction worker.'}
        </p>

        <div className={`bar${fraction === null ? ' indeterminate' : ''}`}>
          <span style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }} />
        </div>

        <div className="faint">
          {fraction === null
            ? 'Progress for this stage is indeterminate — the worker does not report a fraction here.'
            : `Estimated ${Math.round(fraction * 100)}% complete (stage weights${record?.progressSource === 'measured_stage_times' ? ', measured from the previous capture' : ''}).`}
        </div>

        <div style={{ marginTop: 22 }} className="faint">
          {record ? `${record.imageCount} photos · ${formatDuration(record.elapsedSeconds)} elapsed` : '…'}
          <br />
          Keep this page open while processing.{' '}
          {eta !== null ? `Estimated time remaining: ${formatDuration(eta)}` : 'Estimating time remaining…'}
        </div>

        {failed && (
          <div className="note error" style={{ marginTop: 20, textAlign: 'left' }}>
            <strong>Reconstruction failed at stage “{record?.error?.stage}”.</strong>
            <div style={{ marginTop: 6 }}>{record?.error?.message}</div>
            <div className="faint" style={{ marginTop: 8 }}>
              No model was published. More photos, more overlap and more even lighting usually fix this.
            </div>
          </div>
        )}

        {failed && (
          <div style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={onRetry}>
              Try another capture
            </button>
          </div>
        )}

        {(active || cancelling) && !cancelled && !failed && (
          <div style={{ marginTop: 18 }}>
            <button className="btn" onClick={onCancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel reconstruction'}
            </button>
            {cancelError && (
              <div className="faint" style={{ marginTop: 8 }} role="alert">
                {cancelError}
              </div>
            )}
          </div>
        )}

        {cancelled && (
          <div className="note" style={{ marginTop: 20, textAlign: 'left' }}>
            <strong>Reconstruction cancelled.</strong>
            <div style={{ marginTop: 6 }}>
              Nothing was published and no model was written. Your photos are
              still in this session — start again whenever you like.
            </div>
          </div>
        )}

        {cancelled && (
          <div style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={onRetry}>
              Start a new capture
            </button>
          </div>
        )}
      </div>
    </div>
  )
}