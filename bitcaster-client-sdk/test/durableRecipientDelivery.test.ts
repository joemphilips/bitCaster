import assert from 'node:assert/strict'
import test from 'node:test'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  DURABLE_RECIPIENT_POST_BYTES_MAX,
  DURABLE_RECIPIENT_TOKEN_BYTES_MAX,
  assertDurableRecipientDeliveryStatusAuthority,
  assertDurableRecipientDeliveryPathAuthority,
  decodeDurableRecipientDeliveryStatus,
  decodeDurableRecipientDeliverySubmission,
  deriveDurableRecipientTokenAllowance,
  deriveDurableRecipientTupleFingerprint,
  redactedDurableRecipientDeliveryMetadata,
} from '../src/durableRecipientDelivery.ts'

const token = 'cashuBtransport-only-token'
const digest = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)))

function submission() {
  return {
    schemaVersion: 1,
    deliveryId: '123e4567-e89b-42d3-a456-426614174000',
    accountSubject: 'account-subject-1',
    recipientKind: 'matching-engine',
    purpose: 'market-funding',
    destinationId: 'market-deposit-1',
    productBindingSha256: digest('market-binding'),
    mintUrl: 'https://mint.example',
    unit: 'sat',
    requestedAmount: '21',
    creditPolicy: 'exact-amount',
    tokenSha256: digest(token),
    tokenEncodedLength: new TextEncoder().encode(token).byteLength,
    token,
  }
}

test('roundtrips a strict immutable tuple and stable fingerprint', () => {
  const exact = decodeDurableRecipientDeliverySubmission(submission())
  const fingerprint = deriveDurableRecipientTupleFingerprint(exact)
  assert.equal(exact.mintUrl, 'https://mint.example')
  assert.equal(fingerprint.length, 64)
  assert.equal(fingerprint, 'f6360cf14eba4b3dfc7836b0b9aa6a675c03e766d876f9046bf6bcef597c40cf')
  assertDurableRecipientDeliveryPathAuthority(exact.deliveryId, exact)
  assert.throws(
    () =>
      assertDurableRecipientDeliveryPathAuthority('123e4567-e89b-42d3-a456-426614174001', exact),
    /path/,
  )
  assert.equal(deriveDurableRecipientTupleFingerprint({ ...exact, token: 'foreign' }), fingerprint)
})

test('rejects conflicting tuple authority and unknown submission fields', () => {
  const exact = decodeDurableRecipientDeliverySubmission(submission())
  const pending = decodeDurableRecipientDeliveryStatus({
    delivery: omitToken(exact),
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(exact),
    state: 'pending',
    result: null,
  })
  assert.throws(
    () =>
      assertDurableRecipientDeliveryStatusAuthority({
        expected: { ...exact, destinationId: 'other' },
        status: pending,
      }),
    /conflicts/,
  )
  assert.throws(
    () => decodeDurableRecipientDeliverySubmission({ ...submission(), foreign: true }),
    /foreign/,
  )
  assert.throws(
    () => decodeDurableRecipientDeliveryStatus({ ...pending, foreign: true }),
    /foreign/,
  )
})

test('binds every immutable tuple field to the fingerprint', () => {
  const exact = decodeDurableRecipientDeliverySubmission(submission())
  const pending = decodeDurableRecipientDeliveryStatus({
    delivery: omitToken(exact),
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(exact),
    state: 'pending',
    result: null,
  })
  const changes = {
    schemaVersion: 2,
    deliveryId: '123e4567-e89b-42d3-a456-426614174001',
    accountSubject: 'account-subject-2',
    recipientKind: 'other',
    purpose: 'participation-score',
    destinationId: 'market-deposit-2',
    productBindingSha256: digest('other-binding'),
    mintUrl: 'https://mint.example:8443',
    unit: 'msat',
    requestedAmount: '22',
    creditPolicy: 'net-of-receive-fee',
    tokenSha256: digest('other-token'),
    tokenEncodedLength: token.length - 1,
  }
  for (const [field, change] of Object.entries(changes)) {
    assert.throws(
      () =>
        assertDurableRecipientDeliveryStatusAuthority({
          expected: { ...exact, [field]: change },
          status: pending,
        }),
      /conflicts|invalid|unsupported/,
      field,
    )
  }
})

