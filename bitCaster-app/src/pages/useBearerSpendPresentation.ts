import { useCallback, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  readGuiBearerSpendTokenPresentable,
  withGuiBearerSpendTokenPresentation,
} from '@/stores/gui-bearer-spend-presentation'
import { currentGuiWalletId } from '@/stores/proof-db'

export function useBearerSpendPresentation(input: {
  token: string | null
  operationId: string | null
  walletAvailable: boolean
  revoke: () => void
}) {
  const { token, operationId, walletAvailable, revoke } = input
  const walletId = walletAvailable && operationId !== null ? currentGuiWalletId() : null
  const presentable = useLiveQuery(
    async () =>
      walletId !== null && operationId !== null ? readGuiBearerSpendTokenPresentable(walletId, operationId) : false,
    [walletId, operationId],
    null,
  )

  useEffect(() => {
    if (token !== null && operationId !== null && presentable === false) {
      revoke()
    }
  }, [operationId, presentable, revoke, token])

  const authorize = useCallback(
    async (present: (token: string) => Promise<void>) => {
      if (walletId === null || operationId === null) {
        revoke()
        return
      }
      await withGuiBearerSpendTokenPresentation(walletId, operationId, present)
    },
    [operationId, revoke, walletId],
  )

  return {
    token: operationId !== null && presentable === true ? token : null,
    authorize,
  }
}
