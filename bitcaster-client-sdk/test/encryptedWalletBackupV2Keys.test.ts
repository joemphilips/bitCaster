import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import {
  createEncryptedWalletBackupV2KeyHandle,
  deriveEncryptedWalletBackupV2AssetLocator,
  deriveEncryptedWalletBackupV2OperationLocator,
  ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION,
  type EncryptedWalletBackupV2Runtime,
} from '../src/encryptedWalletBackupV2Keys.ts'

const SEED = Uint8Array.from({ length: 64 }, (_value, index) => index)
const OTHER_SEED = Uint8Array.from({ length: 64 }, (_value, index) => 255 - index)
const REALM = 'backup.production'
const MINT_URL = 'https://mint.example/cashu'

test('v2 key hierarchy has stable golden outputs and separates roots', async () => {
  const first = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  const second = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  const asset = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: first,
    mintUrl: MINT_URL,
    unit: 'sat',
    assetIdentity: 'cashu:ordinary',
  })
  const operation = await deriveEncryptedWalletBackupV2OperationLocator({
    keyHandle: first,
    operationId: 'deposit:01',
  })

  assert.deepEqual(first, second)
  assert.equal(first.formatVersion, ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION)
  assert.equal(first.vaultId, '5ed0beee7d22da58de93adb7ca2fd724849a052f2a9595577eb3fefc3bb48e4e')
  assert.equal(
    first.requestAuthPublicKey,
    '8941fb08484ecf59ea6d3e331eb7a38736f80ddf5c27cd009b5326c9950baa94',
  )
  assert.equal(
    first.portfolioReportingPublicKey,
    '6c9ebf3cb343a7ee9efc1f13fc10f0c0416ab97d3be76d0dbaeed75dc6a4575a',
  )
  assert.equal(asset, 'd5856ca354c4d4af47116443462f2d1cb9aca458be1149815956a64ab6a6755c')
  assert.equal(operation, 'df4c0267aff6a0493ebcae589ecd4262308df5e5872a3ca01014410238e45f6e')
  assert.notEqual(first.vaultId, first.requestAuthPublicKey)
  assert.notEqual(first.vaultId, first.portfolioReportingPublicKey)
  assert.notEqual(first.requestAuthPublicKey, first.portfolioReportingPublicKey)
  assert.notEqual(asset, operation)
})

test('v2 key hierarchy separates seed and realm', async () => {
  const baseline = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  const otherSeed = await createEncryptedWalletBackupV2KeyHandle({ seed: OTHER_SEED, realm: REALM })
  const otherRealm = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: 'backup.staging',
  })

  assert.notEqual(baseline.vaultId, otherSeed.vaultId)
  assert.notEqual(baseline.requestAuthPublicKey, otherSeed.requestAuthPublicKey)
  assert.notEqual(baseline.portfolioReportingPublicKey, otherSeed.portfolioReportingPublicKey)
  assert.notEqual(baseline.vaultId, otherRealm.vaultId)
  assert.notEqual(baseline.requestAuthPublicKey, otherRealm.requestAuthPublicKey)
  assert.notEqual(baseline.portfolioReportingPublicKey, otherRealm.portfolioReportingPublicKey)
  const baselineAsset = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: baseline,
    mintUrl: MINT_URL,
    unit: 'sat',
    assetIdentity: 'cashu:ordinary',
  })
  const otherSeedAsset = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: otherSeed,
    mintUrl: MINT_URL,
    unit: 'sat',
    assetIdentity: 'cashu:ordinary',
  })
  const otherRealmOperation = await deriveEncryptedWalletBackupV2OperationLocator({
    keyHandle: otherRealm,
    operationId: 'deposit:01',
  })
  const baselineOperation = await deriveEncryptedWalletBackupV2OperationLocator({
    keyHandle: baseline,
    operationId: 'deposit:01',
  })

  assert.notEqual(baselineAsset, otherSeedAsset)
  assert.notEqual(baselineOperation, otherRealmOperation)
})

test('v2 locators are opaque and bind their exact input tuple', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  const asset = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle,
    mintUrl: MINT_URL,
    unit: 'sat',
    assetIdentity: 'cashu:ordinary',
  })
  const changedUnit = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle,
    mintUrl: MINT_URL,
    unit: 'msat',
    assetIdentity: 'cashu:ordinary',
  })
  const changedAsset = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle,
    mintUrl: MINT_URL,
    unit: 'sat',
    assetIdentity: 'cashu:conditional',
  })
  const operation = await deriveEncryptedWalletBackupV2OperationLocator({
    keyHandle,
    operationId: 'cashu:ordinary',
  })

  assert.match(asset, /^[0-9a-f]{64}$/)
  assert.match(operation, /^[0-9a-f]{64}$/)
  assert.notEqual(asset, changedUnit)
  assert.notEqual(asset, changedAsset)
  assert.notEqual(asset, operation)
  assert.equal(asset.includes('mint.example'), false)
  assert.equal(asset.includes('cashu:ordinary'), false)
  assert.equal(operation.includes('cashu:ordinary'), false)
})

