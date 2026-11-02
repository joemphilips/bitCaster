import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  classifyHeldPosition,
  deriveWinner,
  isWinningCollection,
  parseOutcomeCollection,
  summarizeHeldPositions,
  type HeldCustodyProof,
  type HeldPositionCustodyFacts,
} from '../src/heldPositionStatus.ts'

function held(overrides: Partial<HeldPositionCustodyFacts> = {}): HeldPositionCustodyFacts {
  return {
    outcomeCollection: 'YES',
    amount: 4_000,
    retainedUnverifiedAmount: 0,
    allVerifiedLosing: false,
    claimRecoveryPending: false,
    ...overrides,
  }
}

describe('parseOutcomeCollection', () => {
  test('splits a composite collection and honours escaped pipes', () => {
    assert.deepEqual(parseOutcomeCollection('A|B'), ['A', 'B'])
    assert.deepEqual(parseOutcomeCollection('A'), ['A'])
    assert.deepEqual(parseOutcomeCollection('A\\|B|C'), ['A|B', 'C'])
  })
})

describe('isWinningCollection', () => {
  test('uses exact membership of the attested outcome', () => {
    assert.equal(isWinningCollection('A', 'A'), true)
    assert.equal(isWinningCollection('A|B', 'A'), true)
    assert.equal(isWinningCollection('B', 'A'), false)
    assert.equal(isWinningCollection('A|B', 'C'), false)
    assert.equal(isWinningCollection('Alpha|Beta', 'alpha'), false)
    assert.equal(isWinningCollection('Alpha|Beta', ' Alpha '), false)
    assert.equal(isWinningCollection('A', null), false)
    assert.equal(isWinningCollection('A', undefined), false)
    assert.equal(isWinningCollection('A', ''), false)
  })
})

describe('deriveWinner', () => {
  test('a winning leg makes a winner; the value counts winning legs only', () => {
    assert.deepEqual(
      deriveWinner({
        isClosed: true,
        finalOutcome: 'A',
        legs: [{ outcomeCollection: 'A', amount: 250 }],
      }),
      { status: 'winner', claimableValue: 250 },
    )
    assert.deepEqual(
      deriveWinner({
        isClosed: true,
        finalOutcome: 'A',
        legs: [
          { outcomeCollection: 'A', amount: 100 },
          { outcomeCollection: 'B', amount: 40 },
        ],
      }),
      { status: 'winner', claimableValue: 100 },
    )
    assert.deepEqual(
      deriveWinner({
        isClosed: true,
        finalOutcome: 'A',
        legs: [{ outcomeCollection: 'A|B', amount: 70 }],
      }),
      { status: 'winner', claimableValue: 70 },
    )
  })

  test('an attested outcome with no winning leg makes a loser', () => {
    for (const legs of [
      [
        { outcomeCollection: 'B', amount: 30 },
        { outcomeCollection: 'C', amount: 20 },
      ],
      [],
      [{ outcomeCollection: '', amount: 5 }],
    ])
      assert.deepEqual(deriveWinner({ isClosed: true, finalOutcome: 'A', legs }), {
        status: 'loser',
        claimableValue: 0,
      })
    for (const finalOutcome of ['alpha', ' Alpha '])
      assert.equal(
        deriveWinner({
          isClosed: true,
          finalOutcome,
          legs: [{ outcomeCollection: 'Alpha', amount: 1 }],
        }).status,
        'loser',
      )
  })

  test('an open market is active and a closed market without an outcome is pending', () => {
    assert.deepEqual(
      deriveWinner({
        isClosed: false,
        finalOutcome: 'A',
        legs: [{ outcomeCollection: 'A', amount: 5 }],
      }),
      { status: 'active', claimableValue: 0 },
    )
    assert.deepEqual(
      deriveWinner({
        isClosed: true,
        finalOutcome: null,
        legs: [
          { outcomeCollection: 'A', amount: 30 },
          { outcomeCollection: 'B', amount: 20 },
        ],
      }),
      { status: 'pending', claimableValue: 50 },
    )
    for (const finalOutcome of [undefined, '', '   '])
      assert.equal(
        deriveWinner({
          isClosed: true,
          finalOutcome,
          legs: [{ outcomeCollection: 'A', amount: 5 }],
        }).status,
        'pending',
      )
  })
})

