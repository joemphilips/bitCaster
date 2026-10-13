import test from 'node:test'
import assert from 'node:assert/strict'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import {
  verifyCtfEnumAnnouncement,
  verifyCtfConditionRegistration,
  encodeMintOutcomeCollection,
  decodeMintOutcomeCollection,
} from '../src/ctfConditionRegistration.ts'
import { canonicalizeOutcomeSet } from '../src/outcomeSets.ts'
// Literal vectors from pinned CDK nut_ctf/dlc.rs browser-WASM and CLI verification tests.
const vectors = [
  'fdd824b0d6e582137fef6dd61d2047b4700104c0e97be005af979e100d8a007cf45d28f562f01d6817fc8f7d6b343d2cb5a6f0c2da87090da93508e26f671e30d50a6d577e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4efdd8224c0001ab5cbc99b45a936368081a43a7f14c9be0a821ba5beba722c27d61cef31a78d96a27e00dfdd80609000203594553024e4f18646961672d6576656e742d31373830393131373537303935',
  'fdd824b2257ec5d354c438e7bc7e29693b9ab755e5dcba65bb4c618664876a1b1b670f1d03201c9f5f215f75a524461f58545e382ccf529c1c6e99072321831253c46cff4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aafdd8224e0001466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276b49d200fdd80609000203594553024e4f1a6269746361737465722d72656772657373696f6e2d6576656e74',
]
const text = new TextEncoder()
function tagged(tag: string, value: Uint8Array) {
  const h = sha256(text.encode(tag))
  return sha256(concatBytes(h, h, value))
}
function conditionId(raw: string) {
  const a = verifyCtfEnumAnnouncement(raw)
  return bytesToHex(
    tagged(
      'Cashu_condition_id',
      concatBytes(
        hexToBytes(a.oraclePublicKey),
        text.encode(a.eventId),
        Uint8Array.of(a.orderedOutcomes.length),
      ),
    ),
  )
}
function registration(raw = vectors[0]) {
  return { condition_id: conditionId(raw), threshold: 1, collateral: 'msat', announcements: [raw] }
}
function verify(raw = registration()) {
  return verifyCtfConditionRegistration({
    condition: raw,
    mintUrl: 'https://mint.example',
    conditionId: raw.condition_id,
    allowInsecureLoopbackHttp: false,
  })
}
for (const [index, vector] of vectors.entries())
  test(`pinned CDK announcement vector ${index}`, () => {
    const a = verifyCtfEnumAnnouncement(vector)
    assert.deepEqual(a.orderedOutcomes, ['YES', 'NO'])
    assert.equal(a.eventId, index === 0 ? 'diag-event-1780911757095' : 'bitcaster-regression-event')
    assert.equal(verify(registration(vector)).outcomes.join('|'), 'YES|NO')
    assert.equal(
      conditionId(vector),
      [
        'f4e459719005c676f80b61829a1f3db64f917044a5dfb44d030e21e711284d31',
        '43e0ffd6ee2efb4b5b7e0ff9d5d666cfe266b632d2a3bdc8c908ac5d8b6210d1',
      ][index],
    )
  })
