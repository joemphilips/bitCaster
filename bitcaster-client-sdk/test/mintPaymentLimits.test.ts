import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MintOperationError, type RequestFn } from '@cashu/cashu-ts'
import {
  bolt11InvoiceAmountMsat,
  checkMintPaymentAmount,
  classifyMintAmountRefusal,
  describeMintPaymentAmountRejection,
  isMintAmountOutsideLimitError,
  MINT_AMOUNT_OUTSIDE_LIMIT_ERROR_CODE,
  mintPaymentMaximumMsat,
  parseMintPaymentLimits,
  type MintPaymentSelection,
} from '../src/mintPaymentLimits.ts'
import { readPublicMintInfo } from '../src/mintMetadata.ts'

const DEPOSIT_MSAT: MintPaymentSelection = { direction: 'deposit', method: 'bolt11', unit: 'msat' }
const DEPOSIT_SAT: MintPaymentSelection = { direction: 'deposit', method: 'bolt11', unit: 'sat' }
const WITHDRAWAL_MSAT: MintPaymentSelection = {
  direction: 'withdrawal',
  method: 'bolt11',
  unit: 'msat',
}

/** The NUT-04 and NUT-05 sections that the production mint advertises. */
function productionInfo(): Record<string, unknown> {
  return {
    name: 'bitCaster mint',
    pubkey: '02'.padEnd(66, 'a'),
    version: 'cdk-mintd/0.13',
    contact: [],
    nuts: {
      '4': {
        methods: [
          {
            method: 'bolt11',
            unit: 'msat',
            min_amount: 1000,
            max_amount: 200000000,
            options: { description: true },
          },
        ],
        disabled: false,
      },
      '5': {
        methods: [
          {
            method: 'bolt11',
            unit: 'msat',
            min_amount: 1000,
            max_amount: 150000000,
            options: { amountless: false },
          },
        ],
        disabled: false,
      },
    },
  }
}

function infoWithDeposit(methods: unknown[], disabled: unknown = false): Record<string, unknown> {
  return { nuts: { '4': { methods, disabled }, '5': { methods: [], disabled: false } } }
}

test('production deposit limits convert from msat to whole sats', () => {
  assert.deepEqual(parseMintPaymentLimits(productionInfo(), DEPOSIT_MSAT), {
    state: 'enabled',
    minSat: 1,
    maxSat: 200_000,
  })
})

test('withdrawal limits come from NUT-05, not NUT-04', () => {
  assert.deepEqual(parseMintPaymentLimits(productionInfo(), WITHDRAWAL_MSAT), {
    state: 'enabled',
    minSat: 1,
    maxSat: 150_000,
  })
})

test('msat limits accept the minimum and the maximum and refuse one msat outside', () => {
  const limits = parseMintPaymentLimits(productionInfo(), DEPOSIT_MSAT)
  assert.deepEqual(checkMintPaymentAmount(limits, 999), {
    kind: 'below-minimum',
    minSat: 1,
    maxSat: 200_000,
  })
  assert.deepEqual(checkMintPaymentAmount(limits, 1_000), { kind: 'within-limits' })
  assert.deepEqual(checkMintPaymentAmount(limits, 200_000_000), { kind: 'within-limits' })
  assert.deepEqual(checkMintPaymentAmount(limits, 200_000_001), {
    kind: 'above-maximum',
    minSat: 1,
    maxSat: 200_000,
  })
})

test('sat limits apply without conversion at whole-sat and msat boundaries', () => {
  const limits = parseMintPaymentLimits(
    infoWithDeposit([{ method: 'bolt11', unit: 'sat', min_amount: 10, max_amount: 200_000 }]),
    DEPOSIT_SAT,
  )
  assert.deepEqual(limits, { state: 'enabled', minSat: 10, maxSat: 200_000 })
  assert.equal(checkMintPaymentAmount(limits, 9_000).kind, 'below-minimum')
  assert.equal(checkMintPaymentAmount(limits, 9_999).kind, 'below-minimum')
  assert.equal(checkMintPaymentAmount(limits, 10_000).kind, 'within-limits')
  assert.equal(checkMintPaymentAmount(limits, 200_000_000).kind, 'within-limits')
  assert.equal(checkMintPaymentAmount(limits, 200_000_001).kind, 'above-maximum')
  assert.equal(checkMintPaymentAmount(limits, 200_001_000).kind, 'above-maximum')
})

