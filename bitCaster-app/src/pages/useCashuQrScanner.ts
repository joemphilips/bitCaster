import { useCallback, useEffect, useRef, useState } from 'react'
import type { CashuNut16Decoder } from '@bitcaster/client-sdk/cashuNut16'

type CashuScanResult = 'not-cashu' | 'continue' | 'complete' | 'cashu-error'

export function useCashuQrScanner(input: {
  receiveToken: (token: string) => Promise<void>
  reportError: (message: string) => void
}) {
  const { receiveToken, reportError } = input
  const decoderRef = useRef<CashuNut16Decoder | null>(null)
  const [scanProgress, setScanProgress] = useState<string | null>(null)

  const resetCashuScanner = useCallback(() => {
    decoderRef.current?.close()
    decoderRef.current = null
    setScanProgress(null)
  }, [])

  useEffect(() => resetCashuScanner, [resetCashuScanner])

  const scanCashuPayload = useCallback(
    async (value: string): Promise<CashuScanResult> => {
      const normalized = value.toLowerCase()
      if (normalized.startsWith('ur:')) {
        try {
          const { CashuNut16Decoder } = await import('@bitcaster/client-sdk/cashuNut16')
          const decoder = decoderRef.current ?? new CashuNut16Decoder()
          decoderRef.current = decoder
          const decoded = decoder.receivePart(value)
          if (decoded.kind === 'pending') {
            setScanProgress(
              `Animated QR ${Math.round(decoded.progress * 100)}% (${decoded.receivedFragmentCount}/${decoded.expectedFragmentCount})`,
            )
            return 'continue'
          }
          resetCashuScanner()
          await receiveToken(decoded.token)
          return 'complete'
        } catch (error) {
          resetCashuScanner()
          reportError((error as Error).message)
          return 'continue'
        }
      }
      if (!normalized.startsWith('cashu')) return 'not-cashu'
      try {
        await receiveToken(value)
      } catch (error) {
        reportError((error as Error).message)
        return 'cashu-error'
      }
      return 'complete'
    },
    [receiveToken, reportError, resetCashuScanner],
  )

  return { scanProgress, resetCashuScanner, scanCashuPayload }
}