test('wire mapping preserves announcement order and internal identity stays lexical', () => {
  const universe = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']
  const members = ['Zeta', 'Delta', 'Beta', 'Gamma', 'Epsilon']
  const wire = encodeMintOutcomeCollection(universe, members)
  assert.equal(wire, 'Beta|Gamma|Delta|Epsilon|Zeta')
  assert.equal(canonicalizeOutcomeSet(members), 'Beta|Delta|Epsilon|Gamma|Zeta')
  assert.deepEqual(decodeMintOutcomeCollection(universe, wire), universe.slice(1))
  assert.throws(() => decodeMintOutcomeCollection(universe, 'Beta|Delta|Epsilon|Gamma|Zeta'))
  assert.equal(encodeMintOutcomeCollection(['z', 'A', 'a'], ['a', 'z']), 'z|a')
  for (const invalid of [[], ['Alpha', 'Alpha'], universe, ['unknown']])
    assert.throws(() => encodeMintOutcomeCollection(universe, invalid))
})
test('strict TLV and signatures reject corruption, suffix, oversized data and wrong descriptor', () => {
  const bytes = hexToBytes(vectors[0])
  bytes[5] ^= 1
  for (const raw of [
    bytesToHex(bytes),
    vectors[0] + '00',
    vectors[0].slice(0, -2),
    '00'.repeat(65537),
    vectors[0].replace('fdd806', 'fdd808'),
  ])
    assert.throws(() => verifyCtfEnumAnnouncement(raw))
})
test('registration refuses malformed or foreign facts and expected authority changes', () => {
  const base = registration()
  for (const patch of [
    { threshold: 0 },
    { threshold: 2 },
    { collateral: 'sat' },
    { condition_type: 'numeric' },
    { parent_collection_id: '11'.repeat(32) },
    { parent_collection_id: '' },
    { announcements: [vectors[0], '00'] },
    { announcements: [vectors[0], vectors[0]] },
    { announcements: [vectors[0], vectors[1]] },
  ])
    assert.throws(() => verify({ ...base, ...patch }))
  assert.throws(() => verify({ ...base, condition_id: 'aa'.repeat(32) }))
  const expected = verify()
  assert.throws(() =>
    verifyCtfConditionRegistration({
      condition: base,
      mintUrl: 'https://foreign.example',
      conditionId: base.condition_id,
      allowInsecureLoopbackHttp: false,
      expected,
    }),
  )
  assert.throws(() =>
    verifyCtfConditionRegistration({
      condition: base,
      mintUrl: 'https://mint.example',
      conditionId: base.condition_id,
      allowInsecureLoopbackHttp: false,
      expected: {
        ...expected,
        oracles: expected.oracles.map((o) => ({ ...o, announcementIdentity: '00'.repeat(32) })),
      },
    }),
  )
})
// Public-only test signer: no production key or private creator DTO.
function signed(outcomes: string[], eventId = 'unsorted-case', secret = 3) {
  const bs = (n: number) => (n < 253 ? Uint8Array.of(n) : Uint8Array.of(253, n >>> 8, n & 255))
  const str = (s: string) => concatBytes(bs(text.encode(s).length), text.encode(s))
  const tlv = (t: number, b: Uint8Array) => concatBytes(bs(t), bs(b.length), b)
  const sk = new Uint8Array(32)
  sk[31] = secret
  const descriptor = concatBytes(Uint8Array.of(0, outcomes.length), ...outcomes.map(str))
  const event = tlv(
    55330,
    concatBytes(
      Uint8Array.of(0, 1),
      schnorr.getPublicKey(sk),
      Uint8Array.of(0, 0, 0, 1),
      tlv(55302, descriptor),
      str(eventId),
    ),
  )
  return bytesToHex(
    tlv(
      55332,
      concatBytes(
        schnorr.sign(tagged('DLC/oracle/announcement/v0', event), sk, new Uint8Array(32)),
        schnorr.getPublicKey(sk),
        event,
      ),
    ),
  )
}
test('signed unsorted six-outcome descriptor retains exact order', () => {
  const outcomes = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']
  assert.deepEqual(verify(registration(signed(outcomes))).outcomes, outcomes)
  const a = signed(['z', 'A', 'a'])
  assert.deepEqual(verify(registration(a)).outcomes, ['z', 'A', 'a'])
  const first = signed(outcomes, 'same', 3),
    second = signed([...outcomes].sort(), 'same', 4)
  assert.throws(
    () => verify({ ...registration(first), announcements: [first, second] }),
    /disagree/,
  )
  for (const invalid of [['A'], ['A', 'A'], ['A', 'B|C'], ['A', 'é']])
    assert.throws(() => verifyCtfEnumAnnouncement(signed(invalid)))
})

test('creation requests complements in the authored announcement order', async () => {
  const { requiredMarketCreationOutcomeCollections } = await import('../src/ctfRegistration.ts')
  const collections = requiredMarketCreationOutcomeCollections([
    'Alpha',
    'Beta',
    'Gamma',
    'Delta',
    'Epsilon',
    'Zeta',
  ])
  assert.ok(collections.includes('Beta|Gamma|Delta|Epsilon|Zeta'))
  assert.ok(!collections.includes('Beta|Delta|Epsilon|Gamma|Zeta'))
})
