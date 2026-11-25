import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { Proof } from '@cashu/cashu-ts'
import * as preparation from '@bitcaster-market/client-sdk/deterministicOutgoingCashuPreparation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'

/** An earlier version saved each unselected proof in the plan. This writer does so again. */
const current = { ...preparation }
mock.module('@bitcaster-market/client-sdk/deterministicOutgoingCashuPreparation', {
  namedExports: {
    ...current,
    prepareDeterministicOutgoingCashuSend: async (
      input: Parameters<typeof current.prepareDeterministicOutgoingCashuSend>[0],
    ) => {
      const prepared = await current.prepareDeterministicOutgoingCashuSend(input)
      const selected = new Set(prepared.preview.inputs.map(({ secret }) => secret))
      const unselectedProofs = input.proofs.filter(({ secret }: Proof) => !selected.has(secret))
      return { ...prepared, preview: { ...prepared.preview, unselectedProofs } }
    },
  },
})
// Import the writer after the mock, so that it uses the mock.
const { DaemonDurableOutgoingCashuCoordinator } =
  await import('../src/durableOutgoingCashuCoordinator.ts')
const { DENOMINATIONS, MINT_URL, SEED, withCustodyWallet } =
  await import('./support/custodyWallet.ts')

for (const answer of ['lost', 'received'] as const) {
  test(`a saved send with more than 500 unselected proofs completes after its mint answer is ${answer}`, async () => {
    const held = DENOMINATIONS.slice(1, 12).flatMap((amount) => Array<number>(47).fill(amount))
    await withCustodyWallet(held, async (fixture) => {
      const coordinator = () =>
        new DaemonDurableOutgoingCashuCoordinator(fixture.directory, fixture.getFence, fixture.deps)
      const wallet = await fixture.openWallet()
      const request = { amountMsat: 3_000, mintUrl: MINT_URL, wallet }
      const before = total(await fixture.spendableAmounts())
      fixture.mint.loseNextSwapAnswer = answer === 'lost'
      const executed = coordinator().execute({
        ...request,
        transferId: 'legacy',
        seed: SEED,
        createWallet: fixture.walletFactory,
      })
      if (answer === 'lost') await assert.rejects(executed, /swap answer is lost/)
      else await executed
      const saved = (await coordinator().loadTransfer('legacy'))!
      const { preview } = saved.walletSendOperation
      assert.equal(preview.unselectedProofs.length, held.length - preview.inputs.length)
      assert.ok(preview.unselectedProofs.length > 500 && preview.unselectedProofs.length <= 512)
      assert.ok(
        preview.unselectedProofs.length + preview.sendOutputs.length + preview.keepOutputs.length >
          512,
        'the earlier version refused this result after the mint signed it',
      )
      const recovered = await coordinator().recover({ ...request, transfer: saved })
      assert.equal(recovered.deliveryState, 'delivery-pending')
      assert.equal(fixture.mint.swaps, 1)
      assert.equal(
        total(await fixture.spendableAmounts()),
        before - 3_000 - fixture.mint.inputFeesMsat,
      )
      assert.equal(
        total(recovered.token!.proofs.map(({ amount }) => amountToNumber(amount))),
        3_000,
      )
    })
  })
}

function total(amounts: readonly number[]): number {
  return amounts.reduce((sum, amount) => sum + amount, 0)
}
