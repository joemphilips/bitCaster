import { useCallback, useState } from 'react'
import {
  cancelGuiBearerSpend,
  inspectGuiBearerSpendCancellation,
  type GuiBearerSpendCancellationPreview,
} from '@/stores/gui-bearer-spend-cancellation'

export function useBearerSpendCancellation(input: {
  operationId: string | null
  clearOperation: () => void
  hideToken: () => void
  reportError: (message: string | null) => void
  complete: (returnedAmount: number) => void
}) {
  const { operationId, clearOperation, hideToken, reportError, complete } = input
  const [preview, setPreview] = useState<GuiBearerSpendCancellationPreview | null>(null)
  const [pending, setPending] = useState(false)

  const inspect = useCallback(async () => {
    if (!operationId) return
    setPending(true)
    reportError(null)
    try {
      const next = await inspectGuiBearerSpendCancellation(operationId)
      setPreview(next)
      if (next.partial) hideToken()
    } catch (error) {
      hideToken()
      reportError((error as Error).message)
    } finally {
      setPending(false)
    }
  }, [hideToken, operationId, reportError])

  const confirm = useCallback(async () => {
    if (!operationId || !preview) return
    setPending(true)
    reportError(null)
    hideToken()
    try {
      const result = await cancelGuiBearerSpend(operationId, preview.fingerprint)
      if (result.kind === 'changed') {
        setPreview(result.preview)
        reportError('The reclaimable proofs or mint fee changed. Review the updated return amount.')
        return
      }
      setPreview(null)
      clearOperation()
      complete(result.preview.returnedAmount)
    } catch (error) {
      reportError((error as Error).message)
    } finally {
      setPending(false)
    }
  }, [clearOperation, complete, hideToken, operationId, preview, reportError])

  const dismiss = useCallback(() => setPreview(null), [])

  return {
    preview,
    pending,
    inspect,
    confirm,
    dismiss,
    restorePreview: setPreview,
  }
}
