import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  WALLET_RECOVERY_PERSISTENT_FAILURES,
  classifyWalletRecoveryStatus,
  sameWalletRecoveryTag,
  walletRecoveryEmptyIsTerminal,
  walletRecoveryMintSetTag,
  type WalletRecoveryClassificationInput,
  type WalletRecoveryHoldingsRead,
  type WalletRecoveryStageObservation,
  type WalletRecoveryStatus,
  type WalletRecoveryTag,
} from '../src/walletRecoveryStatus.ts'

const MINT_A = 'https://mint-a.example'
const MINT_B = 'https://mint-b.example'

function tag(
  overrides: { scopeId?: string; epoch?: number; mints?: readonly string[] } = {},
): WalletRecoveryTag {
  return {
    activation: { scopeId: overrides.scopeId ?? 'scope-a', epoch: overrides.epoch ?? 1 },
    mintSetTag: walletRecoveryMintSetTag(overrides.mints ?? [MINT_A]),
  }
}

const CURRENT = tag()

const completed = (stage: string, coverage: 'full' | 'limited' = 'full') =>
  ({ stage, state: 'completed', coverage }) as const satisfies WalletRecoveryStageObservation
const notRun = (stage: string) =>
  ({ stage, state: 'not-run' }) as const satisfies WalletRecoveryStageObservation
const failed = (stage: string, consecutiveFailures: number, retryAtMs: number | null = null) =>
  ({
    stage,
    state: 'failed',
    consecutiveFailures,
    retryAtMs,
  }) as const satisfies WalletRecoveryStageObservation
const pending = (
  stage: string,
  reason: Extract<WalletRecoveryStageObservation, { state: 'pending' }>['reason'],
  retryAtMs: number | null,
) =>
  ({ stage, state: 'pending', reason, retryAtMs }) as const satisfies WalletRecoveryStageObservation

function input(
  stages: readonly WalletRecoveryStageObservation[],
  overrides: Partial<WalletRecoveryClassificationInput> = {},
): WalletRecoveryClassificationInput {
  return {
    current: CURRENT,
    observations: { tag: CURRENT, passSeq: 4, stages },
    persistentFailures: [],
    ...overrides,
  }
}

describe('walletRecoveryMintSetTag', () => {
  test('de-duplicates and sorts the normalized mint URLs', () => {
    assert.equal(
      walletRecoveryMintSetTag([MINT_B, MINT_A, MINT_B]),
      walletRecoveryMintSetTag([MINT_A, MINT_B]),
    )
    assert.equal(
      walletRecoveryMintSetTag([MINT_B, MINT_A]),
      '["https://mint-a.example","https://mint-b.example"]',
    )
  })

  test('gives different tags to different mint sets', () => {
    const tags = [
      walletRecoveryMintSetTag([MINT_A]),
      walletRecoveryMintSetTag([MINT_B]),
      walletRecoveryMintSetTag([MINT_A, MINT_B]),
      walletRecoveryMintSetTag([]),
      // A separator inside one value must not equal two values.
      walletRecoveryMintSetTag([`${MINT_A}","${MINT_B}`]),
    ]
    assert.equal(new Set(tags).size, tags.length)
  })

  test('rejects an empty value', () => {
    for (const urls of [[''], [MINT_A, ''], ['   '], [MINT_A, '\n']]) {
      assert.throws(
        () => walletRecoveryMintSetTag(urls),
        /^Error: a wallet recovery mint URL is empty$/,
      )
    }
  })
})

describe('sameWalletRecoveryTag', () => {
  const cases: ReadonlyArray<{ name: string; other: WalletRecoveryTag; same: boolean }> = [
    { name: 'an equal tag', other: tag(), same: true },
    {
      name: 'the same mint set in another order',
      other: tag({ mints: [MINT_A, MINT_A] }),
      same: true,
    },
    { name: 'another wallet scope', other: tag({ scopeId: 'scope-b' }), same: false },
    { name: 'another activation of the same scope', other: tag({ epoch: 2 }), same: false },
    { name: 'another mint set', other: tag({ mints: [MINT_A, MINT_B] }), same: false },
  ]
  for (const { name, other, same } of cases) {
    test(`${name} is ${same ? 'the same' : 'a different'} tag`, () => {
      assert.equal(sameWalletRecoveryTag(CURRENT, other), same)
      assert.equal(sameWalletRecoveryTag(other, CURRENT), same)
    })
  }
})

