import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { Amount } from '@cashu/cashu-ts'

import {
  MintError,
  parseCtfSettingsFromMintInfo,
  registerCtfCondition,
  registrationFeeForPolicy,
} from '../src/ctfRegistration.ts'

test('condition registration sends the exact wire request and preserves mint change', async () => {
  const response = {
    condition_id: 'condition-1',
    keysets: { YES: '01' },
    change: [{ id: '01', amount: '4', C_: '03' }],
  }
  let request: { url: unknown; init?: RequestInit } | undefined
  const result = await registerCtfCondition(
    {
      tags: [['title', 'Fixture']],
      announcementHex: 'abcd',
      collateral: 'msat',
      outcomeCollections: ['YES', 'NO'],
      fee: [{ id: '01', amount: Amount.from(8), secret: 'fixture', C: '02' }],
      outputs: [{ id: '01', amount: '4', B_: '03' }],
    },
    {
      endpoint: 'https://mint.example/v1/conditions',
      fetch: async (url, init) => {
        request = { url, init }
        return Response.json(response)
      },
    },
  )
  assert.equal(request?.url, 'https://mint.example/v1/conditions')
  assert.equal(request?.init?.method, 'POST')
  assert.deepEqual(request?.init?.headers, { 'Content-Type': 'application/json' })
  assert.equal(
    isDeepStrictEqual(JSON.parse(String(request?.init?.body)), {
      tags: [['title', 'Fixture']],
      announcements: ['abcd'],
      collateral: 'msat',
      outcome_collections: ['YES', 'NO'],
      fee: [{ id: '01', amount: 8, secret: 'fixture', C: '02' }],
      outputs: [{ id: '01', amount: 4, B_: '03' }],
    }),
    true,
    'condition registration wire request differs',
  )
  assert.equal(isDeepStrictEqual(result, response), true, 'mint registration result differs')
})

test('condition registration omits absent optional payment fields', async () => {
  await registerCtfCondition(
    { tags: [], announcementHex: 'abcd' },
    {
      endpoint: '/v1/conditions',
      fetch: async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)), { tags: [], announcements: ['abcd'] })
        return Response.json({ condition_id: 'condition-1', keysets: {} })
      },
    },
  )
})

for (const [body, code, detail] of [
  [
    JSON.stringify({ code: 13048, detail: 'Unsupported collateral' }),
    13048,
    'Unsupported collateral',
  ],
  [JSON.stringify({ message: 'Registration unavailable' }), 0, 'Registration unavailable'],
  ['Mint unavailable', 0, 'Mint unavailable'],
] as const) {
  test(`condition registration preserves mint refusal: ${detail}`, async () => {
    await assert.rejects(
      registerCtfCondition(
        { tags: [], announcementHex: 'abcd' },
        { endpoint: '/v1/conditions', fetch: async () => new Response(body, { status: 400 }) },
      ),
      (error: unknown) =>
        error instanceof MintError && error.code === code && error.detail === detail,
    )
  })
}

test('condition registration retains HTTP failure when the body cannot be read', async () => {
  const response = new Response('unavailable', { status: 503 })
  await response.text()
  await assert.rejects(
    registerCtfCondition(
      { tags: [], announcementHex: 'abcd' },
      { endpoint: '/v1/conditions', fetch: async () => response },
    ),
    (error: unknown) =>
      error instanceof MintError &&
      error.code === 0 &&
      error.detail === 'Failed to register condition: 503',
  )
})

test('condition registration does not retry an uncertain transport failure', async () => {
  const failure = new Error('network unavailable')
  let calls = 0
  await assert.rejects(
    registerCtfCondition(
      { tags: [], announcementHex: 'abcd' },
      {
        endpoint: '/v1/conditions',
        fetch: async () => {
          calls++
          throw failure
        },
      },
    ),
    (error: unknown) => error === failure,
  )
  assert.equal(calls, 1)
})

test('parseCtfSettingsFromMintInfo parses valid msat and usd fees', () => {
  const settings = parseCtfSettingsFromMintInfo({
    nuts: {
      CTF: {
        default_keyset_creation: 'one-vs-rest',
        registration_fees: [
          {
            unit: 'msat',
            registration_fee_base: 10000,
            registration_fee_per_keyset: 10000,
          },
          {
            unit: 'usd',
            registration_fee_base: '25',
            registration_fee_per_keyset: '5',
          },
        ],
      },
    },
  })

  assert.deepEqual(settings, {
    defaultKeysetCreation: 'one-vs-rest',
    registrationFees: [
      {
        unit: 'msat',
        registrationFeeBase: 10000,
        registrationFeePerKeyset: 10000,
      },
      {
        unit: 'usd',
        registrationFeeBase: 25,
        registrationFeePerKeyset: 5,
      },
    ],
  })
})

