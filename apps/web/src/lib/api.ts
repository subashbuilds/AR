// Typed client for the capture API. Every call surfaces the server's own error
// message rather than a generic failure string.

export type CaptureStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface MeasurementCheck {
  axis: 'height' | 'width' | 'depth'
  value: number
  unit: string
}

export interface Calibration {
  value: number
  unit: string
  source: string
  /** Which user measurement fixed the scale ('height' | 'width' | 'depth'). */
  axis?: 'height' | 'width' | 'depth'
  /** Additional measurements, used only to check the reconstruction. */
  checks?: MeasurementCheck[]
}

export interface CaptureError {
  stage: string
  message: string
}

/**
 * Who is looking at this capture. `owner` is the account that made it; `shared`
 * means access came from the capture's `?t=` share token, which is the case for
 * every visit from a scanned QR code.
 */
export type CaptureRole = 'owner' | 'shared'

export interface Capture {
  id: string
  name: string
  status: CaptureStatus
  stage: string | null
  note: string | null
  progress: number | null
  stageProgress: number | null
  progressSource: string | null
  elapsedSeconds: number | null
  etaSeconds: number | null
  imageCount: number
  calibration: Calibration | null
  error: CaptureError | null
  result: WorkerResult | null
  role: CaptureRole
  owned: boolean
  /** The live share token, when sharing is on. Owner-only. */
  shareToken: string | null
  createdAt: number
  updatedAt: number
}

export interface Account {
  id: string
  email: string
  name: string | null
  createdAt: number
}

export interface ShareLink {
  shared: boolean
  share_token: string | null
  model_path?: string
  ar_path?: string
  note?: string
}

export interface Dimensions {
  units: string
  calibrated: boolean
  calibration_source: string
  scale_factor: number
  width_m: number
  height_m: number
  depth_m: number
  diagonal_m: number
  display: { width: string; height: string; depth: string }
  uncertainty_ratio: number | null
  notes: string[]
}

export interface WorkerResult {
  job_id: string
  state: 'completed' | 'failed'
  manifest: {
    vertex_count: number
    triangle_count: number
    registered_views: number
    total_views: number
    point_count: number
    mean_reprojection_error_px: number
    median_track_length: number
    bundle_adjusted: boolean
    surface_area: number
    stage_seconds: Record<string, number>
    pipeline_version: string
    colour_source: string
    has_baked_texture: boolean
    /**
     * One verdict per submitted photo, from the reconstruction's own evidence.
     * `unusable` means the photo never entered the model; `weak` means it did
     * but its evidence is a clear outlier against the rest of this capture.
     * The notes are the reason, phrased for the person who took the photos --
     * the app must show them rather than summarising to "N failed".
     */
    view_quality: {
      views: {
        index: number
        image_name: string
        registered: boolean
        role: 'seed' | 'pnp' | 'unregistered'
        keypoints: number
        best_edge_inliers: number | null
        best_edge_ratio: number | null
        tracks_observed: number
        median_track_length: number
        mean_reprojection_error_px: number | null
        verdict: 'ok' | 'weak' | 'unusable'
        notes: string[]
      }[]
      counts: { ok: number; weak: number; unusable: number; total: number }
      compared_views: number
      /** False when too few photos registered for a median to mean anything. */
      relative_thresholds_used: boolean
      median_tracks_observed: number
      median_reprojection_error_px: number
      flagged: number[]
      note: string
    }
    /**
     * What the texture bake actually did, from the worker's own manifest. The
     * app must not describe a model as fully photographed when the atlas says
     * most of its colour was never observed by a camera.
     */
    texture_atlas: {
      atlas_size: number
      atlas_fill_ratio: number
      covered_texels: number
      visible_texels: number
      filled_texels: number
      unassigned_texels: number
      background_texels: number
      views_used: number
      views_registered: number
      chart_count: number
      seams: number
      texels_per_unit: number
      texel_density_spread: number
    }
    extent_m: number[]
    /**
     * How completely the capture orbited the object, measured from the
     * registered camera centres. Null when there were too few views to
     * measure. A large `max_gap_deg` means part of the object was never
     * photographed, so the model's width and depth are smaller than the real
     * object's -- the app must say so rather than presenting a partial scan
     * as a complete object.
     */
    capture_coverage: {
      azimuth_spread: number
      max_gap_deg: number
      elevation_range_deg: number
      view_count: number
      point_count: number
      note: string
      warnings: string[]
      full_orbit: boolean
    } | null
  }
  validation: { ok: boolean; errors: string[]; details: Record<string, unknown> }
  dimensions: Dimensions
  calibration: {
    calibrated: boolean
    factor: number
    units: string
    measured_value: number | null
    measured_unit: string | null
    measured_axis: string | null
    model_extent_before: number[] | null
    model_extent_after: number[] | null
    notes: string[]
  }
  stages: { stage: string; status: string; seconds?: number }[]
  error: { stage: string; message: string } | null
  elapsed_seconds: number
}

