import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import jsQR from 'jsqr'
import { Camera, ImagePlus, Loader2, ScanLine, X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { companionCopy } from '@/lib/locales/companion'
import { parsePairingQrPayload, type ParsedPairingLink } from '@/lib/companion'

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): Promise<Array<{ rawValue?: string }>>
}

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => BarcodeDetectorLike
  }
}

interface QrScannerModalProps {
  open: boolean
  onClose: () => void
  onDetected: (raw: string, parsed: ParsedPairingLink) => void
}

/**
 * Full-screen mobile camera QR scanner for ShellBeam pairing codes.
 * Uses live `getUserMedia` rear camera + native `BarcodeDetector` (with pure-JS `jsQR` fallback)
 * plus a photo/gallery fallback so scanning works reliably on Android, iOS, and desktop WebViews.
 */
export function QrScannerModal({ open, onClose, onDetected }: QrScannerModalProps) {
  const { locale } = useT()
  const copy = companionCopy[locale] ?? companionCopy['zh-CN']
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const onDetectedRef = useRef(onDetected)
  onDetectedRef.current = onDetected

  const [cameraState, setCameraState] = useState<'starting' | 'ready' | 'error'>('starting')
  const [errorMsg, setErrorMsg] = useState('')
  const [notice, setNotice] = useState('')
  const [decodingImage, setDecodingImage] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let stream: MediaStream | null = null
    let timerId: number | null = null
    let detected = false

    const stopAll = () => {
      if (timerId != null) {
        window.clearInterval(timerId)
        timerId = null
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
        stream = null
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }

    const handleRawValue = (raw: string) => {
      if (detected || cancelled) return
      const trimmed = raw.trim()
      if (!trimmed) return
      const parsed = parsePairingQrPayload(trimmed)
      if (!parsed || !trimmed.toLowerCase().startsWith('shellbeam://')) {
        setNotice(copy.scanQrInvalidLink)
        return
      }
      detected = true
      stopAll()
      onDetectedRef.current(trimmed, parsed)
    }

    const startCamera = async () => {
      setCameraState('starting')
      setErrorMsg('')
      setNotice('')
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState('error')
        setErrorMsg(copy.scanQrUnsupported)
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })
        if (cancelled) {
          stopAll()
          return
        }
        const video = videoRef.current
        if (!video) {
          stopAll()
          return
        }
        video.srcObject = stream
        await video.play().catch(() => {})
        if (cancelled) {
          stopAll()
          return
        }
        setCameraState('ready')

        const nativeDetector = typeof window.BarcodeDetector === 'function'
          ? (() => {
              try {
                return new window.BarcodeDetector({ formats: ['qr_code'] })
              } catch {
                return null
              }
            })()
          : null

        let busy = false
        timerId = window.setInterval(async () => {
          if (busy || detected || cancelled) return
          const v = videoRef.current
          if (!v || v.readyState < 2 || v.videoWidth === 0 || v.videoHeight === 0) return
          busy = true
          try {
            if (nativeDetector) {
              try {
                const codes = await nativeDetector.detect(v)
                const raw = codes.find((c) => c.rawValue)?.rawValue
                if (raw) {
                  handleRawValue(raw)
                  return
                }
              } catch {
                // Fall through to canvas + jsQR
              }
            }
            const canvas = canvasRef.current
            if (!canvas) return
            const maxDim = 640
            const scale = Math.min(1, maxDim / Math.max(v.videoWidth, v.videoHeight))
            const w = Math.max(1, Math.round(v.videoWidth * scale))
            const h = Math.max(1, Math.round(v.videoHeight * scale))
            if (canvas.width !== w) canvas.width = w
            if (canvas.height !== h) canvas.height = h
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            if (!ctx) return
            ctx.drawImage(v, 0, 0, w, h)
            const imageData = ctx.getImageData(0, 0, w, h)
            const result = jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' })
            if (result?.data) {
              handleRawValue(result.data)
            }
          } finally {
            busy = false
          }
        }, 180)
      } catch (err) {
        if (cancelled) return
        stopAll()
        const name = err instanceof DOMException ? err.name : ''
        setCameraState('error')
        setErrorMsg(
          name === 'NotAllowedError' || name === 'PermissionDeniedError'
            ? copy.scanQrCameraDenied
            : copy.scanQrUnsupported,
        )
      }
    }

    void startCamera()
    return () => {
      cancelled = true
      stopAll()
    }
  }, [open, copy.scanQrCameraDenied, copy.scanQrInvalidLink, copy.scanQrUnsupported])

  const handleImagePick = async (file: File | undefined) => {
    if (!file) return
    setDecodingImage(true)
    setNotice('')
    try {
      const bitmap = await createImageBitmap(file)
      const canvas = canvasRef.current ?? document.createElement('canvas')
      const maxDim = 1280
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        setNotice(copy.scanQrNotFound)
        return
      }
      ctx.drawImage(bitmap, 0, 0, w, h)
      bitmap.close?.()
      const imageData = ctx.getImageData(0, 0, w, h)
      const code = jsQR(imageData.data, w, h, { inversionAttempts: 'attemptBoth' })
      if (!code?.data) {
        setNotice(copy.scanQrNotFound)
        return
      }
      const parsed = parsePairingQrPayload(code.data)
      if (!parsed) {
        setNotice(copy.scanQrInvalidLink)
        return
      }
      onDetectedRef.current(code.data, parsed)
    } catch {
      setNotice(copy.scanQrNotFound)
    } finally {
      setDecodingImage(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.scanQrTitle}
      data-testid="qr-scanner-modal"
      className="fixed inset-0 z-[120] flex flex-col bg-black text-white"
      style={{
        paddingTop: 'max(env(safe-area-inset-top), 14px)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 16px)',
      }}
    >
      {/* Hidden canvas for jsQR frame decoding */}
      <canvas ref={canvasRef} className="hidden" />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void handleImagePick(e.target.files?.[0])}
      />

      {/* Top Bar */}
      <header className="relative z-10 flex shrink-0 items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <ScanLine className="h-5 w-5 text-blue-400" />
          <h2 className="text-[16px] font-semibold">{copy.scanQrTitle}</h2>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/12 text-white active:bg-white/20"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      {/* Camera Viewfinder */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          className={cameraState === 'ready' ? 'h-full w-full object-cover' : 'hidden'}
        />

        {cameraState === 'ready' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-64 w-64 rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.52)]">
              <span className="absolute -left-0.5 -top-0.5 h-8 w-8 rounded-tl-2xl border-l-[3px] border-t-[3px] border-blue-400" />
              <span className="absolute -right-0.5 -top-0.5 h-8 w-8 rounded-tr-2xl border-r-[3px] border-t-[3px] border-blue-400" />
              <span className="absolute -bottom-0.5 -left-0.5 h-8 w-8 rounded-bl-2xl border-b-[3px] border-l-[3px] border-blue-400" />
              <span className="absolute -bottom-0.5 -right-0.5 h-8 w-8 rounded-br-2xl border-b-[3px] border-r-[3px] border-blue-400" />
            </div>
          </div>
        )}

        {cameraState === 'starting' && (
          <div className="flex flex-col items-center gap-3 px-6 text-center text-white/80">
            <Loader2 className="h-7 w-7 animate-spin text-blue-400" />
            <p className="text-[13px]">{copy.scanQrTitle}</p>
          </div>
        )}

        {cameraState === 'error' && (
          <div className="mx-6 flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-white/15 bg-white/8 p-5 text-center">
            <Camera className="h-8 w-8 text-amber-400" />
            <p className="text-[13px] leading-relaxed text-white/85">{errorMsg}</p>
          </div>
        )}
      </div>

      {/* Bottom Hint & Photo Fallback */}
      <footer className="relative z-10 shrink-0 space-y-3 bg-gradient-to-t from-black via-black/90 to-transparent px-5 pt-4">
        {notice ? (
          <p className="rounded-xl bg-amber-500/20 px-3.5 py-2 text-center text-[12.5px] text-amber-300">
            {notice}
          </p>
        ) : (
          <p className="text-center text-[12.5px] leading-relaxed text-white/75">
            {copy.scanQrHint}
          </p>
        )}

        <button
          type="button"
          disabled={decodingImage}
          onClick={() => fileInputRef.current?.click()}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 text-[13.5px] font-medium text-white active:bg-white/20 disabled:opacity-50"
        >
          {decodingImage ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
          {copy.scanQrPickImage}
        </button>
      </footer>
    </div>,
    document.body,
  )
}