test('msat limits that are not whole sats narrow to the whole sats inside them', () => {
  const limits = parseMintPaymentLimits(
    infoWithDeposit([
      { method: 'bolt11', unit: 'msat', min_amount: 1_500, max_amount: 200_000_999 },
    ]),
    DEPOSIT_MSAT,
  )
  assert.deepEqual(limits, { state: 'enabled', minSat: 2, maxSat: 200_000 })
  assert.equal(checkMintPaymentAmount(limits, 1_999).kind, 'below-minimum')
  assert.equal(checkMintPaymentAmount(limits, 2_000).kind, 'within-limits')
  assert.equal(checkMintPaymentAmount(limits, 200_000_000).kind, 'within-limits')
  assert.equal(checkMintPaymentAmount(limits, 200_000_001).kind, 'above-maximum')
  assert.equal(mintPaymentMaximumMsat(limits), 200_000_000)
})

test('the setting for the requested method and unit is selected', () => {
  const info = infoWithDeposit([
    { method: 'bolt12', unit: 'msat', min_amount: 1, max_amount: 5 },
    { method: 'bolt11', unit: 'sat', min_amount: 7, max_amount: 70 },
    { method: 'bolt11', unit: 'msat', min_amount: 3_000, max_amount: 9_000_000 },
  ])
  assert.deepEqual(parseMintPaymentLimits(info, DEPOSIT_MSAT), {
    state: 'enabled',
    minSat: 3,
    maxSat: 9_000,
  })
  assert.deepEqual(parseMintPaymentLimits(info, DEPOSIT_SAT), {
    state: 'enabled',
    minSat: 7,
    maxSat: 70,
  })
})

test('a missing limit sets no client bound', () => {
  for (const setting of [
    { method: 'bolt11', unit: 'msat', min_amount: null, max_amount: null },
    { method: 'bolt11', unit: 'msat' },
    { method: 'bolt11', unit: 'msat', min_amount: 0 },
  ]) {
    const limits = parseMintPaymentLimits(infoWithDeposit([setting]), DEPOSIT_MSAT)
    assert.deepEqual(limits, { state: 'enabled', minSat: null, maxSat: null })
    assert.equal(checkMintPaymentAmount(limits, 1).kind, 'within-limits')
    assert.equal(checkMintPaymentAmount(limits, Number.MAX_SAFE_INTEGER).kind, 'within-limits')
    assert.equal(mintPaymentMaximumMsat(limits), null)
  }
  const onlyMaximum = parseMintPaymentLimits(
    infoWithDeposit([{ method: 'bolt11', unit: 'msat', max_amount: 5_000 }]),
    DEPOSIT_MSAT,
  )
  assert.deepEqual(checkMintPaymentAmount(onlyMaximum, 1), { kind: 'within-limits' })
  assert.deepEqual(checkMintPaymentAmount(onlyMaximum, 5_001), {
    kind: 'above-maximum',
    minSat: null,
    maxSat: 5,
  })
})

test('limits encoded as large-integer JSON values parse exactly', () => {
  const limits = parseMintPaymentLimits(
    infoWithDeposit([
      { method: 'bolt11', unit: 'msat', min_amount: 1_000n, max_amount: 200_000_000n },
    ]),
    DEPOSIT_MSAT,
  )
  assert.deepEqual(limits, { state: 'enabled', minSat: 1, maxSat: 200_000 })
})

test('a disabled section refuses every amount', () => {
  const limits = parseMintPaymentLimits(
    infoWithDeposit([{ method: 'bolt11', unit: 'msat', min_amount: 1_000 }], true),
    DEPOSIT_MSAT,
  )
  assert.deepEqual(limits, { state: 'disabled' })
  assert.deepEqual(checkMintPaymentAmount(limits, 5_000), { kind: 'not-accepted' })
  assert.equal(mintPaymentMaximumMsat(limits), null)
})

test('a method and unit pair that the mint does not offer refuses every amount', () => {
  const limits = parseMintPaymentLimits(
    infoWithDeposit([{ method: 'bolt11', unit: 'sat', max_amount: 10 }]),
    DEPOSIT_MSAT,
  )
  assert.deepEqual(limits, { state: 'unsupported' })
  assert.deepEqual(checkMintPaymentAmount(limits, 5_000), { kind: 'not-accepted' })
})