test('requires receive authority, credit policy, amounts, and terminal business-event authority', () => {
  const exact = decodeDurableRecipientDeliverySubmission(submission())
  const status = (state: string, result: unknown) => ({
    delivery: omitToken(exact),
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(exact),
    state,
    result,
  })
  const received = {
    creditedAmount: '21',
    receiveFee: '0',
    creditVerification: 'exact-amount',
    receiveOperationId: 'receive-1',
    receivedAt: '2026-08-10T00:00:00.000Z',
  }
  assert.equal(decodeDurableRecipientDeliveryStatus(status('received', received)).state, 'received')
  assert.throws(
    () => decodeDurableRecipientDeliveryStatus(status('received', null)),
    /lacks receive authority/,
  )
  assert.throws(
    () => decodeDurableRecipientDeliveryStatus(status('credited', received)),
    /terminal authority/,
  )
  assert.equal(
    decodeDurableRecipientDeliveryStatus(
      status('credited', {
        ...received,
        businessEventId: 'event-1',
        businessEventAt: '2026-08-10T00:01:00.000Z',
      }),
    ).state,
    'credited',
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryStatus(
        status('received', {
          ...received,
          businessEventId: 'event-1',
          businessEventAt: received.receivedAt,
        }),
      ),
    /terminal authority/,
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryStatus(
        status('received', { ...received, businessEventId: 'event-1' }),
      ),
    /business event/,
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryStatus(
        status('received', { ...received, creditVerification: 'net-of-receive-fee' }),
      ),
    /policy/,
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryStatus(
        status('received', { ...received, creditedAmount: '20' }),
      ),
    /amount/,
  )
  assert.equal(
    decodeDurableRecipientDeliveryStatus(status('received', { ...received, receiveFee: '1' }))
      .state,
    'received',
  )
  const net = decodeDurableRecipientDeliverySubmission({
    ...submission(),
    creditPolicy: 'net-of-receive-fee',
  })
  assert.equal(
    decodeDurableRecipientDeliveryStatus({
      delivery: omitToken(net),
      tupleFingerprint: deriveDurableRecipientTupleFingerprint(net),
      state: 'received',
      result: {
        ...received,
        creditedAmount: '20',
        receiveFee: '1',
        creditVerification: 'net-of-receive-fee',
      },
    }).state,
    'received',
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryStatus({
        delivery: omitToken(net),
        tupleFingerprint: deriveDurableRecipientTupleFingerprint(net),
        state: 'received',
        result: {
          ...received,
          creditedAmount: '20',
          receiveFee: '0',
          creditVerification: 'net-of-receive-fee',
        },
      }),
    /amount/,
  )
})

test('enforces identifiers, mint normalization, enums, signed 64-bit amounts, and token authority', () => {
  const exact = decodeDurableRecipientDeliverySubmission(submission())
  assert.equal(
    decodeDurableRecipientDeliverySubmission({
      ...submission(),
      mintUrl: 'https://mint.example:8443',
    }).mintUrl,
    'https://mint.example:8443',
  )
  for (const unit of ['sat', 'msat']) {
    assert.equal(decodeDurableRecipientDeliverySubmission({ ...submission(), unit }).unit, unit)
  }
  for (const mintUrl of [
    'https://mint.example/',
    'https://mint.example:443',
    'http://mint.example:80',
    'https://user@mint.example',
    'https://mint.example/path',
    'https://mint.example?query=1',
  ]) {
    assert.throws(
      () => decodeDurableRecipientDeliverySubmission({ ...submission(), mintUrl }),
      /mint URL/,
    )
  }
  for (const patch of [
    { deliveryId: '123E4567-e89b-42d3-a456-426614174000' },
    { accountSubject: 'subject with space' },
    { destinationId: 'destination\0id' },
    { unit: 'btc' },
    { purpose: 'withdrawal' },
    { creditPolicy: 'other' },
  ]) {
    assert.throws(
      () => decodeDurableRecipientDeliverySubmission({ ...submission(), ...patch }),
      /invalid|schema/,
    )
  }
  assert.throws(
    () => decodeDurableRecipientDeliverySubmission({ ...submission(), requestedAmount: '0' }),
    /amount/,
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliverySubmission({
        ...submission(),
        requestedAmount: '9223372036854775808',
      }),
    /amount/,
  )
  assert.throws(
    () => decodeDurableRecipientDeliverySubmission({ ...submission(), tokenEncodedLength: 65_537 }),
    /token/,
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliverySubmission({
        ...submission(),
        tokenEncodedLength: token.length + 1,
      }),
    /authority/,
  )
  assert.throws(
    () => decodeDurableRecipientDeliverySubmission({ ...submission(), token: 'cashuAwrong' }),
    /token/,
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliverySubmission({
        ...submission(),
        tokenSha256: digest('different'),
      }),
    /authority/,
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryStatus({
        delivery: omitToken(exact),
        tupleFingerprint: deriveDurableRecipientTupleFingerprint(exact),
        state: 'received',
        result: {
          creditedAmount: '9223372036854775808',
          receiveFee: '0',
          creditVerification: 'exact-amount',
          receiveOperationId: 'receive-1',
          receivedAt: '2026-08-10T00:00:00.000Z',
        },
      }),
    /amount/,
  )
  assert.throws(
    () =>
      decodeDurableRecipientDeliveryStatus({
        delivery: omitToken(exact),
        tupleFingerprint: deriveDurableRecipientTupleFingerprint(exact),
        state: 'received',
        result: {
          creditedAmount: '21',
          receiveFee: '0',
          creditVerification: 'exact-amount',
          receiveOperationId: 'receive-1',
          receivedAt: '2026-08-10 00:00:00Z',
        },
      }),
    /received time/,
  )
  const maximum = decodeDurableRecipientDeliverySubmission({
    ...submission(),
    requestedAmount: '9223372036854775807',
  })
  assert.equal(
    decodeDurableRecipientDeliveryStatus({
      delivery: omitToken(maximum),
      tupleFingerprint: deriveDurableRecipientTupleFingerprint(maximum),
      state: 'received',
      result: {
        creditedAmount: '9223372036854775807',
        receiveFee: '0',
        creditVerification: 'exact-amount',
        receiveOperationId: 'receive-1',
        receivedAt: '2026-08-10T00:00:00.000Z',
      },
    }).state,
    'received',
  )
})

