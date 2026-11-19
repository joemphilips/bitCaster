import assert from 'node:assert/strict'
import test from 'node:test'
import { hashToCurve } from '@cashu/cashu-ts'
import { classifyExactInputStates } from '../src/exactInputStates.ts'

const KEYSET_ID = `01${'aa'.repeat(32)}`
const INPUTS = [
  { id: KEYSET_ID, secret: 'input-a' },
  { id: KEYSET_ID, secret: 'input-b' },
]
// Fixture Ys for readable cases. The NUT-00 vector test below checks the derivation itself.
const Y_A = hashToCurve(new TextEncoder().encode('input-a')).toHex(true)
const Y_B = hashToCurve(new TextEncoder().encode('input-b')).toHex(true)
const Y_FOREIGN = hashToCurve(new TextEncoder().encode('foreign')).toHex(true)

function reading(...entries: Array<[string, unknown]>) {
  return entries.map(([Y, state]) => ({ Y, state, witness: null }))
}

test('a complete reading of every exact input Y is definitive only when homogeneous', () => {
  assert.deepEqual(classifyExactInputStates(INPUTS, reading([Y_A, 'SPENT'], [Y_B, 'SPENT'])), {
    kind: 'spent',
  })
  assert.deepEqual(classifyExactInputStates(INPUTS, reading([Y_A, 'UNSPENT'], [Y_B, 'UNSPENT'])), {
    kind: 'unspent',
  })
  assert.deepEqual(classifyExactInputStates(INPUTS, reading([Y_A, 'SPENT'], [Y_B, 'PENDING'])), {
    kind: 'pending',
  })
  assert.deepEqual(classifyExactInputStates(INPUTS, reading([Y_A, 'SPENT'], [Y_B, 'UNSPENT'])), {
    kind: 'mixed',
    states: ['SPENT', 'UNSPENT'],
  })
})

test('a reordered reading classifies by Y and reports mixed states in input order', () => {
  assert.deepEqual(classifyExactInputStates(INPUTS, reading([Y_B, 'SPENT'], [Y_A, 'SPENT'])), {
    kind: 'spent',
  })
  assert.deepEqual(classifyExactInputStates(INPUTS, reading([Y_B, 'SPENT'], [Y_A, 'UNSPENT'])), {
    kind: 'mixed',
    states: ['UNSPENT', 'SPENT'],
  })
})

test('a reading that does not hold each exact input Y exactly once is a mismatch', () => {
  const cases: Array<[string, unknown]> = [
    ['missing', reading([Y_A, 'SPENT'])],
    ['extra', reading([Y_A, 'SPENT'], [Y_B, 'SPENT'], [Y_FOREIGN, 'SPENT'])],
    ['duplicate', reading([Y_A, 'SPENT'], [Y_A, 'SPENT'])],
    ['foreign', reading([Y_A, 'UNSPENT'], [Y_FOREIGN, 'UNSPENT'])],
    ['empty', []],
    ['not an array', { states: reading([Y_A, 'SPENT'], [Y_B, 'SPENT']) }],
    ['null entry', [reading([Y_A, 'SPENT'])[0], null]],
    ['non-string Y', [reading([Y_A, 'SPENT'])[0], { Y: 7, state: 'SPENT' }]],
  ]
  for (const [name, states] of cases) {
    assert.deepEqual(classifyExactInputStates(INPUTS, states), { kind: 'mismatch' }, name)
  }
})

test('inputs without a distinct Y for each input cannot be classified', () => {
  assert.deepEqual(classifyExactInputStates([], []), { kind: 'mismatch' })
  assert.deepEqual(
    classifyExactInputStates(
      [
        { id: KEYSET_ID, secret: 'input-a' },
        { id: KEYSET_ID, secret: 'input-a' },
      ],
      reading([Y_A, 'SPENT'], [Y_FOREIGN, 'SPENT']),
    ),
    { kind: 'mismatch' },
  )
})

test('an exact reading with a state outside NUT-07 is unknown', () => {
  for (const state of ['UNKNOWN', 'spent', null, undefined]) {
    assert.deepEqual(
      classifyExactInputStates(INPUTS, reading([Y_A, 'SPENT'], [Y_B, state])),
      { kind: 'unknown-state' },
      String(state),
    )
  }
})

test('input Y is the NUT-00 hash_to_curve point of the UTF-8 secret', () => {
  // NUT-00 hash_to_curve test vectors 1 and 2, nuts repository tests/00-tests.md.
  // Each message is the UTF-8 encoding of the secret: 32 zero bytes, and 31 zero bytes then 0x01.
  const inputs = [
    { id: KEYSET_ID, secret: '\u0000'.repeat(32) },
    { id: KEYSET_ID, secret: `${'\u0000'.repeat(31)}\u0001` },
  ]
  const vector1 = '024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725'
  const vector2 = '022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf'
  assert.deepEqual(
    classifyExactInputStates(inputs, reading([vector2, 'SPENT'], [vector1, 'UNSPENT'])),
    {
      kind: 'mixed',
      states: ['UNSPENT', 'SPENT'],
    },
  )
})

test('an input with an unsupported keyset ID throws for every reading', () => {
  const unsupported = [
    { id: `02${'aa'.repeat(32)}`, secret: 'input-a' },
    { id: '', secret: 'input-a' },
    { id: undefined as unknown as string, secret: 'input-a' },
  ]
  for (const input of unsupported) {
    for (const states of [reading([Y_A, 'SPENT']), []]) {
      assert.throws(() => classifyExactInputStates([input], states), /keyset ID/, String(input.id))
    }
  }
})
