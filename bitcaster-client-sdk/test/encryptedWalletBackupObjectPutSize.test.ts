import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeCanonicalBackupCbor } from '../src/encryptedWalletBackupCbor.ts'
import { measureEncryptedWalletBackupObjectPutPayload } from '../src/encryptedWalletBackupObjectPutSize.ts'

test('object PUT measurement equals canonical encoding at both object bounds', () => {
  for (const fixture of [
    { kindCode: 1 as const, paddedLength: 262_144 as const, bodyByteLength: 262_172 },
    { kindCode: 2 as const, paddedLength: 65_536 as const, bodyByteLength: 65_564 },
  ]) {
    const realm = 'r'.repeat(64)
    const generation = Number.MAX_SAFE_INTEGER
    const actual = encodeCanonicalBackupCbor([
      1,
      'object-put',
      new Uint8Array(32),
      fixture.kindCode,
      realm,
      new Uint8Array(32),
      new Uint8Array(16),
      generation,
      fixture.paddedLength,
      new Uint8Array(32),
      new Uint8Array(4_096),
      new Uint8Array(fixture.bodyByteLength),
    ]).byteLength
    assert.equal(
      measureEncryptedWalletBackupObjectPutPayload({
        ...fixture,
        realm,
        generation,
        aadByteLength: 4_096,
      }),
      actual,
    )
  }
})