export interface Health {
  ok: boolean
  worker: { available: boolean; entrypoint: string; python: string }
  limits: { minImages: number; maxImages: number; maxImageBytes: number }
  /** Present on every modern server; optional so an older one still parses. */
  storage?: {
    kind: string
    durable: boolean
    /** True only when the client may upload straight to the store. */
    directUploads: boolean
    bucket?: string
    warnings: string[]
  }
  retention?: { captureTtlDays: number; uploadAbandonedMinutes: number; enabled: boolean }
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError(0, `Cannot reach the capture service at ${path}. Is the API running?`)
  }
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      throw new ApiError(res.status, `Unexpected non-JSON response from ${path}`)
    }
  }
  if (!res.ok) {
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      `Request failed with status ${res.status}`
    throw new ApiError(res.status, message)
  }
  return body as T
}

export function getHealth(): Promise<Health> {
  return request<Health>('/api/health')
}

/**
 * `token` is the capture's share token. Without it these calls are authorised
 * by the session cookie alone, so they only work for the owning account.
 */
export function getCapture(id: string, token?: string | null): Promise<Capture> {
  return request<Capture>(`/api/captures/${id}${shareQuery(token)}`)
}

export function getResult(id: string, token?: string | null): Promise<WorkerResult> {
  return request<WorkerResult>(`/api/captures/${id}/result${shareQuery(token)}`)
}

function shareQuery(token?: string | null): string {
  return token ? `?t=${encodeURIComponent(token)}` : ''
}

