// Loads a reconstructed GLB and reports what the worker recorded about it.

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREE from 'three'

export interface LoadedModel {
  root: THREE.Group
  box: THREE.Box3
  size: THREE.Vector3
  centre: THREE.Vector3
  vertexCount: number
  triangleCount: number
  /**
   * Whether a base-colour texture actually bound to the loaded material, and
   * its pixel size. Reported rather than assumed: a GLB can declare a texture
   * that the loader never resolves, and the model would then render flat.
   */
  textured: boolean
  textureSize: [number, number] | null
}

export function loadModel(url: string): Promise<LoadedModel> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => {
        const root = gltf.scene
        // Centre on the origin and sit the model on y = 0 so it rests on a
        // detected floor rather than intersecting it. This does not change the
        // model's size, which is what the physical scale depends on.
        root.updateWorldMatrix(true, true)
        const box = new THREE.Box3().setFromObject(root)
        const size = box.getSize(new THREE.Vector3())
        const centre = box.getCenter(new THREE.Vector3())
        root.position.set(-centre.x, -box.min.y, -centre.z)

        let vertexCount = 0
        let triangleCount = 0
        let textureSize: [number, number] | null = null
        root.traverse((child) => {
          const mesh = child as THREE.Mesh
          if (!mesh.isMesh) return
          const geometry = mesh.geometry as THREE.BufferGeometry
          const position = geometry.getAttribute('position')
          if (position) vertexCount += position.count
          const index = geometry.getIndex()
          triangleCount += Math.floor((index ? index.count : position?.count ?? 0) / 3)
          const material = mesh.material as THREE.MeshStandardMaterial
          // Only meaningful for the vertex-colour fallback models, which this
          // pipeline no longer produces; harmless when the attribute is absent.
          if (material && 'vertexColors' in material) material.vertexColors = true
          const map = material?.map
          const image = map?.image as { width?: number; height?: number } | undefined
          if (map && image?.width && image?.height) {
            textureSize = [image.width, image.height]
          }
          material.needsUpdate = true
        })

        resolve({
          root,
          box,
          size,
          centre,
          vertexCount,
          triangleCount,
          textured: textureSize !== null,
          textureSize,
        })
      },
      undefined,
      (err) => reject(new Error(`Could not load the model: ${(err as Error).message ?? 'unknown error'}`)),
    )
  })
}

/** WebXR capability probe. The reasons are shown to the user verbatim. */
export interface ArCapability {
  immersiveAr: boolean
  domOverlay: boolean
  /** Whether a surface can be detected. Undefined means "not knowable before the
   * session starts"; the AR view reports it truthfully if the hit-test source
   * turns out to be unavailable. */
  hitTest: boolean | null
  supported: boolean
  reason: string
}

export async function probeAr(): Promise<ArCapability> {
  const xr: XRSystem | undefined = navigator.xr
  if (!xr) {
    return {
      immersiveAr: false,
      hitTest: false,
      domOverlay: false,
      supported: false,
      reason: 'This browser has no WebXR support. AR needs Android Chrome with Google Play Services for AR, or a supported iOS browser.',
    }
  }
  let immersiveAr = false
  try {
    immersiveAr = await xr.isSessionSupported('immersive-ar')
  } catch (err) {
    return {
      immersiveAr: false,
      hitTest: false,
      domOverlay: false,
      supported: false,
      reason: `WebXR refused to report capabilities: ${(err as Error).message}`,
    }
  }
  const domOverlay = 'DOMOverlay' in xr && typeof xr.DOMOverlay === 'function'
  if (!immersiveAr) {
    return {
      immersiveAr,
      hitTest: false,
      domOverlay,
      supported: false,
      reason: 'This device reports no immersive-AR session support. Try Android Chrome with ARCore installed.',
    }
  }
  return {
    immersiveAr,
    hitTest: null,
    domOverlay,
    supported: true,
    reason: 'AR session support is available. Surface detection is confirmed when the session starts.',
  }
}