test('parseCtfSettingsFromMintInfo rejects missing registration_fee_base', () => {
  assert.throws(
    () =>
      parseCtfSettingsFromMintInfo(
        mintInfoWithFee({
          unit: 'msat',
          registration_fee_per_keyset: 1,
        }),
      ),
    /registration_fee_base is missing or invalid/,
  )
})

test('parseCtfSettingsFromMintInfo rejects missing registration_fee_per_keyset', () => {
  assert.throws(
    () =>
      parseCtfSettingsFromMintInfo(
        mintInfoWithFee({
          unit: 'msat',
          registration_fee_base: 1,
        }),
      ),
    /registration_fee_per_keyset is missing or invalid/,
  )
})

test('parseCtfSettingsFromMintInfo rejects negative values', () => {
  assert.throws(
    () =>
      parseCtfSettingsFromMintInfo(
        mintInfoWithFee({
          unit: 'msat',
          registration_fee_base: -1,
          registration_fee_per_keyset: 1,
        }),
      ),
    /registration_fee_base is missing or invalid/,
  )
})

test('parseCtfSettingsFromMintInfo rejects non-safe-integer fee values', () => {
  assert.throws(
    () =>
      parseCtfSettingsFromMintInfo(
        mintInfoWithFee({
          unit: 'msat',
          registration_fee_base: Number.MAX_SAFE_INTEGER + 1,
          registration_fee_per_keyset: 1,
        }),
      ),
    /registration_fee_base is missing or invalid/,
  )
})

test('parseCtfSettingsFromMintInfo rejects duplicate registration fee units', () => {
  assert.throws(
    () =>
      parseCtfSettingsFromMintInfo(
        mintInfoWithFees([
          {
            unit: 'msat',
            registration_fee_base: 1,
            registration_fee_per_keyset: 1,
          },
          {
            unit: 'msat',
            registration_fee_base: 2,
            registration_fee_per_keyset: 2,
          },
        ]),
      ),
    /duplicate unit 'msat'/,
  )
})

test('parseCtfSettingsFromMintInfo rejects non-array registration_fees', () => {
  assert.throws(
    () =>
      parseCtfSettingsFromMintInfo({
        nuts: {
          CTF: {
            default_keyset_creation: 'one-vs-rest',
            registration_fees: {},
          },
        },
      }),
    /registration_fees is missing or invalid/,
  )
})

test('parseCtfSettingsFromMintInfo rejects invalid default_keyset_creation', () => {
  assert.throws(
    () =>
      parseCtfSettingsFromMintInfo({
        nuts: {
          CTF: {
            default_keyset_creation: 'per-outcome',
            registration_fees: [],
          },
        },
      }),
    /Unsupported mint CTF default_keyset_creation: per-outcome/,
  )
})

test('parseCtfSettingsFromMintInfo accepts empty registration_fees', () => {
  const settings = parseCtfSettingsFromMintInfo({
    nuts: {
      CTF: {
        default_keyset_creation: 'one-vs-rest',
        registration_fees: [],
      },
    },
  })

  assert.deepEqual(settings, {
    defaultKeysetCreation: 'one-vs-rest',
    registrationFees: [],
  })
  assert.throws(
    () => registrationFeeForPolicy(['YES', 'NO'], settings, 'msat'),
    /does not support CTF collateral unit 'msat'/,
  )
})

test('registrationFeeForPolicy returns per-unit msat fee without scaling', () => {
  const fee = registrationFeeForPolicy(
    ['YES', 'NO', 'MAYBE'],
    {
      defaultKeysetCreation: 'one-vs-rest',
      registrationFees: [
        {
          unit: 'msat',
          registrationFeeBase: 10000,
          registrationFeePerKeyset: 10000,
        },
      ],
    },
    'msat',
  )

  assert.equal(fee, 70000)
})

test('registrationFeeForPolicy rejects unsupported collateral units', () => {
  assert.throws(
    () =>
      registrationFeeForPolicy(
        ['YES', 'NO'],
        {
          defaultKeysetCreation: 'one-vs-rest',
          registrationFees: [
            {
              unit: 'msat',
              registrationFeeBase: 10000,
              registrationFeePerKeyset: 10000,
            },
          ],
        },
        'sat',
      ),
    /does not support CTF collateral unit 'sat'/,
  )
})

function mintInfoWithFee(fee: Record<string, unknown>): Record<string, unknown> {
  return mintInfoWithFees([fee])
}

function mintInfoWithFees(fees: Record<string, unknown>[]): Record<string, unknown> {
  return {
    nuts: {
      CTF: {
        default_keyset_creation: 'one-vs-rest',
        registration_fees: fees,
      },
    },
  }
}
