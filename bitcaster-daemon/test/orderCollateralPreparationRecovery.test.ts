import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { MintKeys, Proof } from '@cashu/cashu-ts'
import {
  DaemonOrderCollateralCoordinator,
  durableOrderCollateralPinId,
  installDaemonOrderCollateralCoordinator,
} from '../src/durableOrderCollateralCoordinator.ts'
import {
  daemonWalletCustodyScope,
  DaemonDurableCustodyLease,
} from '../src/durableCustodyLifecycle.ts'
import { SqliteDurableCustodyStore } from '../src/durableCustodySqliteStore.ts'
import {
  DaemonProofOperationCoordinator,
} from '../src/durableProofOperationCoordinator.ts'
import {
  addAvailableSatProofs,
  emptyDaemonState,
  getProofOperation,
  installDaemonProofOperationCoordinator,
  readState,
  writeState,
} from '../src/state.ts'
import {
  recoverPreparingOrderCollateralPins,
  type OrderCollateralPreparationRecoveryDependencies,
} from '../src/server.ts'

const WALLET_SEED = '91'.repeat(32)
const INPUT_KEYSET_ID = `00${'82'.repeat(7)}`
const KEEP_KEYSET_ID = `00${'83'.repeat(7)}`
const LOCK_KEYSET_ID = `00${'84'.repeat(7)}`
const PUBLIC_KEY = `02${'73'.repeat(32)}`

