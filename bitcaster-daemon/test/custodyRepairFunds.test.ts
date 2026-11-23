import { getEncodedToken } from '@cashu/cashu-ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DaemonDurableWalletReceiveCoordinator } from '../src/durableWalletReceiveCoordinator.ts'
import { dispatch } from '../src/server.ts'
import { addAvailableProofs, CustodyRepairRequiredError } from '../src/state.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import { readDaemonWalletBalance } from '../src/walletBalance.ts'
import {
  prepareRegularWalletReceive,
  recoverDurableOutgoingCashuTransfers,
} from '../src/walletOps.ts'
import { serviceFixture, MINT, SEED } from './nativePaymentRequestServiceFixture.ts'

const SATS = { kind: 'sats', baseAsset: 'sat', unit: 'msat' } as const

/**
 * Custody holds 64 msat from a receive. A released split left 24 msat of change
 * only in the wallet table, without a custody row.
 */
async function fundedWithReleasedChange() {
  const f = await serviceFixture({ defaultWallet: true, largeDenominations: true })
  try {
    const prepared = await prepareRegularWalletReceive({
      encodedToken: getEncodedToken({
        mint: MINT,
        unit: 'msat',
        proofs: [f.mintProof(64, 'custody-funding')],
      }),
      mintUrl: MINT,
      unit: 'msat',
      secrets: { walletSeedHex: SEED },
      deps: f.deps,
    })
    await new DaemonDurableWalletReceiveCoordinator(
      f.directory,
      () => f.fence,
      f.deps.restoreOutputGroups!,
    ).execute(prepared)
    await addAvailableProofs(
      MINT,
      [f.mintProof(16, 'released-change-16'), f.mintProof(8, 'released-change-8')],
      SATS,
    )
    return {
      ...f,
      send: (amountMsat: number, operationId: string) =>
        dispatch({ method: 'wallet.send', params: { amountMsat, operationId } }, f.deps),
      walletSendOperations: () =>
        withDaemonStateSqliteTransaction(f.directory, (database) =>
          database
            .prepare(`SELECT state FROM target_proof_operations WHERE kind = 'wallet-send'`)
            .all()
            .map((row) => String(row.state)),
        ),
      releasedChangeRows: () =>
        withDaemonStateSqliteTransaction(f.directory, (database) =>
          database
            .prepare(
              `SELECT state, amount FROM target_wallet_proofs
               WHERE secret IN ('released-change-16', 'released-change-8') ORDER BY amount`,
            )
            .all()
            .map((row) => `${row.state}:${row.amount}`),
        ),
    }
  } catch (error) {
    await f.close()
    throw error
  }
}

test('a send spends only custody proofs and leaves released change untouched', async () => {
  const f = await fundedWithReleasedChange()
  try {
    const swaps = f.counts.swaps
    const sent = await f.send(20, 'custody-only-send')
    assert.equal(sent.ok, true, 'a send that custody can pay must complete')
    assert.equal(f.counts.swaps, swaps + 1)
    assert.deepEqual(await f.walletSendOperations(), ['completed'])
    assert.deepEqual(await f.releasedChangeRows(), ['available:8', 'available:16'])
    const recovery = await recoverDurableOutgoingCashuTransfers({ walletSeedHex: SEED }, f.deps)
    assert.deepEqual(recovery.pending, [])
    assert.equal(recovery.hasBlockingPending, false)
  } finally {
    await f.close()
  }
})

test('a send that only released change could complete refuses before the mint', async () => {
  const f = await fundedWithReleasedChange()
  try {
    const swaps = f.counts.swaps
    const refused = await f.send(80, 'needs-released-change')
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'custody-repair-required')
    // No recovery adds a wallet-only proof to custody, so the text gives no recovery advice.
    assert.equal(
      refused.error,
      'custody does not record some available funds; this command cannot spend them',
    )
    assert.equal(f.counts.swaps, swaps)
    assert.deepEqual(await f.walletSendOperations(), [])
    assert.deepEqual(await f.releasedChangeRows(), ['available:8', 'available:16'])
  } finally {
    await f.close()
  }
})

test('a send above every available proof keeps the ordinary refusal', async () => {
  const f = await fundedWithReleasedChange()
  try {
    const swaps = f.counts.swaps
    await assert.rejects(
      f.send(200, 'above-all-funds'),
      (error: unknown) => error instanceof Error && !(error instanceof CustodyRepairRequiredError),
    )
    assert.equal(f.counts.swaps, swaps)
    assert.deepEqual(await f.walletSendOperations(), [])
  } finally {
    await f.close()
  }
})

test('the balance still counts released change outside custody', async () => {
  const f = await fundedWithReleasedChange()
  try {
    const balance = await readDaemonWalletBalance(f.directory)
    assert.equal(balance.byMint[0]?.availableSats, (64 + 24) / 1_000)
  } finally {
    await f.close()
  }
})
