import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Token } from '@cashu/cashu-ts'
import {
  DEFAULT_TOKEN_IMPORT_BOUNDS,
  TokenImportValidationError,
  validateTokenImport,
  type ResolveTokenImportKeysets,
  type TokenImportKeysetLookup,
} from '../src/tokenImportValidation.ts'

function token(
  mint = 'https://mint.example',
  unit = 'sat',
  keysetIds: readonly string[] = ['regular'],
): Token {
  return {
    mint,
    unit,
    proofs: keysetIds.map((id, index) => ({
      id,
      amount: 1 as never,
      secret: `secret-${index}`,
      C: `signature-${index}`,
    })),
  }
}

function lookup(
  regularKeysets: TokenImportKeysetLookup['regularKeysets'] = [],
  conditionalKeysets: TokenImportKeysetLookup['conditionalKeysets'] = [],
): TokenImportKeysetLookup {
  return { freshness: 'fresh', regularKeysets, conditionalKeysets }
}

function metadata(keysetId: string, unit = 'sat', active: unknown = true) {
  return { keysetId, unit, active }
}

async function expectCode(promise: Promise<unknown>, code: TokenImportValidationError['code']) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof TokenImportValidationError)
    assert.equal(error.code, code)
    return true
  })
}

test('rejects the encoded-byte cap before decode or resolver work', async () => {
  let decodeCalls = 0
  let resolverCalls = 0
  await expectCode(
    validateTokenImport({
      encodedToken: '€'.repeat(35_000),
      contextUnit: 'sat',
      decode: () => {
        decodeCalls += 1
        return token()
      },
      resolveKeysets: async () => {
        resolverCalls += 1
        return lookup()
      },
    }),
    'encoded_too_large',
  )
  assert.equal(decodeCalls, 0)
  assert.equal(resolverCalls, 0)
})

test('accepts the exact encoded-byte boundary without changing the bearer token', async () => {
  const encodedToken = 'x'.repeat(32)
  const result = await validateTokenImport({
    encodedToken,
    contextUnit: 'sat',
    decode: () => token(),
    resolveKeysets: async () => lookup([metadata('regular')]),
    bounds: { maxEncodedBytes: 32 },
  })
  assert.equal(result.encodedToken, encodedToken)
})

test('enforces proof, mint, and keyset caps before resolver work', async () => {
  const cases = [
    {
      decoded: token('https://mint.example', 'sat', ['a', 'a', 'a']),
      bounds: { maxProofs: 2 },
      code: 'proof_limit_exceeded' as const,
    },
    {
      decoded: [token('https://a.example'), token('https://b.example')],
      bounds: { maxMints: 1 },
      code: 'mint_limit_exceeded' as const,
    },
    {
      decoded: token('https://mint.example', 'sat', ['a', 'b']),
      bounds: { maxKeysets: 1 },
      code: 'keyset_limit_exceeded' as const,
    },
  ]
  for (const item of cases) {
    let resolverCalls = 0
    await expectCode(
      validateTokenImport({
        encodedToken: 'cashuB',
        contextUnit: 'sat',
        decode: () => item.decoded,
        resolveKeysets: async () => {
          resolverCalls += 1
          return lookup()
        },
        bounds: item.bounds,
      }),
      item.code,
    )
    assert.equal(resolverCalls, 0)
  }
})

test('canonicalizes mint identities, groups keysets, and preserves exact bearer bytes', async () => {
  const requests: Array<{ canonicalMintUrl: string; keysetIds: readonly string[] }> = []
  const encodedToken = '  cashuB-byte-identical  '
  const result = await validateTokenImport({
    encodedToken,
    contextUnit: 'sat',
    decode: () => [
      token('HTTPS://MINT.EXAMPLE:443/path/', 'sat', ['b', 'a']),
      token('https://mint.example/path', 'sat', ['a']),
    ],
    resolveKeysets: async (request) => {
      requests.push(request)
      return lookup([metadata('a'), metadata('b')])
    },
  })

  assert.equal(result.encodedToken, encodedToken)
  assert.deepEqual(result.canonicalMintUrls, ['https://mint.example/path'])
  assert.deepEqual(requests, [
    { canonicalMintUrl: 'https://mint.example/path', keysetIds: ['a', 'b'] },
  ])
  assert.equal(result.proofs.length, 3)
})