test('preflight restart reuses the exact reconciled split before advancing its pin', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-preflight-restart-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  let lease: DaemonDurableCustodyLease | undefined
  let uninstallProofCoordinator: (() => void) | undefined
  let uninstallOrderCoordinator: (() => void) | undefined
  try {
    const custodyStore = new SqliteDurableCustodyStore()
    await custodyStore.registerScope(daemonWalletCustodyScope(WALLET_SEED))
    await writeState(emptyDaemonState())
    const [inputProof] = await addAvailableSatProofs(
      'https://mint.example',
      [{
        id: INPUT_KEYSET_ID,
        amount: 100,
        secret: 'preflight-input',
        C: PUBLIC_KEY,
      }],
    )
    assert.ok(inputProof)

    const installCoordinators = async () => {
      lease = await DaemonDurableCustodyLease.claim({
        store: custodyStore,
        walletSeedHex: WALLET_SEED,
      })
      uninstallProofCoordinator = installDaemonProofOperationCoordinator(
        new DaemonProofOperationCoordinator({
          authority: lease,
          resolveMintKeys: async (_mintUrl, keysetIds) => new Map(
            keysetIds.map((keysetId) => [keysetId, mintKeys(keysetId)]),
          ),
        }),
      )
      const orderCoordinator = new DaemonOrderCollateralCoordinator(lease)
      uninstallOrderCoordinator = installDaemonOrderCollateralCoordinator(
        orderCoordinator,
      )
      return orderCoordinator
    }

    let orderCoordinator = await installCoordinators()
    const clientOrderId = 'client-preflight-restart'
    const pinId = durableOrderCollateralPinId(clientOrderId)
    const pin = await orderCoordinator.prepare({
      clientOrderId,
      marketId: 'condition-YES',
      mintUrl: 'https://mint.example',
      unit: 'sat',
      orderAmount: 100,
      requiredAmount: 100,
      submissionRequest: {
        clientOrderId,
        outcomeId: 'YES',
        tokenSide: 'Outcome',
        side: 'Buy',
        price: 50,
        amountSubunits: 100,
        timeInForce: 'GTC',
      },
      preflightSplit: {
        reservationId: pinId,
        conditionId: 'condition',
        keepOutcomeSetId: 'YES',
        lockOutcomeSetId: 'NO',
        amountSats: 100,
      },
      preparing: true,
      proofs: [inputProof],
    })

    const resultProofs = {
      YES: [proof(KEEP_KEYSET_ID, 'preflight-keep')],
      NO: [proof(LOCK_KEYSET_ID, 'preflight-lock')],
    }
    let prepareCount = 0
    let injectCrash = true
    const recoveryDependencies:
      OrderCollateralPreparationRecoveryDependencies = {
      async resolveOutputAmount() {
        return 100
      },
      async splitCollateral(input) {
        assert.deepEqual(
          input.candidateProofs?.map(({ secret }) => secret),
          ['preflight-input'],
        )
        return {
          inputs: input.candidateProofs as Proof[],
          spent: [],
          keep: [],
        }
      },
      async splitPreflight(params) {
        const existing = await params.proofOperationStore.getProofOperation(
          params.operationId,
        )
        if (existing === null) {
          prepareCount += 1
          assert.deepEqual(
            params.collateralProofs.map(({ secret }) => secret),
            ['preflight-input'],
          )
          await params.proofOperationStore.prepareProofOperation({
            operationId: params.operationId,
            kind: 'ctf-split',
            mintUrl: params.mintUrl,
            inputs: params.collateralProofs,
            outputs: {
              YES: [storedOutput(KEEP_KEYSET_ID, 'keep')],
              NO: [storedOutput(LOCK_KEYSET_ID, 'lock')],
            },
            metadata: { conditionId: params.conditionId },
          })
          await params.proofOperationStore.markProofOperationMintSubmitted(
            params.operationId,
          )
          await params.proofOperationStore.markProofOperationCompleted(
            params.operationId,
            resultProofs,
          )
          if (injectCrash) {
            injectCrash = false
            throw new Error('crash after exact split result commit')
          }
        } else {
          assert.equal(existing.state, 'completed')
          assert.deepEqual(existing.resultProofs, resultProofs)
        }
        return {
          resolvedLockOutcomeSetId: 'NO',
          resolvedKeepOutcomeSetId: 'YES',
          lockCollections: ['NO'],
          keepCollections: ['YES'],
          lockProofs: resultProofs.NO,
          keepProofs: resultProofs.YES,
          proofsByCollection: resultProofs,
          spentSatProofs: params.collateralProofs,
        }
      },
    }

    await assert.rejects(
      recoverPreparingOrderCollateralPins(
        { walletSeedHex: WALLET_SEED },
        recoveryDependencies,
      ),
      /crash after exact split result commit/,
    )
    assert.equal(prepareCount, 1)
    assert.equal(
      (await orderCoordinator.readPreparingPage({ limit: 10 })).pins[0]?.pinId,
      pin.pinId,
    )
    assert.equal(
      (await getProofOperation(`${pin.pinId}:ctf-split:0`))?.state,
      'completed',
    )

    uninstallOrderCoordinator()
    uninstallOrderCoordinator = undefined
    uninstallProofCoordinator()
    uninstallProofCoordinator = undefined
    await lease.stopAndRelease()
    lease = undefined
    orderCoordinator = await installCoordinators()

    assert.deepEqual(
      await recoverPreparingOrderCollateralPins(
        { walletSeedHex: WALLET_SEED },
        recoveryDependencies,
      ),
      { recoveredCount: 1 },
    )
    assert.equal(prepareCount, 1)
    assert.equal(
      (await orderCoordinator.readPreparingPage({ limit: 10 })).pins.length,
      0,
    )
    assert.equal(
      (await orderCoordinator.readPreparedPage({ limit: 10 })).pins[0]?.pinId,
      pin.pinId,
    )
    const wallet = (await readState()).wallet.proofs
    assert.deepEqual(
      wallet.map(({ proof: stored }) => stored.secret).sort(),
      ['preflight-keep', 'preflight-lock'],
    )
    assert.ok(wallet.every((stored) =>
      stored.state === 'reserved' && stored.reservedBy === pin.pinId))
  } finally {
    uninstallOrderCoordinator?.()
    uninstallProofCoordinator?.()
    await lease?.stopAndRelease()
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

function mintKeys(id: string): MintKeys {
  return {
    id,
    unit: 'sat',
    active: true,
    input_fee_ppk: 0,
    keys: { '100': PUBLIC_KEY },
  }
}

function proof(id: string, secret: string): Proof {
  return { id, amount: 100, secret, C: PUBLIC_KEY }
}

function storedOutput(id: string, label: string) {
  return {
    blindedMessage: { amount: 100, id, B_: `${label}-blinded` },
    blindingFactor: `${label}-blinding`,
    secret: `${label}-output-secret`,
  }
}
