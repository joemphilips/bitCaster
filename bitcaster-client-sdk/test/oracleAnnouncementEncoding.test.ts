import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { announcementContentFromTlv } from '../src/oracleAnnouncementEncoding.ts'

// Public artifacts from the native/WASM oraclePublication fixture. No signing key is retained.
const REAL_ANNOUNCEMENT_TLV_HEX =
  'fdd824b127bb6f385afbef8d72af2a01ec50392df5d018ecb97244b3c04bb238fe3e050844767221012e8fe49eab82ebb3548d3ab6ed791a5cf044e09e508cb08fe749414f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd8224d00011d86bc78a6d350059044168a50be4c3bda71b7a86d015a9ce253a2f419f445b477359400fdd80609000203594553024e4f1962726f777365722d6f7261636c652d72656772657373696f6e'
const REAL_SIGNED_88_CONTENT =
  'J7tvOFr7741yryoB7FA5LfXQGOy5ckSzwEuyOP4+BQhEdnIhAS6P5J6rguuzVI06tu15GlzwROCeUIywj+dJQU81W9y3zAr3KO88zrlhXZBoS7Wyyl+FmrDwtwQHWHGq/dgiTQABHYa8eKbTUAWQRBaKUL5MO9pxt6htAVqc4lOi9Bn0RbR3NZQA/dgGCQACA1lFUwJOTxlicm93c2VyLW9yYWNsZS1yZWdyZXNzaW9u'

test('maps the real native/WASM announcement to the exact signed kind-88 body', () => {
  assert.equal(announcementContentFromTlv(REAL_ANNOUNCEMENT_TLV_HEX), REAL_SIGNED_88_CONTENT)
})

test('runs in a browser-like global without Buffer', () => {
  const source = readFileSync(
    new URL('../src/oracleAnnouncementEncoding.ts', import.meta.url),
    'utf8',
  )
  const compiled = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  })
  const context = {
    exports: {} as { announcementContentFromTlv: typeof announcementContentFromTlv },
    btoa,
  }
  runInNewContext(compiled.outputText, context)
  assert.equal(
    context.exports.announcementContentFromTlv(REAL_ANNOUNCEMENT_TLV_HEX),
    REAL_SIGNED_88_CONTENT,
  )
})

test('preserves binary bytes and canonical one-byte lengths', () => {
  assert.equal(announcementContentFromTlv('fdd8240300ff80'), 'AP+A')
  assert.equal(announcementContentFromTlv('fdd82400'), '')
  assert.equal(announcementContentFromTlv(`fdd824fc${'00'.repeat(252)}`)?.length, 336)
})

test('accepts canonical fd length at the 253-byte boundary', () => {
  const expected = btoa('\xff'.repeat(253))
  assert.equal(announcementContentFromTlv(`fdd824fd00fd${'ff'.repeat(253)}`), expected)
})

test('accepts the exact 48-KiB hex-text bound', () => {
  const bodyLength = 24 * 1024 - 6
  const hex = `fdd824fd${bodyLength.toString(16).padStart(4, '0')}${'ab'.repeat(bodyLength)}`
  assert.equal(hex.length, 48 * 1024)
  assert.ok(
    announcementContentFromTlv(hex) === btoa('\xab'.repeat(bodyLength)),
    'bounded body mismatch',
  )
  assert.equal(announcementContentFromTlv(`${hex}00`), undefined)
})

const INVALID_CASES: ReadonlyArray<readonly [string, string]> = [
  ['empty', ''],
  ['odd hex length', 'fdd8240'],
  ['invalid hex', 'fdd82401gg'],
  ['uppercase hex', 'FDD82400'],
  ['hex whitespace', 'fdd82400 '],
  ['wrong type', 'fdd82300'],
  ['noncanonical fe type', 'fe0000d82400'],
  ['noncanonical ff type', 'ff000000000000d82400'],
  ['truncated type', 'fdd8'],
  ['missing length', 'fdd824'],
  ['truncated fd length', 'fdd824fd00'],
  ['truncated fe length', 'fdd824fe000001'],
  ['truncated ff length', 'fdd824ff00000001000000'],
  ['noncanonical fd length', 'fdd824fd000100'],
  ['noncanonical fe length', 'fdd824fe0000000100'],
  ['noncanonical ff length', 'fdd824ff0000000000010000'],
  ['oversized canonical fe length', 'fdd824fe00010000'],
  ['oversized canonical ff length', 'fdd824ff0000000100000000'],
  ['unsafe integer length', 'fdd824ff0020000000000000'],
  ['uint64 maximum length', 'fdd824ffffffffffffffffff'],
  ['truncated body', REAL_ANNOUNCEMENT_TLV_HEX.slice(0, -2)],
  ['trailing byte', `${REAL_ANNOUNCEMENT_TLV_HEX}00`],
]

for (const [name, hex] of INVALID_CASES) {
  test(`rejects ${name}`, () => {
    assert.equal(announcementContentFromTlv(hex), undefined)
  })
}