test('malformed settings are refused instead of guessed', () => {
  const malformed: unknown[] = [
    null,
    {},
    { nuts: {} },
    { nuts: { '4': [] } },
    infoWithDeposit([], 'false'),
    { nuts: { '4': { disabled: false } } },
    infoWithDeposit([{ method: 'bolt11', unit: 'msat', min_amount: -1 }]),
    infoWithDeposit([{ method: 'bolt11', unit: 'msat', max_amount: 1.5 }]),
    infoWithDeposit([{ method: 'bolt11', unit: 'msat', max_amount: '200000000' }]),
    infoWithDeposit([{ method: 'bolt11', unit: 'msat', max_amount: 2n ** 60n }]),
    infoWithDeposit([{ method: 'bolt11', unit: 'msat', min_amount: 5_000, max_amount: 4_000 }]),
    infoWithDeposit([{ method: 'bolt11', unit: 'msat', min_amount: 1_200, max_amount: 1_800 }]),
    infoWithDeposit([
      { method: 'bolt11', unit: 'msat', max_amount: 1_000 },
      { method: 'bolt11', unit: 'msat', max_amount: 2_000 },
    ]),
  ]
  for (const info of malformed) {
    assert.throws(() => parseMintPaymentLimits(info, DEPOSIT_MSAT), /mint/)
  }
})

test('an amount check needs a positive safe msat amount', () => {
  const limits = parseMintPaymentLimits(productionInfo(), DEPOSIT_MSAT)
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(() => checkMintPaymentAmount(limits, amount), /amount/)
  }
})

test('a mint refusal with NUT error 11006 is recognized', () => {
  assert.equal(MINT_AMOUNT_OUTSIDE_LIMIT_ERROR_CODE, 11006)
  assert.equal(
    isMintAmountOutsideLimitError(
      new MintOperationError(11006, 'Amount must be between `1000` and `200000000` is `300000000`'),
    ),
    true,
  )
  assert.equal(isMintAmountOutsideLimitError(new MintOperationError(11013, 'unit')), false)
  assert.equal(isMintAmountOutsideLimitError(new Error('Amount outside of limit range')), false)
  assert.equal(isMintAmountOutsideLimitError({ code: 11006 }), false)
})

test('a refusal is explained by fresh limits when they place the amount outside', () => {
  const limits = parseMintPaymentLimits(productionInfo(), DEPOSIT_MSAT)
  assert.deepEqual(classifyMintAmountRefusal(limits, 300_000_000), {
    kind: 'above-maximum',
    minSat: 1,
    maxSat: 200_000,
  })
  assert.deepEqual(classifyMintAmountRefusal(limits, 5_000), { kind: 'refused' })
  assert.deepEqual(classifyMintAmountRefusal(null, 300_000_000), { kind: 'refused' })
  assert.deepEqual(classifyMintAmountRefusal(limits, null), { kind: 'refused' })
})

test('English rejection text states the limit and the next action', () => {
  assert.equal(
    describeMintPaymentAmountRejection('deposit', {
      kind: 'above-maximum',
      minSat: 1,
      maxSat: 200_000,
    }),
    'This mint accepts 1 to 200,000 sats for each deposit. Deposit in parts.',
  )
  assert.equal(
    describeMintPaymentAmountRejection('withdrawal', {
      kind: 'above-maximum',
      minSat: null,
      maxSat: 150_000,
    }),
    'This mint accepts up to 150,000 sats for each withdrawal. Withdraw in parts.',
  )
  assert.equal(
    describeMintPaymentAmountRejection('deposit', {
      kind: 'below-minimum',
      minSat: 10,
      maxSat: 200_000,
    }),
    'This mint accepts 10 to 200,000 sats for each deposit.',
  )
  assert.equal(
    describeMintPaymentAmountRejection('withdrawal', {
      kind: 'below-minimum',
      minSat: 10,
      maxSat: null,
    }),
    'This mint accepts at least 10 sats for each withdrawal.',
  )
  assert.equal(
    describeMintPaymentAmountRejection('deposit', { kind: 'not-accepted' }),
    'This mint does not accept Lightning deposits.',
  )
  assert.equal(
    describeMintPaymentAmountRejection('withdrawal', { kind: 'refused' }),
    'This mint does not accept this withdrawal amount.',
  )
})

