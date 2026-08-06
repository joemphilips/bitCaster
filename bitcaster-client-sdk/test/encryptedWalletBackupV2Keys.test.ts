import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { deriveDurableCustodyWalletId } from '../src/durableCustody.ts'
import {
  createEncryptedWalletBackupV2KeyHandle,
  deriveEncryptedWalletBackupV2AssetLocator,
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

  assert.deepEqual(first, second)
  assert.equal(first.formatVersion, ENCRYPTED_WALLET_BACKUP_V2_FORMAT_VERSION)
  assert.equal(first.walletId, 'd1f0754b1f442fe1f4ce12b9105d7cf8f69570085df964831ef79c728ecafe6c')
  assert.equal(
    first.requestAuthPublicKey,
    '8941fb08484ecf59ea6d3e331eb7a38736f80ddf5c27cd009b5326c9950baa94',
  )
  assert.equal(asset, 'd5856ca354c4d4af47116443462f2d1cb9aca458be1149815956a64ab6a6755c')
  assert.notEqual(first.walletId, first.requestAuthPublicKey)
})

test('v2 key hierarchy separates seed and realm', async () => {
  const baseline = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  const otherSeed = await createEncryptedWalletBackupV2KeyHandle({ seed: OTHER_SEED, realm: REALM })
  const otherRealm = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: 'backup.staging',
  })

  assert.notEqual(baseline.walletId, otherSeed.walletId)
  assert.notEqual(baseline.requestAuthPublicKey, otherSeed.requestAuthPublicKey)
  assert.equal(baseline.walletId, otherRealm.walletId)
  assert.notEqual(baseline.requestAuthPublicKey, otherRealm.requestAuthPublicKey)
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
  const otherRealmAsset = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: otherRealm,
    mintUrl: MINT_URL,
    unit: 'sat',
    assetIdentity: 'cashu:ordinary',
  })

  assert.notEqual(baselineAsset, otherSeedAsset)
  assert.notEqual(baselineAsset, otherRealmAsset)
})

test('v2 key handle uses the canonical wallet id across realms', async () => {
  const production = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  const staging = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: 'backup.staging',
  })
  const otherSeed = await createEncryptedWalletBackupV2KeyHandle({ seed: OTHER_SEED, realm: REALM })

  assert.equal(production.walletId, deriveDurableCustodyWalletId(SEED))
  assert.equal(staging.walletId, deriveDurableCustodyWalletId(SEED))
  assert.equal(production.walletId, staging.walletId)
  assert.notEqual(production.walletId, otherSeed.walletId)
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

  assert.match(asset, /^[0-9a-f]{64}$/)
  assert.notEqual(asset, changedUnit)
  assert.notEqual(asset, changedAsset)
  assert.equal(asset.includes('mint.example'), false)
  assert.equal(asset.includes('cashu:ordinary'), false)
})

test('v2 hierarchy rejects forged handles, wrong seed length, and invalid realms', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed: SEED, realm: REALM })
  const forged = { ...keyHandle }
  const cloned = structuredClone(keyHandle)

  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2AssetLocator({
        keyHandle: forged,
        mintUrl: MINT_URL,
        unit: 'sat',
        assetIdentity: 'asset',
      }),
    /key handle is invalid/,
  )
  await assert.rejects(
    () =>
      deriveEncryptedWalletBackupV2AssetLocator({
        keyHandle: cloned,
        mintUrl: MINT_URL,
        unit: 'sat',
        assetIdentity: 'asset',
      }),
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