test('calculates a pre-mint token allowance that fits the exact JSON body', () => {
  const base = decodeDurableRecipientDeliverySubmission(submission())
  const allowanceInput = preMintMetadata(base)
  const allowance = deriveDurableRecipientTokenAllowance(allowanceInput)
  assert.equal(allowance, DURABLE_RECIPIENT_TOKEN_BYTES_MAX)
  const maximumToken = `cashuB${'A'.repeat(allowance - 'cashuB'.length)}`
  const maximum = {
    ...base,
    token: maximumToken,
    tokenEncodedLength: allowance,
    tokenSha256: digest(maximumToken),
  }
  assert.equal(
    new TextEncoder().encode(JSON.stringify(maximum)).byteLength <=
      DURABLE_RECIPIENT_POST_BYTES_MAX,
    true,
  )
  assert.equal(decodeDurableRecipientDeliverySubmission(maximum).tokenEncodedLength, allowance)
  const oneCharacterTooLong = `${maximumToken}A`
  assert.throws(
    () =>
      decodeDurableRecipientDeliverySubmission({
        ...maximum,
        token: oneCharacterTooLong,
        tokenEncodedLength: oneCharacterTooLong.length,
        tokenSha256: digest(oneCharacterTooLong),
      }),
    /token|body/,
  )
})

test('validates maximum pre-mint metadata before mint I/O', () => {
  const base = decodeDurableRecipientDeliverySubmission(submission())
  const mintUrl = `https://${[...Array(7).fill('a'.repeat(62)), 'b'.repeat(63)].join('.')}`
  assert.equal(mintUrl.length, 512)
  const metadata = {
    ...preMintMetadata(base),
    accountSubject: 's'.repeat(256),
    destinationId: 'd'.repeat(1024),
    mintUrl,
  }
  const allowance = deriveDurableRecipientTokenAllowance(metadata)
  const maximumToken = `cashuB${'A'.repeat(allowance - 'cashuB'.length)}`
  const body = {
    ...metadata,
    token: maximumToken,
    tokenEncodedLength: maximumToken.length,
    tokenSha256: digest(maximumToken),
  }
  assert.equal(
    new TextEncoder().encode(JSON.stringify(body)).byteLength <= DURABLE_RECIPIENT_POST_BYTES_MAX,
    true,
  )
  assert.equal(decodeDurableRecipientDeliverySubmission(body).tokenEncodedLength, allowance)
  assert.throws(
    () => deriveDurableRecipientTokenAllowance({ ...metadata, mintUrl: `${mintUrl}/` }),
    /mint URL/,
  )
  assert.throws(
    () =>
      deriveDurableRecipientTokenAllowance({
        ...metadata,
        destinationId: `${metadata.destinationId}d`,
      }),
    /destination id/,
  )
})

test('does not serialize bearer tokens in errors, statuses, or redacted metadata', () => {
  const secretToken = 'cashuBnever-serialize-this-bearer-token'
  let failure: unknown
  try {
    decodeDurableRecipientDeliverySubmission({
      ...submission(),
      token: secretToken,
      tokenEncodedLength: secretToken.length,
      tokenSha256: digest('different-token'),
    })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error)
  assert.equal(failure.message.includes(secretToken), false)
  assert.equal(JSON.stringify(failure).includes(secretToken), false)

  const exact = decodeDurableRecipientDeliverySubmission({
    ...submission(),
    token: secretToken,
    tokenEncodedLength: secretToken.length,
    tokenSha256: digest(secretToken),
  })
  const status = decodeDurableRecipientDeliveryStatus({
    delivery: omitToken(exact),
    tupleFingerprint: deriveDurableRecipientTupleFingerprint(exact),
    state: 'pending',
    result: null,
  })
  assert.equal(JSON.stringify(status).includes(secretToken), false)
  assert.equal(
    JSON.stringify(redactedDurableRecipientDeliveryMetadata(exact)).includes(secretToken),
    false,
  )
})

function omitToken(input: ReturnType<typeof decodeDurableRecipientDeliverySubmission>) {
  const { token: _token, ...tuple } = input
  return tuple
}

function preMintMetadata(input: ReturnType<typeof decodeDurableRecipientDeliverySubmission>) {
  const { token: _token, tokenEncodedLength: _length, tokenSha256: _digest, ...metadata } = input
  return metadata
}
