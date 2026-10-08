// QR sheet. The code is generated in the browser from the share URL with the
// `qrcode` package — the URL is the only thing encoded, so scanning it always
// resolves to the live model rather than a cached copy.

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

interface Props {
  url: string
  size?: number
}

export function QrSheet({ url, size = 284 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    QRCode.toCanvas(canvas, url, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0d12', light: '#ffffff' },
    })
      .then(() => setError(null))
      .catch((err: Error) => setError(`Could not render the QR code: ${err.message}`))
  }, [url, size])

  return (
    <div className="qr-wrap" style={{ maxWidth: size + 36 }}>
      <canvas ref={canvasRef} aria-label={`QR code for ${url}`} />
      <div className="qr-logo">AR</div>
      {error && (
        <div className="note error" style={{ position: 'absolute', inset: 'auto 8px 8px' }}>
          {error}
        </div>
      )}
      <div className="faint" style={{ textAlign: 'center', marginTop: 10, wordBreak: 'break-all' }}>
        {url}
      </div>
    </div>
  )
}