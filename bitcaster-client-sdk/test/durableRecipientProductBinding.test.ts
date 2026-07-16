import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  marketFundingRecipientProductBinding,
  participationScoreRecipientProductBinding,
  requireDurableRecipientProductBinding,
} from '../src/durableRecipientProductBinding.ts'

test('durable recipient product bindings match the cross-language vectors', () => {
  assert.equal(
    participationScoreRecipientProductBinding(),
    '7e4cf133dc508b2d37cce1b6145f68f8cb27054148d43723e7215ebd6646fed6',
  )
  assert.equal(
    marketFundingRecipientProductBinding({
      divisibility: 10_000,
      fundAmm: false,
      creatorPubkey: null,
    }),
    'dac817dc2e5fb5943212286ad6556dfc91702015c2756957cc3f2aaf0d8dc050',
  )
  assert.equal(
    marketFundingRecipientProductBinding({
      divisibility: 10_000,
      fundAmm: true,
      creatorPubkey: 'ab'.repeat(32),
    }),
    '9aa8f778551043bb73b721b06fe14bb9b5d014b127714d8236a87584fa8eb632',
  )
})

test('market funding product binding rejects ambiguous adapter metadata', () => {
  assert.throws(() =>
    marketFundingRecipientProductBinding({
      divisibility: 1,
      fundAmm: false,
      creatorPubkey: null,
    }),
  )
  assert.throws(() =>
    marketFundingRecipientProductBinding({
      divisibility: 10_000,
      fundAmm: false,
      creatorPubkey: 'ab'.repeat(32),
    }),
  )
  assert.throws(() =>
    marketFundingRecipientProductBinding({
      divisibility: 10_000,
      fundAmm: true,
      creatorPubkey: 'AB'.repeat(32),
    }),
  )
})

test('persisted product bindings require canonical lowercase SHA-256 hex', () => {
  assert.equal(
    requireDurableRecipientProductBinding('ab'.repeat(32)),
    'ab'.repeat(32),
  )
  assert.throws(() => requireDurableRecipientProductBinding('AB'.repeat(32)))
  assert.throws(() => requireDurableRecipientProductBinding('ab'.repeat(31)))
})
