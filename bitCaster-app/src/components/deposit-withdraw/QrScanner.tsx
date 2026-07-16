import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import QrScanner from 'qr-scanner'

interface QrScannerProps {
  onDecode: (data: string) => Promise<'continue' | 'complete'>
  onClose: () => void
  progress?: string | null
}

export function QrScannerView({ onDecode, onClose, progress }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const onDecodeRef = useRef(onDecode)

  useEffect(() => {
    onDecodeRef.current = onDecode
  }, [onDecode])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const scanner = new QrScanner(
      video,
      (result: QrScanner.ScanResult) => {
        scanner.stop()
        void onDecodeRef
          .current(result.data)
          .then((disposition) => {
            if (disposition === 'continue' && scannerRef.current === scanner) {
              void scanner.start()
            }
          })
          .catch(() => {
            if (scannerRef.current === scanner) {
              void scanner.start()
            }
          })
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        onDecodeError: () => {},
      },
    )

    scannerRef.current = scanner
    scanner.start()

    return () => {
      scanner.destroy()
      scannerRef.current = null
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4">
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">Scan QR Code</h2>
        <div className="w-8" />
      </div>

      {/* Camera viewfinder */}
      <div className="flex-1 flex items-center justify-center px-5">
        <div className="w-full max-w-md">
          <div className="rounded-2xl overflow-hidden bg-black">
            <video ref={videoRef} className="w-full" />
          </div>
          {progress ? <p className="mt-3 text-center text-sm text-slate-300">{progress}</p> : null}
        </div>
      </div>
    </div>
  )
}
