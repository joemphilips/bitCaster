import { beforeEach, describe, expect, it } from 'vitest'
import type { Proof } from '@cashu/cashu-ts'
import { useActiveSwapsStore } from '../activeSwaps'

beforeEach(() => {
  useActiveSwapsStore.setState({ byTradeId: {} })
})

describe('useActiveSwapsStore', () => {
  it('keeps protocol state on the active swap entry', () => {
    promote('trade-1')

    const adaptorPoint = {
      secret: new Uint8Array([1]),
      point: new Uint8Array([2]),
    }
    const lockedSatProofs = [{ id: 'proof-1' }] as Proof[]

    useActiveSwapsStore
      .getState()
      .setSellerState('trade-1', { adaptorPoint })
    useActiveSwapsStore.getState().setBuyerState('trade-1', {
      ownPreSigsHex: ['own'],
      lockedSatProofs,
      sellerPreSigsHex: ['seller'],
    })

    const swap = useActiveSwapsStore.getState().byTradeId['trade-1']
    expect(swap.sellerState?.adaptorPoint).toBe(adaptorPoint)
    expect(swap.buyerState?.lockedSatProofs).toBe(lockedSatProofs)
  })

  it('claims one in-flight step at a time and releases it', () => {
    promote('trade-1')

    expect(useActiveSwapsStore.getState().claimStep('trade-1', 'settle')).toBe(
      true,
    )
    expect(useActiveSwapsStore.getState().claimStep('trade-1', 'settle')).toBe(
      false,
    )

    useActiveSwapsStore.getState().releaseStep('trade-1', 'settle')

    expect(useActiveSwapsStore.getState().claimStep('trade-1', 'settle')).toBe(
      true,
    )
  })

  it('clears protocol state without removing the visible swap row', () => {
    promote('trade-1')
    useActiveSwapsStore.getState().claimStep('trade-1', 'seller-open')
    useActiveSwapsStore.getState().setSellerState('trade-1', {
      adaptorPoint: {
        secret: new Uint8Array([1]),
        point: new Uint8Array([2]),
      },
    })

    useActiveSwapsStore.getState().clearProtocolState('trade-1')

    const swap = useActiveSwapsStore.getState().byTradeId['trade-1']
    expect(swap).toBeDefined()
    expect(swap.sellerState).toBeNull()
    expect(swap.buyerState).toBeNull()
    expect(swap.inFlightSteps).toEqual({})
  })
})

function promote(tradeId: string) {
  useActiveSwapsStore.getState().promote({
    tradeId,
    orderId: 'order-1',
    marketId: 'market-1',
    ephemeralPrivkeyHex: '11'.repeat(32),
    ephemeralPubkeyHex: '02'.padEnd(66, '0'),
  })
}