test('resolves regular and conditional keysets and visibly classifies known inactive proofs', async () => {
  const result = await validateTokenImport({
    encodedToken: 'cashuB',
    contextUnit: 'msat',
    decode: () => token('https://mint.example', 'msat', ['regular-old', 'ctf-current']),
    resolveKeysets: async () =>
      lookup([metadata('regular-old', 'msat', false)], [metadata('ctf-current', 'msat', true)]),
  })

  assert.equal(result.hasInactiveProofs, true)
  assert.deepEqual(
    result.proofs.map(({ keysetId, source, activity }) => ({ keysetId, source, activity })),
    [
      { keysetId: 'regular-old', source: 'regular', activity: 'inactive' },
      { keysetId: 'ctf-current', source: 'conditional', activity: 'active' },
    ],
  )
})

test('requires exact token, keyset, and context unit agreement', async () => {
  await expectCode(
    validateTokenImport({
      encodedToken: 'cashuB',
      contextUnit: 'sat',
      decode: () => token('https://mint.example', 'SAT'),
      resolveKeysets: async () => lookup(),
    }),
    'unsupported_unit',
  )
  await expectCode(
    validateTokenImport({
      encodedToken: 'cashuB',
      contextUnit: 'sat',
      decode: () => token('https://mint.example', 'msat'),
      resolveKeysets: async () => lookup(),
    }),
    'unit_mismatch',
  )
  await expectCode(
    validateTokenImport({
      encodedToken: 'cashuB',
      contextUnit: 'sat',
      decode: () => token(),
      resolveKeysets: async () => lookup([metadata('regular', 'msat')]),
    }),
    'unit_mismatch',
  )
})

test('maps decoder failures and empty proof sets to invalid token errors', async () => {
  await expectCode(
    validateTokenImport({
      encodedToken: 'not-cashu',
      contextUnit: 'sat',
      decode: () => {
        throw new Error('parser details must not become the public classification')
      },
      resolveKeysets: async () => lookup(),
    }),
    'invalid_token',
  )
  await expectCode(
    validateTokenImport({
      encodedToken: 'cashuB',
      contextUnit: 'sat',
      decode: () => token('https://mint.example', 'sat', []),
      resolveKeysets: async () => lookup(),
    }),
    'invalid_token',
  )
})

test('distinguishes stale, network-indeterminate, and unknown keyset resolution', async () => {
  const base = {
    encodedToken: 'cashuB',
    contextUnit: 'sat' as const,
    decode: () => token(),
  }
  await expectCode(
    validateTokenImport({
      ...base,
      resolveKeysets: async () => ({
        freshness: 'stale',
        regularKeysets: [metadata('regular')],
        conditionalKeysets: [],
      }),
    }),
    'stale_keyset_metadata',
  )
  await expectCode(
    validateTokenImport({
      ...base,
      resolveKeysets: async () => {
        throw new Error('offline')
      },
    }),
    'keyset_resolution_indeterminate',
  )
  await expectCode(
    validateTokenImport({ ...base, resolveKeysets: async () => lookup() }),
    'unknown_keyset',
  )
})

test('rejects malformed, unsupported, and spoofed metadata', async () => {
  const invalidResolvers: Array<[ResolveTokenImportKeysets, TokenImportValidationError['code']]> = [
    [async () => lookup([metadata('regular', null as never)]), 'unsupported_unit'],
    [async () => lookup([metadata('regular', 'usd')]), 'unsupported_unit'],
    [async () => lookup([metadata('regular', 'sat', 'true')]), 'spoofed_keyset_metadata'],
    [async () => lookup([metadata('unrequested')]), 'spoofed_keyset_metadata'],
    [async () => lookup([metadata('regular')], [metadata('regular')]), 'spoofed_keyset_metadata'],
  ]
  for (const [resolveKeysets, code] of invalidResolvers) {
    await expectCode(
      validateTokenImport({
        encodedToken: 'cashuB',
        contextUnit: 'sat',
        decode: () => token(),
        resolveKeysets,
      }),
      code,
    )
  }
})

test('bounded property sweep accepts every proof count through a configured boundary', async () => {
  const maxProofs = 32
  for (let count = 1; count <= maxProofs; count += 1) {
    const ids = Array.from({ length: count }, (_, index) => `keyset-${index % 4}`)
    const result = await validateTokenImport({
      encodedToken: `cashuB-${count}`,
      contextUnit: 'sat',
      decode: () => token('https://mint.example', 'sat', ids),
      resolveKeysets: async ({ keysetIds }) => lookup(keysetIds.map((id) => metadata(id))),
      bounds: { maxProofs, maxKeysets: 4 },
    })
    assert.equal(result.proofs.length, count)
  }

  assert.equal(DEFAULT_TOKEN_IMPORT_BOUNDS.maxEncodedBytes, 100 * 1_024)
})
