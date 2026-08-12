import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCtfSettingsFromMintInfo, registrationFeeForPolicy } from '../src/ctfRegistration.ts'

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
