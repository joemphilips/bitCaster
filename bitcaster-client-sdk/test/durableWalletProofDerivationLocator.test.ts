import assert from 'node:assert/strict'
import test from 'node:test'
import { Amount, OutputData, createCtfRangeManifest, deriveKeysetId } from '@cashu/cashu-ts'
import {
  decodeDurableWalletProofDerivationLocator,
  deriveDurableWalletProofSecret,
  durableWalletProofDerivationLocatorsEqual,
  serializeDurableWalletProofDerivationLocator,
} from '../src/durableWalletProofDerivationLocator.ts'

const SEED = new Uint8Array(64).fill(7)
const PUBLIC_KEY = '02194603ffa36356f4a56b7df9371fc3192472351453ec7398b8da8117e7c3e104'
const KEYS = { '1': PUBLIC_KEY, '2': PUBLIC_KEY, '4': PUBLIC_KEY }
const KEYSET = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1 })

test('decodes only exact canonical derivation locators', () => {
  const locator = decodeDurableWalletProofDerivationLocator({
    schemaVersion: 1,
    kind: 'nut13',
    keysetId: KEYSET,
    counter: 7,
  })
  assert.deepEqual(serializeDurableWalletProofDerivationLocator(locator), locator)
  assert.equal(durableWalletProofDerivationLocatorsEqual(locator, { ...locator }), true)
  assert.throws(
    () => decodeDurableWalletProofDerivationLocator({ ...locator, unknown: true }),
    /foreign or missing/,
  )
  assert.throws(
    () => decodeDurableWalletProofDerivationLocator({ ...locator, keysetId: KEYSET.toUpperCase() }),
    /keyset id/,
  )
  assert.throws(
    () => decodeDurableWalletProofDerivationLocator({ ...locator, counter: -1 }),
    /counter/,
  )
  assert.throws(
    () => decodeDurableWalletProofDerivationLocator({ ...locator, counter: 2_147_483_648 }),
    /NUT-13 counter/,
  )
  assert.throws(
    () =>
      decodeDurableWalletProofDerivationLocator({
        schemaVersion: 1,
        kind: 'ctf-range-manifest',
        rangeOperationId: 'range-operation-1',
        manifestIndex: 256,
      }),
    /range manifest index/,
  )
})

test('derives NUT-13 and range-manifest proof secrets without arbitrary domains', () => {
  const nut13 = decodeDurableWalletProofDerivationLocator({
    schemaVersion: 1,
    kind: 'nut13',
    keysetId: KEYSET,
    counter: 3,
  })
  const expectedNut13 = OutputData.createSingleDeterministicData(2, SEED, 3, KEYSET)
  assert.equal(
    deriveDurableWalletProofSecret({
      seed: SEED,
      locator: nut13,
      proofKeysetId: KEYSET,
      proofAmount: 2,
    }),
    new TextDecoder().decode(expectedNut13.secret),
  )
  assert.throws(
    () =>
      deriveDurableWalletProofSecret({
        seed: SEED,
        locator: nut13,
        proofKeysetId: '00deadbeef123456',
        proofAmount: 2,
      }),
    /keyset is foreign/,
  )

  const manifest = createCtfRangeManifest({
    seed: SEED,
    operationId: 'range-operation-1',
    receiveKeyset: { id: KEYSET, active: true, keys: KEYS },
    offerKeyset: { id: '00deadbeef123456', active: true, keys: KEYS },
    maxReceive: 3,
    maxChange: 3,
    maxEntries: 4,
  })
  const entry = manifest.entries[1]!
  const manifestSecret = deriveDurableWalletProofSecret({
    seed: SEED,
    locator: {
      schemaVersion: 1,
      kind: 'ctf-range-manifest',
      rangeOperationId: 'range-operation-1',
      manifestIndex: 1,
    },
    proofKeysetId: entry.entry.id,
    proofAmount: Amount.from(entry.entry.amount),
  })
  assert.equal(manifestSecret, new TextDecoder().decode(entry.outputData.secret))
})