describe('classifyHeldPosition', () => {
  test('a position in an open or unknown market is active', () => {
    const expected = { closed: false, result: 'active', claimableAmount: 0 }
    assert.deepEqual(classifyHeldPosition(held(), { state: 'open', finalOutcome: null }), expected)
    assert.deepEqual(classifyHeldPosition(held(), undefined), expected)
  })

  test('a closed market without a verified outcome is pending, not lost', () => {
    assert.deepEqual(classifyHeldPosition(held(), { state: 'closed', finalOutcome: null }), {
      closed: true,
      result: 'pending',
      claimableAmount: 0,
    })
    assert.deepEqual(classifyHeldPosition(held(), { state: 'closed', finalOutcome: '  ' }), {
      closed: true,
      result: 'pending',
      claimableAmount: 0,
    })
  })

  test('a verified outcome decides won or lost from the held collection', () => {
    assert.deepEqual(classifyHeldPosition(held(), { state: 'closed', finalOutcome: 'YES' }), {
      closed: true,
      result: 'winner',
      claimableAmount: 4_000,
    })
    assert.deepEqual(classifyHeldPosition(held(), { state: 'closed', finalOutcome: 'NO' }), {
      closed: true,
      result: 'loser',
      claimableAmount: 0,
    })
    assert.deepEqual(
      classifyHeldPosition(held({ outcomeCollection: 'Alice|Bob', amount: 900 }), {
        state: 'closed',
        finalOutcome: 'Bob',
      }),
      { closed: true, result: 'winner', claimableAmount: 900 },
    )
  })

  test('the Portfolio trims the catalogue outcome and accepts any letter case of closed', () => {
    assert.deepEqual(classifyHeldPosition(held(), { state: 'Closed', finalOutcome: ' YES ' }), {
      closed: true,
      result: 'winner',
      claimableAmount: 4_000,
    })
  })

  test('a mint-verified loss closes the row as lost before the catalogue closes', () => {
    assert.deepEqual(
      classifyHeldPosition(held({ allVerifiedLosing: true }), {
        state: 'open',
        finalOutcome: null,
      }),
      { closed: true, result: 'loser', claimableAmount: 0 },
    )
  })

  test('retained unverified history is closed with no result', () => {
    assert.deepEqual(
      classifyHeldPosition(held({ amount: 0, retainedUnverifiedAmount: 3_000 }), {
        state: 'closed',
        finalOutcome: 'YES',
      }),
      { closed: true, result: 'history', claimableAmount: 0 },
    )
  })

  test('a pending claim closes the row; the catalogue outcome still decides the result', () => {
    assert.deepEqual(
      classifyHeldPosition(held({ claimRecoveryPending: true }), {
        state: 'open',
        finalOutcome: null,
      }),
      { closed: true, result: 'pending', claimableAmount: 0 },
    )
    assert.deepEqual(
      classifyHeldPosition(held({ claimRecoveryPending: true }), {
        state: 'closed',
        finalOutcome: 'YES',
      }),
      { closed: true, result: 'winner', claimableAmount: 4_000 },
    )
  })
})

function proof(overrides: Partial<HeldCustodyProof> = {}): HeldCustodyProof {
  return {
    normalizedMint: 'https://mint.example',
    unit: 'msat',
    assetKind: 'conditional',
    conditionId: 'c'.repeat(64),
    outcomeCollection: 'YES',
    baseAsset: 'sat',
    amount: 1_000,
    selectability: 'selectable',
    receivedAtMs: 1_700_000_000_000,
    claimRecoveryPending: false,
    ...overrides,
  }
}