describe('classifyWalletRecoveryStatus', () => {
  const cases: ReadonlyArray<{
    name: string
    input: WalletRecoveryClassificationInput
    expected: WalletRecoveryStatus
  }> = [
    // Unavailable.
    {
      name: 'no active wallet profile is unavailable and not retryable',
      input: input([completed('receive')], { current: null }),
      expected: { kind: 'unavailable', tag: null, reason: 'profile-unavailable', retryable: false },
    },
    {
      name: 'a failed observation read is unavailable, never idle or completed',
      input: input([], { observations: 'read-failed' }),
      expected: { kind: 'unavailable', tag: CURRENT, reason: 'read-failed', retryable: true },
    },
    {
      name: 'three consecutive failures of a stage are unavailable',
      input: input([
        completed('receive'),
        failed('counter', WALLET_RECOVERY_PERSISTENT_FAILURES, 9_000),
      ]),
      expected: { kind: 'unavailable', tag: CURRENT, reason: 'recovery-failed', retryable: true },
    },
    {
      name: 'more than three consecutive failures stay unavailable',
      input: input([failed('counter', 7, null)]),
      expected: { kind: 'unavailable', tag: CURRENT, reason: 'recovery-failed', retryable: true },
    },
    {
      name: 'a persistent durable failure is unavailable',
      input: input([completed('receive')], {
        persistentFailures: [{ source: 'seed-restore', consecutiveFailures: 3, retryAtMs: 5_000 }],
      }),
      expected: { kind: 'unavailable', tag: CURRENT, reason: 'recovery-failed', retryable: true },
    },
    {
      name: 'unavailable precedes checking from a stage that has not run',
      input: input([notRun('receive'), failed('counter', 3)]),
      expected: { kind: 'unavailable', tag: CURRENT, reason: 'recovery-failed', retryable: true },
    },
    {
      name: 'a persistent durable failure precedes checking from a stale tag',
      input: input([completed('receive')], {
        observations: { tag: tag({ epoch: 0 }), passSeq: 1, stages: [completed('receive')] },
        persistentFailures: [{ source: 'seed-restore', consecutiveFailures: 3, retryAtMs: null }],
      }),
      expected: { kind: 'unavailable', tag: CURRENT, reason: 'recovery-failed', retryable: true },
    },
    // Checking.
    {
      name: 'observations of an earlier activation of the same scope are checking',
      input: input([], {
        observations: { tag: tag({ epoch: 0 }), passSeq: 9, stages: [completed('receive')] },
      }),
      expected: { kind: 'checking', tag: CURRENT },
    },
    {
      name: 'observations of another wallet scope are checking',
      input: input([], {
        observations: {
          tag: tag({ scopeId: 'scope-b' }),
          passSeq: 9,
          stages: [completed('receive')],
        },
      }),
      expected: { kind: 'checking', tag: CURRENT },
    },
    {
      name: 'observations of another mint set are checking',
      input: input([], {
        observations: {
          tag: tag({ mints: [MINT_A, MINT_B] }),
          passSeq: 9,
          stages: [completed('receive')],
        },
      }),
      expected: { kind: 'checking', tag: CURRENT },
    },
    {
      name: 'a failure of a stale tag does not count',
      input: input([], {
        observations: { tag: tag({ epoch: 0 }), passSeq: 9, stages: [failed('counter', 3)] },
      }),
      expected: { kind: 'checking', tag: CURRENT },
    },
    {
      name: 'a stage that has not run is checking',
      input: input([completed('receive'), notRun('counter')]),
      expected: { kind: 'checking', tag: CURRENT },
    },
    {
      name: 'no stage observation is checking',
      input: input([]),
      expected: { kind: 'checking', tag: CURRENT },
    },
    {
      name: 'checking precedes pending',
      input: input([pending('outgoing', 'operation', 1_000), notRun('counter')]),
      expected: { kind: 'checking', tag: CURRENT },
    },
    // Pending.
    ...(
      [
        'operation',
        'proof-pending',
        'scan-continues',
        'start-limit',
        'probe-due',
        'backoff',
      ] as const
    ).map((reason) => ({
      name: `a ${reason} stage is pending with its reason and retry time`,
      input: input([completed('receive'), pending('stage', reason, 2_000)]),
      expected: { kind: 'pending', tag: CURRENT, reason, retryAtMs: 2_000 } as const,
    })),
    {
      name: 'one failure is pending with backoff',
      input: input([completed('receive'), failed('counter', 1, 15_000)]),
      expected: { kind: 'pending', tag: CURRENT, reason: 'backoff', retryAtMs: 15_000 },
    },
    {
      name: 'two consecutive failures are pending with backoff',
      input: input([failed('counter', WALLET_RECOVERY_PERSISTENT_FAILURES - 1, 15_000)]),
      expected: { kind: 'pending', tag: CURRENT, reason: 'backoff', retryAtMs: 15_000 },
    },
    {
      name: 'a durable failure below the bound is pending with backoff',
      input: input([completed('receive')], {
        persistentFailures: [{ source: 'seed-restore', consecutiveFailures: 2, retryAtMs: 8_000 }],
      }),
      expected: { kind: 'pending', tag: CURRENT, reason: 'backoff', retryAtMs: 8_000 },
    },
    {
      name: 'the earliest retry time wins',
      input: input([
        pending('resync', 'probe-due', 5_000),
        pending('seed-restore', 'scan-continues', 1_000),
        failed('counter', 1, 3_000),
      ]),
      expected: { kind: 'pending', tag: CURRENT, reason: 'scan-continues', retryAtMs: 1_000 },
    },
    {
      name: 'a durable failure with the earliest retry time wins',
      input: input([pending('resync', 'probe-due', 5_000)], {
        persistentFailures: [{ source: 'seed-restore', consecutiveFailures: 1, retryAtMs: 4_000 }],
      }),
      expected: { kind: 'pending', tag: CURRENT, reason: 'backoff', retryAtMs: 4_000 },
    },
    {
      name: 'a known retry time wins over an unknown one',
      input: input([pending('outgoing', 'operation', null), pending('resync', 'probe-due', 5_000)]),
      expected: { kind: 'pending', tag: CURRENT, reason: 'probe-due', retryAtMs: 5_000 },
    },
    {
      name: 'the first stage wins when no retry time is known',
      input: input([
        pending('counter', 'proof-pending', null),
        pending('outgoing', 'operation', null),
      ]),
      expected: { kind: 'pending', tag: CURRENT, reason: 'proof-pending', retryAtMs: null },
    },
    {
      name: 'the first stage wins an equal retry time',
      input: input([
        pending('seed-restore', 'start-limit', 2_000),
        pending('resync', 'probe-due', 2_000),
      ]),
      expected: { kind: 'pending', tag: CURRENT, reason: 'start-limit', retryAtMs: 2_000 },
    },
    // Completed.
    {
      name: 'every stage completed with full coverage is completed and full',
      input: input([completed('receive'), completed('counter')]),
      expected: { kind: 'completed', tag: CURRENT, passSeq: 4, coverage: 'full' },
    },
    {
      name: 'one stage with limited coverage makes the completion limited',
      input: input([completed('receive'), completed('seed-restore', 'limited')]),
      expected: { kind: 'completed', tag: CURRENT, passSeq: 4, coverage: 'limited' },
    },
    {
      name: 'a durable record with no failure does not change the completion',
      input: input([completed('receive')], {
        persistentFailures: [{ source: 'seed-restore', consecutiveFailures: 0, retryAtMs: null }],
      }),
      expected: { kind: 'completed', tag: CURRENT, passSeq: 4, coverage: 'full' },
    },
    {
      name: 'the observation tag can list the same mint set in another order',
      input: input([], {
        current: tag({ mints: [MINT_B, MINT_A] }),
        observations: {
          tag: tag({ mints: [MINT_A, MINT_B] }),
          passSeq: 2,
          stages: [completed('receive')],
        },
      }),
      expected: {
        kind: 'completed',
        tag: tag({ mints: [MINT_B, MINT_A] }),
        passSeq: 2,
        coverage: 'full',
      },
    },
  ]
  for (const { name, input: value, expected } of cases) {
    test(name, () => {
      assert.deepEqual(classifyWalletRecoveryStatus(value), expected)
    })
  }

  test('rejects an unknown stage state', () => {
    const unknown = { stage: 'receive', state: 'idle' } as unknown as WalletRecoveryStageObservation
    assert.throws(
      () => classifyWalletRecoveryStatus(input([unknown])),
      /^Error: unknown wallet recovery stage state: "idle"$/,
    )
  })

  test('rejects an unknown coverage', () => {
    const unknown = {
      stage: 'receive',
      state: 'completed',
      coverage: 'partial',
    } as unknown as WalletRecoveryStageObservation
    assert.throws(
      () => classifyWalletRecoveryStatus(input([unknown])),
      /^Error: unknown wallet recovery coverage: "partial"$/,
    )
  })

  test('rejects an invalid failure count or pass sequence', () => {
    for (const count of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () => classifyWalletRecoveryStatus(input([failed('counter', count)])),
        /^Error: a wallet recovery failure count is invalid$/,
      )
      assert.throws(
        () =>
          classifyWalletRecoveryStatus(
            input([completed('receive')], {
              persistentFailures: [
                { source: 'seed-restore', consecutiveFailures: count, retryAtMs: null },
              ],
            }),
          ),
        /^Error: a wallet recovery failure count is invalid$/,
      )
      assert.throws(
        () =>
          classifyWalletRecoveryStatus(
            input([], {
              observations: { tag: CURRENT, passSeq: count, stages: [completed('receive')] },
            }),
          ),
        /^Error: a wallet recovery pass sequence is invalid$/,
      )
    }
  })
})