export function createCapture(input: {
  name: string
  images: string[]
  scale_calibration?: Calibration | null
}): Promise<Capture> {
  return request<Capture>('/api/captures', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export interface CancelResult {
  cancelled: true
  was: 'queued' | 'running'
  capture: Capture
}

/**
 * Cancel a queued or running reconstruction (DELETE /api/captures/:id). A
 * queued capture is dequeued without ever starting; a running one is stopped
 * and lands in the named `cancelled` state -- never `failed`, never
 * `completed`. Terminal states answer 409, surfaced as ApiError with the
 * server's own message like every other call.
 */
export function cancelCapture(id: string): Promise<CancelResult> {
  return request<CancelResult>(`/api/captures/${id}`, { method: 'DELETE' })
}

export function getSession(): Promise<{ user: Account | null; signed_in: boolean }> {
  return request<{ user: Account | null; signed_in: boolean }>('/api/auth/me')
}

export function signUp(input: { email: string; password: string; name?: string }): Promise<{ user: Account }> {
  return request<{ user: Account }>('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function signIn(input: { email: string; password: string }): Promise<{ user: Account }> {
  return request<{ user: Account }>('/api/auth/signin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function signOut(): Promise<{ signed_out: boolean; revoked: boolean }> {
  return request<{ signed_out: boolean; revoked: boolean }>('/api/auth/signout', { method: 'POST' })
}

/** One object the client is expected to send to the store itself. */
export interface UploadTarget {
  key: string
  name: string
  contentType: string
  url: string
  headers: Record<string, string>
  max_bytes: number
}

/**
 * Start a capture whose photographs do NOT pass through the API process. The
 * response carries the upload URLs; the capture stays `uploading` until
 * `completeDirectUpload` is called, and the job runner never sees it before
 * then because there is nothing on disk to reconstruct.
 *
 * A deployment whose driver cannot hand out an upload URL answers `409` with
 * `code: "direct_uploads_unavailable"`; `submitShots` treats that as a signal to
 * use the request-body path, not as a failure.
 */
export function createDirectUpload(input: {
  name: string
  images: { contentType: string; bytes: number }[]
  scale_calibration?: Calibration | null
}): Promise<Capture & { direct: true; uploads: UploadTarget[] }> {
  return request<Capture & { direct: true; uploads: UploadTarget[] }>('/api/captures/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/**
 * Tell the API the upload is finished. It re-checks every object -- it exists,
 * it is inside the size limit, and its bytes really are the declared container
 * -- materialises them for the worker, and only then queues the job. If any
 * check fails the capture is removed whole and the reason is named.
 */
export function completeDirectUpload(id: string): Promise<Capture> {
  return request<Capture>(`/api/captures/${id}/uploads/complete`, { method: 'POST' })
}

/** The bytes behind a `data:` URL, as they are. */
export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The media type a `data:` URL declares, or null when it declares none. */
export function dataUrlMediaType(dataUrl: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl)
  return match ? match[1].toLowerCase() : null
}

/**
 * The checksum the object store verifies. It must describe the bytes the client
 * is sending, which is exactly why the API cannot compute it: the bytes never
 * reach the API.
 */
export async function sha1Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Send one photograph to the store, using the headers the API handed out. The
 * caller must not set `content-length` -- a browser forbids it, and the HTTP
 * client always knows the real one.
 */
export async function uploadToStore(
  target: UploadTarget,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: { ...target.headers, 'x-bz-content-sha1': await sha1Hex(bytes) },
    body: bytes,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new ApiError(
      res.status,
      `The object store refused ${target.name} (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
}

export interface DeleteAccountResult {
  deleted: boolean
  captures_deleted: number
  objects_deleted: number
  sessions_revoked: number
  cancelled: number
}

/**
 * Erase the account and everything it owns: its captures, their stored objects
 * and every session. Confirmed with the password, because a borrowed browser
 * must not be enough to destroy somebody's reconstructions, and irreversible —
 * the server answers `401 "password is incorrect"` rather than doing anything
 * when the confirmation does not match.
 */
export function deleteAccount(password: string): Promise<DeleteAccountResult> {
  return request<DeleteAccountResult>('/api/auth/account', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
}

/**
 * Turn the capture's share link on. Idempotent: asking again returns the same
 * token, so a QR code that was already printed keeps working.
 */
export function createShareLink(id: string): Promise<ShareLink> {
  return request<ShareLink>(`/api/captures/${id}/share`, { method: 'POST' })
}

/** Revoke it. Every device holding the link stops being able to read the model. */
export function revokeShareLink(id: string): Promise<ShareLink> {
  return request<ShareLink>(`/api/captures/${id}/share`, { method: 'DELETE' })
}

/**
 * The share token this page was opened with, if any. A QR code scanned on a
 * second phone lands on `/ar/<id>?t=<token>`, and that token is what authorises
 * the model fetch for a visitor with no account of their own.
 */
export function shareTokenFromLocation(): string | null {
  if (typeof window === 'undefined') return null
  const token = new URLSearchParams(window.location.search).get('t')
  return token && token.length > 0 ? token : null
}

/** The sign-in page for a path that needs an account, preserving the destination. */
export function authPath(returnTo: string): string {
  return `/auth?returnTo=${encodeURIComponent(returnTo)}`
}

/**
 * The model bytes. A URL with no token is only readable by the owning account,
 * which is why the owner can open their own page with no query string at all.
 */
export function modelUrl(id: string, token?: string | null): string {
  return `/api/captures/${id}/model.glb${token ? `?t=${encodeURIComponent(token)}` : ''}`
}

/** Absolute shareable URL for a reconstructed model. */
export function modelShareUrl(id: string, token?: string | null): string {
  return `${window.location.origin}/model/${id}${token ? `?t=${encodeURIComponent(token)}` : ''}`
}

export function arShareUrl(id: string, token?: string | null): string {
  return `${window.location.origin}/ar/${id}${token ? `?t=${encodeURIComponent(token)}` : ''}`
}

/** In-app AR route, without the origin. */
export function arPath(id: string, token?: string | null): string {
  return `/ar/${id}${token ? `?t=${encodeURIComponent(token)}` : ''}`
}