describe('summarizeHeldPositions', () => {
  test('groups proofs by mint, unit, condition and collection in first-seen order', () => {
    const positions = summarizeHeldPositions([
      proof({ amount: 1_000, receivedAtMs: 30 }),
      proof({ outcomeCollection: 'NO', amount: 7, receivedAtMs: 40 }),
      proof({ amount: 500, receivedAtMs: 10 }),
      proof({ normalizedMint: 'https://second.example', amount: 3, receivedAtMs: 50 }),
      proof({ unit: 'sat', amount: 2, receivedAtMs: 60 }),
    ])

    assert.deepEqual(
      positions.map(({ mintUrl, unit, outcomeCollection, amount, firstReceivedAt }) => ({
        mintUrl,
        unit,
        outcomeCollection,
        amount,
        firstReceivedAt,
      })),
      [
        {
          mintUrl: 'https://mint.example',
          unit: 'msat',
          outcomeCollection: 'YES',
          amount: 1_500,
          firstReceivedAt: 10,
        },
        {
          mintUrl: 'https://mint.example',
          unit: 'msat',
          outcomeCollection: 'NO',
          amount: 7,
          firstReceivedAt: 40,
        },
        {
          mintUrl: 'https://second.example',
          unit: 'msat',
          outcomeCollection: 'YES',
          amount: 3,
          firstReceivedAt: 50,
        },
        {
          mintUrl: 'https://mint.example',
          unit: 'sat',
          outcomeCollection: 'YES',
          amount: 2,
          firstReceivedAt: 60,
        },
      ],
    )
    assert.ok(positions.every(({ baseAsset }) => baseAsset === 'sat'))
  })

  test('ignores regular proofs and conditional proofs without a condition or collection', () => {
    assert.deepEqual(
      summarizeHeldPositions([
        proof({ assetKind: 'regular', conditionId: null, outcomeCollection: null }),
        proof({ conditionId: null }),
        proof({ outcomeCollection: '' }),
      ]),
      [],
    )
  })

  test('keeps retained unverified proofs out of the usable amount', () => {
    const [position] = summarizeHeldPositions([
      proof({ amount: 400 }),
      proof({ amount: 600, selectability: 'retained-unverified' }),
    ])

    assert.equal(position!.amount, 400)
    assert.equal(position!.retainedUnverifiedAmount, 600)
  })

  test('a position is all verified losing only when no proof can still win', () => {
    const allVerifiedLosing = (...selectability: HeldCustodyProof['selectability'][]) =>
      summarizeHeldPositions(selectability.map((value) => proof({ selectability: value })))[0]!
        .allVerifiedLosing

    assert.equal(allVerifiedLosing('verified-losing'), true)
    assert.equal(
      allVerifiedLosing('verified-losing', 'retained-unverified', 'pending-removal'),
      true,
    )
    assert.equal(allVerifiedLosing('verified-losing', 'selectable'), false)
    assert.equal(allVerifiedLosing('locked', 'verified-losing'), false)
  })

  test('one pending claim or one pending removal marks the position', () => {
    const [position] = summarizeHeldPositions([
      proof(),
      proof({ claimRecoveryPending: true }),
      proof({ selectability: 'pending-removal' }),
    ])

    assert.equal(position!.claimRecoveryPending, true)
    assert.equal(position!.removalPending, true)
    const [plain] = summarizeHeldPositions([proof(), proof({ selectability: 'locked' })])
    assert.equal(plain!.claimRecoveryPending, false)
    assert.equal(plain!.removalPending, false)
  })

  test('a held position is the custody input of the classification', () => {
    const [position] = summarizeHeldPositions([proof({ outcomeCollection: 'A|B', amount: 900 })])

    assert.deepEqual(classifyHeldPosition(position!, { state: 'closed', finalOutcome: 'B' }), {
      closed: true,
      result: 'winner',
      claimableAmount: 900,
    })
  })
})