describe('walletRecoveryEmptyIsTerminal', () => {
  const COMPLETED_FULL: WalletRecoveryStatus = {
    kind: 'completed',
    tag: CURRENT,
    passSeq: 4,
    coverage: 'full',
  }
  const okRead = (
    overrides: Partial<Extract<WalletRecoveryHoldingsRead<string>, { kind: 'ok' }>> = {},
  ): WalletRecoveryHoldingsRead<string> => ({
    kind: 'ok',
    tag: CURRENT,
    afterPassSeq: 4,
    value: [],
    ...overrides,
  })
  const cases: ReadonlyArray<{
    name: string
    status: WalletRecoveryStatus
    read: WalletRecoveryHoldingsRead<string>
    terminal: boolean
  }> = [
    {
      name: 'an empty read after the completed pass',
      status: COMPLETED_FULL,
      read: okRead(),
      terminal: true,
    },
    {
      name: 'an empty read after a later pass',
      status: COMPLETED_FULL,
      read: okRead({ afterPassSeq: 5 }),
      terminal: true,
    },
    {
      name: 'an empty read before the completed pass',
      status: COMPLETED_FULL,
      read: okRead({ afterPassSeq: 3 }),
      terminal: false,
    },
    {
      name: 'a read with holdings',
      status: COMPLETED_FULL,
      read: okRead({ value: ['sat'] }),
      terminal: false,
    },
    {
      name: 'an unhydrated read',
      status: COMPLETED_FULL,
      read: { kind: 'unhydrated' },
      terminal: false,
    },
    { name: 'a failed read', status: COMPLETED_FULL, read: { kind: 'failed' }, terminal: false },
    {
      name: 'an empty read of an earlier activation',
      status: COMPLETED_FULL,
      read: okRead({ tag: tag({ epoch: 0 }) }),
      terminal: false,
    },
    {
      name: 'an empty read of another wallet scope',
      status: COMPLETED_FULL,
      read: okRead({ tag: tag({ scopeId: 'scope-b' }) }),
      terminal: false,
    },
    {
      name: 'an empty read of another mint set',
      status: COMPLETED_FULL,
      read: okRead({ tag: tag({ mints: [MINT_A, MINT_B] }) }),
      terminal: false,
    },
    {
      name: 'an empty read with limited coverage',
      status: { ...COMPLETED_FULL, coverage: 'limited' },
      read: okRead(),
      terminal: false,
    },
    {
      name: 'an empty read while checking',
      status: { kind: 'checking', tag: CURRENT },
      read: okRead(),
      terminal: false,
    },
    {
      name: 'an empty read while pending',
      status: { kind: 'pending', tag: CURRENT, reason: 'proof-pending', retryAtMs: null },
      read: okRead(),
      terminal: false,
    },
    {
      name: 'an empty read while unavailable',
      status: { kind: 'unavailable', tag: CURRENT, reason: 'read-failed', retryable: true },
      read: okRead(),
      terminal: false,
    },
  ]
  for (const { name, status, read, terminal } of cases) {
    test(`${name} is ${terminal ? '' : 'not '}terminal`, () => {
      assert.equal(walletRecoveryEmptyIsTerminal(status, read), terminal)
    })
  }

  test('rejects an unknown read kind', () => {
    const unknown = { kind: 'loading' } as unknown as WalletRecoveryHoldingsRead<string>
    assert.throws(
      () => walletRecoveryEmptyIsTerminal(COMPLETED_FULL, unknown),
      /^Error: unknown wallet recovery holdings read: "loading"$/,
    )
  })
})

test('the built SDK exposes the wallet recovery status subpath', async () => {
  const subpath = await import('@bitcaster-market/client-sdk/walletRecoveryStatus')
  assert.equal(typeof subpath.classifyWalletRecoveryStatus, 'function')
  assert.equal(typeof subpath.walletRecoveryEmptyIsTerminal, 'function')
  assert.equal(subpath.WALLET_RECOVERY_PERSISTENT_FAILURES, 3)
})
