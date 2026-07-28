import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Amount, getEncodedToken, getEncodedTokenBinary, type Token } from '@cashu/cashu-ts'
import {
  DEFAULT_TOKEN_IMPORT_BOUNDS,
  TokenImportValidationError,
  decodeTokenImportLocally,
  validateProductWalletTokenImport,
  validateTokenImport,
  type ResolveTokenImportKeysets,
  type TokenImportContext,
  type TokenImportKeysetLookup,
} from '../src/tokenImportValidation.ts'

const V0_ID = '00ad268c4d1f5826'
const REGULAR_FULL_ID = `01${'12'.repeat(32)}`
const REGULAR_SHORT_ID = REGULAR_FULL_ID.slice(0, 16)
const CONDITIONAL_FULL_ID = `02${'34'.repeat(32)}`
const CONDITIONAL_SHORT_ID = CONDITIONAL_FULL_ID.slice(0, 16)

function token(
  mint = 'https://mint.example',
  unit = 'sat',
  keysetIds: readonly string[] = [V0_ID],
): Token {
  return {
    mint,
    unit,
    proofs: keysetIds.map((id, index) => ({
      id,
      amount: Amount.from(1),
      secret: `secret-${index}`,
      C: `02${'ab'.repeat(32)}`,
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

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function matchingResolver(
  source: 'regular' | 'conditional' = 'regular',
  fullId = V0_ID,
  unit = 'sat',
  active = true,
): ResolveTokenImportKeysets {
  return async () =>
    source === 'regular'
      ? lookup([metadata(fullId, unit, active)])
      : lookup([], [metadata(fullId, unit, active)])
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
      context: 'ordinary-sat',
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
    context: 'ordinary-sat',
    decode: () => token(),
    resolveKeysets: matchingResolver(),
    bounds: { maxEncodedBytes: 32 },
  })
  assert.equal(result.encodedToken, encodedToken)
})

test('enforces proof, mint, and keyset caps before resolver work', async () => {
  const cases = [
    {
      decoded: token('https://mint.example', 'sat', [V0_ID, V0_ID, V0_ID]),
      bounds: { maxProofs: 2 },
      code: 'proof_limit_exceeded' as const,
    },
    {
      decoded: [token('https://a.example'), token('https://b.example')],
      bounds: { maxMints: 1 },
      code: 'mint_limit_exceeded' as const,
    },
    {
      decoded: token('https://mint.example', 'sat', [V0_ID, REGULAR_FULL_ID]),
      bounds: { maxKeysets: 1 },
      code: 'keyset_limit_exceeded' as const,
    },
  ]
  for (const item of cases) {
    let resolverCalls = 0
    await expectCode(
      validateTokenImport({
        encodedToken: 'cashuA-test-double',
        context: 'ordinary-sat',
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

test('default decoder admits a real cashu-ts v4 token and resolves its short keyset prefix', async () => {
  const encodedToken = getEncodedToken(token('https://mint.example', 'sat', [REGULAR_FULL_ID]))
  const locallyDecoded = decodeTokenImportLocally(encodedToken)
  assert.equal(locallyDecoded.proofs[0]?.id, REGULAR_SHORT_ID)

  const result = await validateTokenImport({
    encodedToken,
    context: 'ordinary-sat',
    resolveKeysets: matchingResolver('regular', REGULAR_FULL_ID),
  })

  assert.equal(result.encodedToken, encodedToken)
  assert.deepEqual(result.proofs[0], {
    tokenIndex: 0,
    proofIndex: 0,
    canonicalMintUrl: 'https://mint.example',
    encodedKeysetId: REGULAR_SHORT_ID,
    resolvedKeysetId: REGULAR_FULL_ID,
    source: 'regular',
    activity: 'active',
  })
})

test('default decoder retains exact IDs in legacy and full-id token forms', async () => {
  const legacyPayload = {
    token: [
      {
        mint: 'https://mint.example',
        proofs: [{ id: V0_ID, amount: 1, secret: 'legacy-secret', C: `02${'ab'.repeat(32)}` }],
      },
    ],
    unit: 'sat',
  }
  const legacy = `cashuA${base64Url(new TextEncoder().encode(JSON.stringify(legacyPayload)))}`
  assert.equal(decodeTokenImportLocally(legacy).proofs[0]?.id, V0_ID)

  const binary = getEncodedTokenBinary(token('https://mint.example', 'sat', [REGULAR_FULL_ID]))
  const fullIdV4 = `cashuB${base64Url(binary.slice(5))}`
  assert.equal(decodeTokenImportLocally(fullIdV4).proofs[0]?.id, REGULAR_FULL_ID)

  const result = await validateTokenImport({
    encodedToken: fullIdV4,
    context: 'ordinary-sat',
    resolveKeysets: matchingResolver('regular', REGULAR_FULL_ID),
  })
  assert.equal(result.proofs[0]?.encodedKeysetId, REGULAR_FULL_ID)
  assert.equal(result.proofs[0]?.resolvedKeysetId, REGULAR_FULL_ID)
})

test('canonicalizes mint identities and groups encoded keyset lookup', async () => {
  const requests: Array<{ canonicalMintUrl: string; encodedKeysetIds: readonly string[] }> = []
  const result = await validateTokenImport({
    encodedToken: 'cashuA-test-double',
    context: 'ordinary-sat',
    decode: () => [
      token('HTTPS://MINT.EXAMPLE:443/path/', 'sat', [REGULAR_SHORT_ID, V0_ID]),
      token('https://mint.example./path', 'sat', [V0_ID]),
    ],
    resolveKeysets: async (request) => {
      requests.push({
        canonicalMintUrl: request.canonicalMintUrl,
        encodedKeysetIds: request.encodedKeysetIds,
      })
      assert.ok(request.deadlineMs > Date.now())
      assert.equal(request.maxCandidates, DEFAULT_TOKEN_IMPORT_BOUNDS.maxResolverCandidates)
      return lookup([metadata(V0_ID), metadata(REGULAR_FULL_ID)])
    },
  })

  assert.deepEqual(result.canonicalMintUrls, ['https://mint.example/path'])
  assert.deepEqual(requests, [
    {
      canonicalMintUrl: 'https://mint.example/path',
      encodedKeysetIds: [REGULAR_SHORT_ID, V0_ID].sort(),
    },
  ])
  assert.equal(result.proofs.length, 3)
})

test('preserves known inactive classification for regular and conditional proofs', async () => {
  const regular = await validateTokenImport({
    encodedToken: 'cashuA-regular-double',
    context: 'ordinary-sat',
    decode: () => token('https://mint.example', 'sat', [V0_ID]),
    resolveKeysets: matchingResolver('regular', V0_ID, 'sat', false),
  })
  const conditional = await validateTokenImport({
    encodedToken: 'cashuA-conditional-double',
    context: 'ctf-position-msat',
    decode: () => token('https://mint.example', 'msat', [CONDITIONAL_SHORT_ID]),
    resolveKeysets: matchingResolver('conditional', CONDITIONAL_FULL_ID, 'msat', false),
  })

  assert.equal(regular.hasInactiveProofs, true)
  assert.equal(regular.proofs[0]?.activity, 'inactive')
  assert.equal(conditional.hasInactiveProofs, true)
  assert.equal(conditional.proofs[0]?.source, 'conditional')
})

test('closed contexts enforce exact token, keyset, and source agreement', async () => {
  const cases: Array<{
    context: TokenImportContext
    decoded: Token
    resolver: ResolveTokenImportKeysets
    code: TokenImportValidationError['code']
  }> = [
    {
      context: 'ordinary-sat',
      decoded: token('https://mint.example', 'SAT'),
      resolver: matchingResolver(),
      code: 'unsupported_unit',
    },
    {
      context: 'ordinary-sat',
      decoded: token('https://mint.example', 'msat'),
      resolver: matchingResolver('regular', V0_ID, 'msat'),
      code: 'unit_mismatch',
    },
    {
      context: 'ordinary-sat',
      decoded: token(),
      resolver: matchingResolver('regular', V0_ID, 'msat'),
      code: 'unit_mismatch',
    },
    {
      context: 'ordinary-sat',
      decoded: token(),
      resolver: matchingResolver('conditional', V0_ID, 'sat'),
      code: 'source_mismatch',
    },
    {
      context: 'ctf-position-msat',
      decoded: token('https://mint.example', 'msat', [CONDITIONAL_SHORT_ID]),
      resolver: matchingResolver('regular', CONDITIONAL_FULL_ID, 'msat'),
      code: 'source_mismatch',
    },
  ]
  for (const item of cases) {
    await expectCode(
      validateTokenImport({
        encodedToken: 'cashuA-test-double',
        context: item.context,
        decode: () => item.decoded,
        resolveKeysets: item.resolver,
      }),
      item.code,
    )
  }

  const collateral = await validateTokenImport({
    encodedToken: 'cashuA-collateral-double',
    context: 'ctf-collateral-msat',
    decode: () => token('https://mint.example', 'msat', [REGULAR_SHORT_ID]),
    resolveKeysets: matchingResolver('regular', REGULAR_FULL_ID, 'msat'),
  })
  assert.equal(collateral.proofs[0]?.source, 'regular')
})

test('product-wallet helper decodes once and derives one closed context from unit and source', async () => {
  const cases = [
    {
      decoded: token('https://mint.example', 'sat', [V0_ID]),
      resolver: matchingResolver('regular', V0_ID, 'sat'),
      context: 'ordinary-sat',
    },
    {
      decoded: token('https://mint.example', 'msat', [CONDITIONAL_SHORT_ID]),
      resolver: matchingResolver('conditional', CONDITIONAL_FULL_ID, 'msat'),
      context: 'ctf-position-msat',
    },
    {
      decoded: token('https://mint.example', 'msat', [REGULAR_SHORT_ID]),
      resolver: matchingResolver('regular', REGULAR_FULL_ID, 'msat'),
      context: 'ctf-collateral-msat',
    },
  ] as const

  for (const item of cases) {
    let decodeCalls = 0
    const result = await validateProductWalletTokenImport({
      encodedToken: 'cashuA-product-wallet-double',
      decode: () => {
        decodeCalls += 1
        return item.decoded
      },
      resolveKeysets: item.resolver,
    })
    assert.equal(result.context, item.context)
    assert.equal(decodeCalls, 1)
  }
})

test('product-wallet helper rejects conditional sat and mixed-source msat imports', async () => {
  await expectCode(
    validateProductWalletTokenImport({
      encodedToken: 'cashuA-conditional-sat-double',
      decode: () => token('https://mint.example', 'sat', [CONDITIONAL_SHORT_ID]),
      resolveKeysets: matchingResolver('conditional', CONDITIONAL_FULL_ID, 'sat'),
    }),
    'source_mismatch',
  )

  await expectCode(
    validateProductWalletTokenImport({
      encodedToken: 'cashuA-mixed-source-double',
      decode: () => token('https://mint.example', 'msat', [REGULAR_SHORT_ID, CONDITIONAL_SHORT_ID]),
      resolveKeysets: async () =>
        lookup([metadata(REGULAR_FULL_ID, 'msat')], [metadata(CONDITIONAL_FULL_ID, 'msat')]),
    }),
    'source_mismatch',
  )
})

test('rejects zero, multiple, and cross-source prefix matches', async () => {
  const secondCollision = `${REGULAR_SHORT_ID}${'ff'.repeat(25)}`
  const base = {
    encodedToken: 'cashuA-prefix-double',
    context: 'ordinary-sat' as const,
    decode: () => token('https://mint.example', 'sat', [REGULAR_SHORT_ID]),
  }
  await expectCode(
    validateTokenImport({ ...base, resolveKeysets: async () => lookup() }),
    'unknown_keyset',
  )
  await expectCode(
    validateTokenImport({
      ...base,
      resolveKeysets: async () => lookup([metadata(REGULAR_FULL_ID), metadata(secondCollision)]),
    }),
    'ambiguous_keyset',
  )
  await expectCode(
    validateTokenImport({
      ...base,
      resolveKeysets: async () => lookup([metadata(REGULAR_FULL_ID)], [metadata(secondCollision)]),
    }),
    'source_mismatch',
  )
})

test('rejects malformed keyset length/case and spoofed resolver candidates', async () => {
  const malformedDecoded = ['01abcd', V0_ID.toUpperCase()]
  for (const id of malformedDecoded) {
    let resolverCalls = 0
    await expectCode(
      validateTokenImport({
        encodedToken: 'cashuA-malformed-double',
        context: 'ordinary-sat',
        decode: () => token('https://mint.example', 'sat', [id]),
        resolveKeysets: async () => {
          resolverCalls += 1
          return lookup()
        },
      }),
      'invalid_token',
    )
    assert.equal(resolverCalls, 0)
  }

  await expectCode(
    validateTokenImport({
      encodedToken: 'cashuA-spoof-double',
      context: 'ordinary-sat',
      decode: () => token('https://mint.example', 'sat', [REGULAR_SHORT_ID]),
      resolveKeysets: async () => lookup([metadata(`${REGULAR_SHORT_ID}${'GG'.repeat(25)}`)]),
    }),
    'spoofed_keyset_metadata',
  )
})

test('rejects insecure and literal private targets before resolver access', async () => {
  const targets = [
    'http://mint.example',
    'http://127.0.0.1:8080',
    'https://127.0.0.1:8443',
    'https://10.0.0.1',
    'https://169.254.1.1',
    'https://[fc00::1]',
    'https://user:password@mint.example',
    'https://mint.example?',
    'https://mint.example#',
  ]
  for (const mintUrl of targets) {
    let resolverCalls = 0
    await assert.rejects(
      validateTokenImport({
        encodedToken: 'cashuA-target-double',
        context: 'ordinary-sat',
        decode: () => token(mintUrl),
        resolveKeysets: async () => {
          resolverCalls += 1
          return lookup()
        },
      }),
      TokenImportValidationError,
    )
    assert.equal(resolverCalls, 0)
  }

  const allowed = await validateTokenImport({
    encodedToken: 'cashuA-loopback-double',
    context: 'ordinary-sat',
    decode: () => token('http://127.0.0.1:8080'),
    allowInsecureLoopbackHttp: true,
    resolveKeysets: matchingResolver(),
  })
  assert.deepEqual(allowed.canonicalMintUrls, ['http://127.0.0.1:8080'])
})

test('resolver timeout and caller cancellation fail closed', async () => {
  const pendingResolver: ResolveTokenImportKeysets = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  await expectCode(
    validateTokenImport({
      encodedToken: 'cashuA-timeout-double',
      context: 'ordinary-sat',
      decode: () => token(),
      resolveKeysets: pendingResolver,
      bounds: { resolverTimeoutMs: 10 },
    }),
    'keyset_resolution_indeterminate',
  )

  const controller = new AbortController()
  let resolverCalls = 0
  controller.abort()
  await expectCode(
    validateTokenImport({
      encodedToken: 'cashuA-cancel-double',
      context: 'ordinary-sat',
      decode: () => token(),
      resolveKeysets: async () => {
        resolverCalls += 1
        return lookup()
      },
      signal: controller.signal,
    }),
    'keyset_resolution_indeterminate',
  )
  assert.equal(resolverCalls, 0)
})

test('distinguishes stale, indeterminate, oversized, and malformed lookup results', async () => {
  const base = {
    encodedToken: 'cashuA-resolution-double',
    context: 'ordinary-sat' as const,
    decode: () => token(),
  }
  await expectCode(
    validateTokenImport({
      ...base,
      resolveKeysets: async () => ({
        freshness: 'stale',
        regularKeysets: [metadata(V0_ID)],
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
    validateTokenImport({
      ...base,
      bounds: { maxResolverCandidates: 1 },
      resolveKeysets: async () => lookup([metadata(V0_ID), metadata(V0_ID)]),
    }),
    'resolver_response_too_large',
  )
  await expectCode(
    validateTokenImport({
      ...base,
      resolveKeysets: async () => lookup([metadata(V0_ID, null as never)]),
    }),
    'unsupported_unit',
  )
  await expectCode(
    validateTokenImport({
      ...base,
      resolveKeysets: async () => lookup([metadata(V0_ID, 'usd')]),
    }),
    'unsupported_unit',
  )
  await expectCode(
    validateTokenImport({
      ...base,
      resolveKeysets: async () => lookup([metadata(V0_ID, 'sat', 'true')]),
    }),
    'spoofed_keyset_metadata',
  )
})

test('bounded property sweep accepts every proof count through a configured boundary', async () => {
  const maxProofs = 32
  for (let count = 1; count <= maxProofs; count += 1) {
    const result = await validateTokenImport({
      encodedToken: `cashuA-${count}`,
      context: 'ordinary-sat',
      decode: () =>
        token(
          'https://mint.example',
          'sat',
          Array.from({ length: count }, () => V0_ID),
        ),
      resolveKeysets: matchingResolver(),
      bounds: { maxProofs },
    })
    assert.equal(result.proofs.length, count)
  }
  assert.equal(DEFAULT_TOKEN_IMPORT_BOUNDS.maxEncodedBytes, 100 * 1_024)
})