test('BOLT11 invoice amounts are read from the human-readable part', () => {
  // Real invoices from the cdk and cashu-ts test suites.
  assert.equal(
    bolt11InvoiceAmountMsat(
      'lnbc100n1p5z3a63pp56854ytysg7e5z9fl3w5mgvrlqjfcytnjv8ff5hm5qt6gl6alxesqdqqcqzzsxqyz5vqsp5p0x0dlhn27s63j4emxnk26p7f94u0lyarnfp5yqmac9gzy4ngdss9qxpqysgqne3v0hnzt2lp0hc69xpzckk0cdcar7glvjhq60lsrfe8gejdm8c564prrnsft6ctxxyrewp4jtezrq3gxxqnfjj0f9tw2qs9y0lslmqpfu7et9',
    ),
    10_000,
  )
  assert.equal(
    bolt11InvoiceAmountMsat(
      'lnbc20u1p3u27nppp5pm074ffk6m42lvae8c6847z7xuvhyknwgkk7pzdce47grf2ksqwsdpv2phhwetjv4jzqcneypqyc6t8dp6xu6twva2xjuzzda6qcqzpgxqyz5vqsp5sw6n7cztudpl5m5jv3z6dtqpt2zhd3q6dwgftey9qxv09w82rgjq9qyyssqhtfl8wv7scwp5flqvmgjjh20nf6utvv5daw5h43h69yqfwjch7wnra3cn94qkscgewa33wvfh7guz76rzsfg9pwlk8mqd27wavf2udsq3yeuju',
    ),
    2_000_000,
  )
  assert.equal(
    bolt11InvoiceAmountMsat(
      'lnbc9678785340p1pwmna7lpp5gc3xfm08u9qy06djf8dfflhugl6p7lgza6dsjxq454gxhj9t7a0sd8dgfkx7cmtwd68yetpd5s9xar0wfjn5gpc8qhrsdfq24f5ggrxdaezqsnvda3kkum5wfjkzmfqf3jkgem9wgsyuctwdus9xgrcyqcjcgpzgfskx6eqf9hzqnteypzxz7fzypfhg6trddjhygrcyqezcgpzfysywmm5ypxxjemgw3hxjmn8yptk7untd9hxwg3q2d6xjcmtv4ezq7pqxgsxzmnyyqcjqmt0wfjjq6t5v4khxsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsxqyjw5qcqp2rzjq0gxwkzc8w6323m55m4jyxcjwmy7stt9hwkwe2qxmy8zpsgg7jcuwz87fcqqeuqqqyqqqqlgqqqqn3qq9q9qrsgqrvgkpnmps664wgkp43l22qsgdw4ve24aca4nymnxddlnp8vh9v2sdxlu5ywdxefsfvm0fq3sesf08uf6q9a2ke0hc9j6z6wlxg5z5kqpu2v9wz',
    ),
    967_878_534,
  )
  assert.equal(
    bolt11InvoiceAmountMsat(
      'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql',
    ),
    null,
  )
  assert.equal(bolt11InvoiceAmountMsat('lnbc2500u1pfake'), 250_000_000)
  assert.equal(bolt11InvoiceAmountMsat('lnbc2m1pfake'), 200_000_000)
  assert.equal(bolt11InvoiceAmountMsat('lnbc21pfake'), 200_000_000_000)
  assert.equal(bolt11InvoiceAmountMsat('lntbs10u1pfake'), 1_000_000)
  assert.equal(bolt11InvoiceAmountMsat('lnbcrt500n1pfake'), 50_000)
  assert.equal(bolt11InvoiceAmountMsat('LNBC20U1PFAKE'), 2_000_000)
  for (const invoice of [
    'lnbc2501p1pfake',
    'lnbc0500u1pfake',
    'lnbc01pfake',
    'lnbc20u',
    'notaninvoice',
    '',
    `lnbc${'9'.repeat(40)}1pfake`,
  ]) {
    assert.throws(() => bolt11InvoiceAmountMsat(invoice), /BOLT11/)
  }
})

test('public mint info is read without wallet state', async () => {
  const requested: string[] = []
  const request: RequestFn = async <T>({ endpoint }: Parameters<RequestFn>[0]) => {
    requested.push(endpoint)
    return productionInfo() as T
  }
  const info = await readPublicMintInfo('https://mint.example/', { request })
  assert.deepEqual(requested, ['https://mint.example/v1/info'])
  assert.deepEqual(parseMintPaymentLimits(info, DEPOSIT_MSAT), {
    state: 'enabled',
    minSat: 1,
    maxSat: 200_000,
  })
})
