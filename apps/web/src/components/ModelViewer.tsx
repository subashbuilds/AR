// Interactive model viewer. Loads the GLB the worker actually produced and
// renders its baked texture atlas -- falling back to vertex colours only if
// the file carries no texture, and saying so in the HUD when it does not.

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

import { loadModel } from '../lib/model'

interface Props {
  url: string
  /** Shown in the HUD, e.g. "2.00 m tall (calibrated)". */
  caption?: string
}

export function ModelViewer({ url, caption }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<string | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#05070c')

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    } catch (err) {
      // A device without a usable WebGL context must still get a page, not a
      // blank screen: say what failed and leave the rest of the app usable.
      setError(
        `This browser could not create a WebGL context, so the 3D preview is unavailable: ${
          (err as Error).message
        }`,
      )
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500)
    const target = new THREE.Vector3()
    let distance = 2
    let placed = false

    // Drag to orbit. Rotation is applied to the model, never to the camera's
    // scale, so the displayed size always reflects the file's real metres.
    let dragging = false
    let lastX = 0
    let lastY = 0
    const pivot = new THREE.Group()
    scene.add(pivot)

    const onDown = (event: PointerEvent) => {
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
      renderer.domElement.setPointerCapture(event.pointerId)
    }
    const onMove = (event: PointerEvent) => {
      if (!dragging) return
      pivot.rotation.y += (event.clientX - lastX) * 0.008
      pivot.rotation.x += (event.clientY - lastY) * 0.008
      lastX = event.clientX
      lastY = event.clientY
    }
    const onUp = (event: PointerEvent) => {
      dragging = false
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId)
      }
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)

    const lights = new THREE.Group()
    const key = new THREE.DirectionalLight(0xffffff, 2.1)
    key.position.set(2, 3, 2)
    const fill = new THREE.DirectionalLight(0x88aaff, 0.9)
    fill.position.set(-2, 1, -2)
    lights.add(key, fill, new THREE.AmbientLight(0xffffff, 0.55))
    scene.add(lights)

    const resize = () => {
      const w = mount.clientWidth || 1
      const h = mount.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    let disposed = false
    let frame = 0
    const tick = () => {
      if (disposed) return
      frame = requestAnimationFrame(tick)
      if (!placed) pivot.rotation.y += 0.0035
      renderer.render(scene, camera)
    }

    loadModel(url)
      .then((model) => {
        if (disposed) return
        pivot.add(model.root)
        // Frame the model from its real bounding box: one metre is one unit.
        distance = Math.max(model.size.x, model.size.y, model.size.z) * 2.1
        camera.position.set(0, model.size.y * 0.5 + distance * 0.18, distance)
        camera.near = Math.max(distance / 1000, 0.001)
        camera.far = distance * 100
        camera.updateProjectionMatrix()
        target.set(0, model.size.y * 0.5, 0)
        camera.lookAt(target)
        placed = true
        // Say what the viewer actually bound, not what the file claims: a
        // texture the loader failed to resolve renders as flat colour.
        const surface = model.textured && model.textureSize
          ? `baked texture ${model.textureSize[0]}×${model.textureSize[1]}`
          : 'vertex colours, no texture bound'
        setStats(
          `${model.vertexCount.toLocaleString()} vertices · ${model.triangleCount.toLocaleString()} triangles · ${surface} · ${model.size.y.toFixed(2)} m tall`,
        )
      })
      .catch((err: Error) => setError(err.message))

    tick()

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onUp)
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [url])

  return (
    <div className="viewer">
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="hud">
        <span className="pill">drag to rotate</span>
        {stats && <span className="pill">{stats}</span>}
        {caption && <span className="pill">{caption}</span>}
      </div>
      {error && (
        <div style={{ padding: 18 }}>
          <div className="note error">{error}</div>
        </div>
      )}
    </div>
  )
}