test('v2 hierarchy rejects forged handles, wrong seed length, and invalid realms', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  const forged = { ...keyHandle }
  const cloned = structuredClone(keyHandle)

  await assert.rejects(
    () => deriveEncryptedWalletBackupV2OperationLocator({ keyHandle: forged, operationId: 'op' }),
    /key handle is invalid/,
  )
  await assert.rejects(
    () => deriveEncryptedWalletBackupV2OperationLocator({ keyHandle: cloned, operationId: 'op' }),
    /key handle is invalid/,
  )
  await assert.rejects(
    () => createEncryptedWalletBackupV2KeyHandle({ seed: new Uint8Array(63), realm: REALM }),
    /seed is invalid/,
  )
  for (const realm of ['', ' realm', 'realm ', 'realm/', 'x'.repeat(65)]) {
    await assert.rejects(
      () => createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm }),
      /realm is invalid/,
    )
  }
})

test('v2 locators canonicalize mint identity aliases and allow local HTTP identities', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  const canonical = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle,
    mintUrl: 'https://mint.example/path',
    unit: 'sat',
    assetIdentity: 'cashu:ordinary',
  })
  const alias = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle,
    mintUrl: 'HTTPS://MINT.EXAMPLE./path///',
    unit: 'sat',
    assetIdentity: 'cashu:ordinary',
  })
  const local = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle,
    mintUrl: 'http://mint-bitcaster-production/',
    unit: 'sat',
    assetIdentity: 'cashu:ordinary',
  })

  assert.equal(alias, canonical)
  assert.match(local, /^[0-9a-f]{64}$/)
})

test('v2 locators reject invalid mint identities', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  for (const mintUrl of [
    'https://user:password@mint.example',
    'https://mint.example/path?query=1',
    'https://mint.example/path#fragment',
    'file:///tmp/mint',
  ]) {
    await assert.rejects(
      () =>
        deriveEncryptedWalletBackupV2AssetLocator({
          keyHandle,
          mintUrl,
          unit: 'sat',
          assetIdentity: 'cashu:ordinary',
        }),
      /mint URL is invalid/,
    )
  }
})

test('v2 locators reject empty identifiers', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2AssetLocator({
        keyHandle,
        mintUrl: MINT_URL,
        unit: '',
        assetIdentity: 'asset',
      }),
    /unit is invalid/,
  )
  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2AssetLocator({
        keyHandle,
        mintUrl: MINT_URL,
        unit: 'sat',
        assetIdentity: '',
      }),
    /asset identity is invalid/,
  )
  await assert.rejects(
    () => deriveEncryptedWalletBackupV2OperationLocator({ keyHandle, operationId: '' }),
    /operation id is invalid/,
  )
})

test('v2 locators enforce ASCII identifier byte boundaries', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  await assert.doesNotReject(
    deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle,
      mintUrl: MINT_URL,
      unit: 'u'.repeat(64),
      assetIdentity: 'a'.repeat(256),
    }),
  )
  await assert.doesNotReject(
    deriveEncryptedWalletBackupV2OperationLocator({ keyHandle, operationId: 'o'.repeat(256) }),
  )
  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2AssetLocator({
        keyHandle,
        mintUrl: MINT_URL,
        unit: 'u'.repeat(65),
        assetIdentity: 'asset',
      }),
    /unit is invalid/,
  )
  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2AssetLocator({
        keyHandle,
        mintUrl: MINT_URL,
        unit: 'sat',
        assetIdentity: 'a'.repeat(257),
      }),
    /asset identity is invalid/,
  )
  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2OperationLocator({ keyHandle, operationId: 'o'.repeat(257) }),
    /operation id is invalid/,
  )
})

test('v2 locators use UTF-8 byte boundaries for multibyte identifiers', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  await assert.doesNotReject(
    deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle,
      mintUrl: MINT_URL,
      unit: 'é'.repeat(32),
      assetIdentity: 'é'.repeat(128),
    }),
  )
  await assert.doesNotReject(
    deriveEncryptedWalletBackupV2OperationLocator({ keyHandle, operationId: 'é'.repeat(128) }),
  )
  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2AssetLocator({
        keyHandle,
        mintUrl: MINT_URL,
        unit: 'é'.repeat(33),
        assetIdentity: 'asset',
      }),
    /unit is invalid/,
  )
  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2AssetLocator({
        keyHandle,
        mintUrl: MINT_URL,
        unit: 'sat',
        assetIdentity: 'é'.repeat(129),
      }),
    /asset identity is invalid/,
  )
  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2OperationLocator({ keyHandle, operationId: 'é'.repeat(129) }),
    /operation id is invalid/,
  )
})

test('v2 hierarchy rejects malformed runtime results', async () => {
  const malformedRuntime = {
    subtle: {
      importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
      deriveBits: async () => new ArrayBuffer(31),
    },
  } as unknown as EncryptedWalletBackupV2Runtime
  await assert.rejects(
    () =>
      createEncryptedWalletBackupV2KeyHandle({
        seed: SEED,
        realm: REALM,
        runtime: malformedRuntime,
      }),
    /runtime returned invalid HKDF output/,
  )
})

test('v2 hierarchy uses the injected WebCrypto runtime', async () => {
  let imports = 0
  let derives = 0
  const runtime: EncryptedWalletBackupV2Runtime = {
    subtle: {
      importKey: async (...args) => {
        imports += 1
        return webcrypto.subtle.importKey(...args)
      },
      deriveBits: async (...args) => {
        derives += 1
        return webcrypto.subtle.deriveBits(...args)
      },
    } as SubtleCrypto,
  }
  await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM, runtime })
  assert.equal(imports > 0, true)
  assert.equal(derives > 0, true)
})
