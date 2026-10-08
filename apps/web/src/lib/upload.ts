// Getting photographs to the reconstruction service.
//
// Two routes, one decision:
//
//   direct  the API hands out a short-lived upload URL and the photographs go
//           straight to the object store, so they never pass through the API's
//           request-body limit. The API verifies what landed before any worker
//           is allowed to see it.
//   body    the photographs travel inside the JSON request, base64 encoded,
//           bounded by MAX_BODY_BYTES. This is the path every deployment had
//           before direct uploads existed, and it is what local disk uses.
//
// Direct is preferred when the deployment advertises it, and the body route is
// the fallback for *any* failure on the direct route: a store that refuses an
// upload, a bucket whose CORS rules block the preflight, a browser without
// WebCrypto. One capture either way, and the error the user finally sees comes
// from the route that was actually used.

import {
  ApiError,
  completeDirectUpload,
  createCapture,
  createDirectUpload,
  dataUrlMediaType,
  dataUrlToBytes,
  uploadToStore,
} from './api.ts'
import type { Calibration, Capture, Health } from './api.ts'

export interface ShotLike {
  dataUrl: string
}

/**
 * Send a prepared capture and wait for the server to accept it. Returns which
 * route was used, so a caller (or a test) can tell what actually happened
 * rather than assuming the preferred one was available.
 */
export async function submitShots(input: {
  shots: ShotLike[]
  name: string
  calibration: Calibration | null
  direct?: boolean
}): Promise<{ capture: Capture; route: 'direct' | 'body' }> {
  const { shots, name, calibration } = input
  const canUseDirect =
    Boolean(input.direct) &&
    shots.length > 0 &&
    typeof crypto !== 'undefined' &&
    Boolean(crypto.subtle)

  if (canUseDirect) {
    try {
      // Decode once: the declared size and the uploaded bytes must be the same
      // array, or the manifest would describe something the store never saw.
      const payloads = shots.map((shot) => ({
        bytes: dataUrlToBytes(shot.dataUrl),
        contentType: dataUrlMediaType(shot.dataUrl) ?? 'image/jpeg',
      }))
      const prepared = await createDirectUpload({
        name,
        images: payloads.map((p) => ({ contentType: p.contentType, bytes: p.bytes.length })),
        scale_calibration: calibration,
      })
      for (const [index, target] of prepared.uploads.entries()) {
        await uploadToStore(target, payloads[index].bytes)
      }
      return { capture: await completeDirectUpload(prepared.id), route: 'direct' }
    } catch (err) {
      // A signed-out session is not a reason to try the other route: it would
      // fail the same way, and the user needs to be told to sign in rather than
      // see a second, unrelated error.
      if (err instanceof ApiError && err.status === 401) throw err
      // Anything else falls through. If the capture row was already created, it
      // is an `uploading` row with no usable data: it is not shown in the
      // capture list and the server's retention sweep removes it on its own.
    }
  }

  const capture = await createCapture({
    name,
    images: shots.map((shot) => shot.dataUrl),
    scale_calibration: calibration,
  })
  return { capture, route: 'body' }
}

/** Whether this deployment offered direct uploads when the page asked. */
export function directUploadsOffered(health: Health | null): boolean {
  return Boolean(health?.storage?.directUploads)
}
