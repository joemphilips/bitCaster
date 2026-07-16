import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBearerSpendPresentation } from '../useBearerSpendPresentation'

const mocks = vi.hoisted(() => ({
  liveValue: null as boolean | null,
  present: vi.fn(),
}))

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: vi.fn(() => mocks.liveValue),
}))

vi.mock('@/stores/proof-db', () => ({
  currentGuiWalletId: vi.fn(() => '0'.repeat(64)),
}))

vi.mock('@/stores/gui-bearer-spend-presentation', () => ({
  readGuiBearerSpendTokenPresentable: vi.fn(),
  withGuiBearerSpendTokenPresentation: (...args: unknown[]) => mocks.present(...args),
}))

describe('useBearerSpendPresentation', () => {
  beforeEach(() => {
    mocks.liveValue = null
    mocks.present.mockReset()
  })

  it('never exposes a token without durable operation authority', () => {
    const { result } = renderHook(() =>
      useBearerSpendPresentation({
        token: 'cashuAtoken',
        operationId: null,
        walletAvailable: true,
        revoke: vi.fn(),
      }),
    )

    expect(result.current.token).toBeNull()
  })

  it('exposes a token only after the live durable row is presentable', () => {
    mocks.liveValue = true
    const { result } = renderHook(() =>
      useBearerSpendPresentation({
        token: 'cashuAtoken',
        operationId: 'wallet-send:test',
        walletAvailable: true,
        revoke: vi.fn(),
      }),
    )

    expect(result.current.token).toBe('cashuAtoken')
  })

  it('revokes a cached token when durable presentation authority disappears', async () => {
    mocks.liveValue = false
    const revoke = vi.fn()
    renderHook(() =>
      useBearerSpendPresentation({
        token: 'cashuAtoken',
        operationId: 'wallet-send:test',
        walletAvailable: true,
        revoke,
      }),
    )

    await waitFor(() => expect(revoke).toHaveBeenCalledOnce())
  })

  it('routes copy or share through the exact locked presentation boundary', async () => {
    mocks.liveValue = true
    mocks.present.mockImplementation(
      async (_walletId: string, _operationId: string, present: (token: string) => Promise<void>) =>
        present('cashuAexact'),
    )
    const callback = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useBearerSpendPresentation({
        token: 'cashuAstale',
        operationId: 'wallet-send:test',
        walletAvailable: true,
        revoke: vi.fn(),
      }),
    )

    await act(() => result.current.authorize(callback))

    expect(callback).toHaveBeenCalledWith('cashuAexact')
  })
})
