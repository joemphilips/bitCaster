import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RequestFn } from '@cashu/cashu-ts'
import { assertMintSupportsMsat, readPublicMintMetadata } from '../src/mintMetadata.ts'

const MINT_URL = 'https://mint.example'

test('product mint capability needs active regular v2 msat and permits other units', () => {
  const supported = { id: `01${'ab'.repeat(32)}`, unit: 'msat', active: true, input_fee_ppk: 0 }
  assert.doesNotThrow(() =>
    assertMintSupportsMsat({ keysets: [supported, { ...supported, unit: 'sat' }] }),
  )
  for (const keyset of [
    { ...supported, unit: 'sat' },
    { ...supported, active: false },
    { ...supported, condition_id: 'condition' },
    { ...supported, id: `02${'ab'.repeat(32)}` },
    { ...supported, id: `00${'ab'.repeat(7)}` },
    { ...supported, id: 'invalid' },
  ]) {
    assert.throws(() => assertMintSupportsMsat({ keysets: [keyset] }), /active regular.*msat/)
  }
  assert.throws(() => assertMintSupportsMsat({ keysets: [] }), /active regular.*msat/)
})

test('public mint metadata preserves info, all keysets, fees, and all public keys', async () => {
  const responses: Record<string, unknown> = {
    [`${MINT_URL}/v1/info`]: {
      name: 'Example mint',
      pubkey: 'ab'.repeat(32),
      version: '2.0',
      description: 'Short description',
      description_long: 'Long description',
      motd: 'Notice',
      contact: [{ method: 'email', info: 'ops@example.test' }],
      nuts: {
        '4': {
          methods: [{ method: 'bolt11', unit: 'sat', min_amount: null, max_amount: 1000 }],
          disabled: false,
        },
        '5': { methods: [], disabled: true },
        '7': { supported: false },
      },
    },
    [`${MINT_URL}/v1/keysets`]: {
      keysets: [
        { id: 'active-sat', unit: 'sat', active: true, input_fee_ppk: 1234 },
        { id: 'old-msat', unit: 'msat', active: false, input_fee_ppk: 0, final_expiry: 900 },
      ],
    },
    [`${MINT_URL}/v1/keys`]: {
      keysets: [
        {
          id: 'active-sat',
          unit: 'sat',
          active: true,
          input_fee_ppk: 1234,
          keys: { '1': 'sat-key' },
        },
        {
          id: 'active-msat',
          unit: 'msat',
          active: true,
          input_fee_ppk: 17,
          keys: { '1': 'msat-key' },
        },
      ],
    },
  }
  const requested: string[] = []
  const request: RequestFn = async <T>({ endpoint }: Parameters<RequestFn>[0]) => {
    requested.push(endpoint)
    const response = responses[endpoint]
    assert.notEqual(response, undefined, `unexpected mint request: ${endpoint}`)
    return response as T
  }

  const metadata = await readPublicMintMetadata(`${MINT_URL}/`, { request })

  assert.deepEqual(requested.sort(), [
    `${MINT_URL}/v1/info`,
    `${MINT_URL}/v1/keys`,
    `${MINT_URL}/v1/keysets`,
  ])
  assert.equal(metadata.mintUrl, MINT_URL)
  assert.equal(metadata.info.description_long, 'Long description')
  assert.equal(metadata.info.motd, 'Notice')
  assert.deepEqual(metadata.info.contact, [{ method: 'email', info: 'ops@example.test' }])
  assert.equal(metadata.info.nuts['4'].methods[0]?.min_amount, null)
  assert.deepEqual(metadata.keysets, [
    { id: 'active-sat', unit: 'sat', active: true, input_fee_ppk: 1234, final_expiry: undefined },
    { id: 'old-msat', unit: 'msat', active: false, input_fee_ppk: 0, final_expiry: 900 },
  ])
  assert.deepEqual(metadata.keys, [
    {
      id: 'active-sat',
      unit: 'sat',
      active: true,
      input_fee_ppk: 1234,
      final_expiry: undefined,
      keys: { '1': 'sat-key' },
    },
    {
      id: 'active-msat',
      unit: 'msat',
      active: true,
      input_fee_ppk: 17,
      final_expiry: undefined,
      keys: { '1': 'msat-key' },
    },
  ])
})

test('public mint metadata propagates a failed read instead of returning partial metadata', async () => {
  const request: RequestFn = async <T>({ endpoint }: Parameters<RequestFn>[0]) => {
    if (endpoint.endsWith('/v1/keys')) throw new Error('mint keys read failed')
    if (endpoint.endsWith('/v1/keysets')) return { keysets: [] } as T
    return {
      name: 'Example mint',
      pubkey: 'ab'.repeat(32),
      version: '2.0',
      contact: [],
      nuts: {
        '4': { methods: [], disabled: false },
        '5': { methods: [], disabled: false },
      },
    } as T
  }

  await assert.rejects(readPublicMintMetadata(MINT_URL, { request }), /mint keys read failed/)
})
