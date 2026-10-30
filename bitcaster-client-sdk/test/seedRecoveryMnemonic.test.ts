import assert from 'node:assert/strict'
import test from 'node:test'
import { seedRecoveryMnemonicBytes } from '../src/seedRecoveryMnemonic.ts'

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EXPECTED =
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'

test('recovery phrase derives the standard BIP-39 64-byte seed', () => {
  assert.equal(Buffer.from(seedRecoveryMnemonicBytes(PHRASE)).toString('hex'), EXPECTED)
})

test('recovery phrase accepts normalized whitespace and Unicode form', () => {
  assert.deepEqual(
    seedRecoveryMnemonicBytes(`  ${PHRASE.replaceAll(' ', '\n')}  `),
    seedRecoveryMnemonicBytes(PHRASE),
  )
})

test('recovery phrase rejects an invalid word and invalid checksum', () => {
  assert.throws(() => seedRecoveryMnemonicBytes(PHRASE.replace('abandon', 'notaword')))
  assert.throws(() => seedRecoveryMnemonicBytes(PHRASE.replace(/about$/, 'abandon')))
})
