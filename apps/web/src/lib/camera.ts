// Camera plumbing for the capture screen.
//
// Every photo is stored as a JPEG data URL at a bounded resolution. The worker
// requires all images to share one resolution, so the encoder normalises every
// frame — camera photos and user-selected files alike — to the same long edge.

export interface Shot {
  dataUrl: string
  width: number
  height: number
}

export const LONG_EDGE = 1280

export interface CameraHandle {
  stream: MediaStream
  stop: () => void
}

/**
 * Opens the rear-facing camera. Resolution is requested but not assumed: the
 * capture screen reports the real resolution it received, because the
 * reconstruction depends on it.
 */
export async function openCamera(video: HTMLVideoElement): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser exposes no camera API (navigator.mediaDevices is unavailable).')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 960 },
    },
    audio: false,
  })
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play()
  return {
    stream,
    stop: () => {
      for (const track of stream.getTracks()) track.stop()
      video.srcObject = null
    },
  }
}

function drawToJpeg(source: CanvasImageSource, w: number, h: number, quality: number): Shot {
  const scale = Math.min(1, LONG_EDGE / Math.max(w, h))
  const cw = Math.round(w * scale)
  const ch = Math.round(h * scale)
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser refused a 2D canvas context.')
  ctx.drawImage(source, 0, 0, cw, ch)
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), width: cw, height: ch }
}

export function grabFrame(video: HTMLVideoElement, quality = 0.9): Shot {
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) throw new Error('The camera has not produced a frame yet.')
  return drawToJpeg(video, w, h, quality)
}

/** Same normalisation for photos the user picks from disk. */
export function fileToShot(file: File): Promise<Shot> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      try {
        resolve(drawToJpeg(image, image.naturalWidth, image.naturalHeight, 0.92))
      } catch (err) {
        reject(err)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`${file.name} is not a readable image.`))
    }
    image.src = url
  })
}

export async function filesToShots(files: File[]): Promise<Shot[]> {
  const shots: Shot[] = []
  for (const file of files) shots.push(await fileToShot(file))
  // The worker rejects mixed resolutions, so normalise to the first shot's size.
  const target = shots[0]
  if (!target) return shots
  return Promise.all(
    shots.map(async (shot) => {
      if (shot.width === target.width && shot.height === target.height) return shot
      const image = await loadImage(shot.dataUrl)
      return drawToJpeg(image, target.width, target.height, 0.92)
    }),
  )
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not decode a captured frame.'))
    image.src = src
  })
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}