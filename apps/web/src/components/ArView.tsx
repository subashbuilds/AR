// WebXR AR view: hit-test placement of the reconstructed model at its true
// physical scale.
//
// Deliberate constraints:
//   * There is NO scale slider. The GLB is in metres and the session is
//     metric; resizing it would defeat the point of the product.
//   * Placement only happens on a real detected surface, so the model can never
//     be shown floating at a guessed depth.
//   * Uncalibrated models are labelled in the overlay rather than silently
//     presented as life-size.

import { useCallback, useRef, useState } from 'react'
import * as THREE from 'three'

import { loadModel } from '../lib/model'

interface Props {
  url: string
  objectName: string
  calibrated: boolean
  heightLabel: string
}

type Phase = 'idle' | 'starting' | 'placing' | 'placed' | 'error'

export function ArView({ url, objectName, calibrated, heightLabel }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)

  // The 3D side of the AR session: camera passthrough plus a hit-test reticle.
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.Camera
    session: XRSession
    reticle: THREE.Mesh
    pivot: THREE.Group
    model: THREE.Group | null
  } | null>(null)

  const start = useCallback(async () => {
    setPhase('starting')
    setMessage(null)
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.xr.enabled = true
      renderer.xr.setReferenceSpaceType('local')
      const mount = mountRef.current
      if (!mount) throw new Error('The AR surface is not mounted.')
      mount.appendChild(renderer.domElement)

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 200)
      scene.add(new THREE.AmbientLight(0xffffff, 0.9))
      const key = new THREE.DirectionalLight(0xffffff, 1.6)
      key.position.set(1, 2, 1)
      scene.add(key)

      const pivot = new THREE.Group()
      scene.add(pivot)

      const reticle = new THREE.Mesh(
        new THREE.RingGeometry(0.08, 0.1, 32).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      )
      reticle.matrixAutoUpdate = false
      reticle.visible = false
      scene.add(reticle)

      const loaded = await loadModel(url)
      pivot.add(loaded.root)
      pivot.visible = false

      const xr = navigator.xr
      if (!xr) throw new Error('WebXR disappeared between the capability check and the session request.')
      const init: XRSessionInit = {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'light-estimation'],
      }
      const root = overlayRef.current
      if (root) init.domOverlay = { root }

      const session = await xr.requestSession('immersive-ar', init)
      sceneRef.current = { renderer, scene, camera, session, reticle, pivot, model: loaded.root }

      const viewerSpace = await session.requestReferenceSpace('viewer')
      const hitTestSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null
      if (!hitTestSource) {
        await session.end()
        throw new Error('This AR session started but offered no hit-test source, so nothing can be placed.')
      }

      await renderer.xr.setSession(session)
      setPhase('placing')

      const resize = () => {
        const w = mount.clientWidth || 1
        const h = mount.clientHeight || 1
        renderer.setSize(w, h, false)
        ;(camera as THREE.PerspectiveCamera).aspect = w / h
        ;(camera as THREE.PerspectiveCamera).updateProjectionMatrix()
      }
      resize()
      window.addEventListener('resize', resize)

      let placed = false
      const localSpace = () => renderer.xr.getReferenceSpace()

      renderer.setAnimationLoop((_time, frame) => {
        if (!frame || !localSpace()) return
        const results = frame.getHitTestResults(hitTestSource)
        if (results.length > 0) {
          const pose = results[0].getPose(localSpace()!)
          if (pose) {
            reticle.visible = !placed
            reticle.matrix.fromArray(pose.transform.matrix)
          }
        } else if (!placed) {
          reticle.visible = false
        }
        renderer.render(scene, camera)
      })

      const onSelect = () => {
        if (placed || !reticle.visible) return
        const matrix = new THREE.Matrix4().fromArray(reticle.matrix.elements)
        pivot.matrixAutoUpdate = false
        pivot.matrix.copy(matrix)
        pivot.visible = true
        reticle.visible = false
        placed = true
        setPhase('placed')
      }
      session.addEventListener('select', onSelect)

      const onEnd = () => {
        renderer.setAnimationLoop(null)
        window.removeEventListener('resize', resize)
        hitTestSource.cancel?.()
        sceneRef.current = null
        renderer.dispose()
        renderer.domElement.remove()
        setPhase('idle')
      }
      session.addEventListener('end', onEnd)
    } catch (err) {
      setPhase('error')
      setMessage(
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'AR permission was denied. Allow camera access for AR and try again.'
          : err instanceof Error
            ? err.message
            : 'The AR session could not be started.',
      )
    }
  }, [url])

  const exit = useCallback(() => {
    void sceneRef.current?.session.end()
  }, [])

  return (
    <div className="ar-screen">
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="ar-overlay" ref={overlayRef}>
        <div className="banner">
          {phase === 'placing' && 'Point at the floor or a table, then tap to place.'}
          {phase === 'placed' &&
            `${objectName} is placed at ${heightLabel}${calibrated ? '' : ' (uncalibrated — size is approximate)'}.`}
          {phase === 'starting' && 'Starting the camera and surface detection…'}
          {phase === 'idle' && 'AR is ready. Tap below to start the camera.'}
        </div>
        {!calibrated && (
          <div className="banner" style={{ marginTop: 10 }}>
            This capture has no physical measurement, so the model is shown at its reconstructed
            size, not a measured one.
          </div>
        )}
        {message && (
          <div className="banner" style={{ marginTop: 10, borderColor: 'rgba(255,69,58,0.5)' }}>
            {message}
          </div>
        )}
        <div className="foot">
          {phase === 'idle' && (
            <button className="btn primary" onClick={() => void start()}>
              Start AR
            </button>
          )}
          {phase !== 'idle' && (
            <button className="btn ghost" onClick={exit}>
              Exit AR
            </button>
          )}
        </div>
      </div>
    </div>
  )
}