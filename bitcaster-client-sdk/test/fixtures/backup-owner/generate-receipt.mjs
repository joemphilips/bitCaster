// Independent byte-layout oracle: no SDK or CBOR-library imports.
import { createHash, hkdfSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { schnorr } from '@noble/curves/secp256k1.js'
const hex = (b) => Buffer.from(b).toString('hex')
const hash = (b) => createHash('sha256').update(b).digest()
const text = (s) => Buffer.from(s, 'utf8')
function header(major, n) {
  if (n < 24) return Buffer.from([major * 32 + Number(n)])
  for (const [tag, width] of [
    [24, 1],
    [25, 2],
    [26, 4],
    [27, 8],
  ])
    if (BigInt(n) < 1n << BigInt(width * 8)) {
      const b = Buffer.alloc(width + 1)
      b[0] = major * 32 + tag
      let x = BigInt(n)
      for (let i = width; i > 0; i--) {
        b[i] = Number(x & 255n)
        x >>= 8n
      }
      return b
    }
  throw Error('range')
}
function cbor(v) {
  if (v === null) return Buffer.from([246])
  if (typeof v === 'number' || typeof v === 'bigint') return header(0, v)
  if (typeof v === 'string') {
    const b = text(v)
    return Buffer.concat([header(3, b.length), b])
  }
  if (v instanceof Uint8Array) return Buffer.concat([header(2, v.length), v])
  if (Array.isArray(v)) return Buffer.concat([header(4, v.length), ...v.map(cbor)])
  throw Error('type')
}
const seed = Buffer.from(Array.from({ length: 64 }, (_, i) => i)),
  realm = 'backup.production'
const salt = text('bitcaster/encrypted-wallet-backup/hkdf-salt/v2')
const derive = (key, info) => Buffer.from(hkdfSync('sha256', key, salt, cbor(info), 32))
const root = derive(seed, [2, 'request-auth-root', realm])
const requestKey = derive(root, [2, 'request-auth-scalar', realm, 0])
const requestPublicKey = schnorr.getPublicKey(requestKey)
const wallet = hash(Buffer.concat([text('bitcaster/durable-custody-wallet-id/v1\0'), seed]))
const ownerA = hex(hash(cbor([1, 'backup-owner-scope', 'test', 'Alice'])))
const ownerB = hex(hash(cbor([1, 'backup-owner-scope', 'test', 'Bob'])))
const id = (n, bytes) => Buffer.from(n.toString(16).padStart(bytes * 2, '0'), 'hex')
const descriptor = [
  2,
  realm,
  wallet,
  id(1, 16),
  id(17, 32),
  1n,
  1n,
  id(33, 32),
  [[id(49, 16), id(65, 32)]],
]
const descriptorBytes = cbor(descriptor)
const descriptorDigest = hash(
  Buffer.concat([text('bitcaster/encrypted-wallet-backup-v2-descriptor/v1\0'), descriptorBytes]),
)
const signer = Buffer.alloc(32, 0x33),
  signingKeyId = Buffer.alloc(16, 0x44)
function receiptCase(owner) {
  const scope = Buffer.from(owner, 'hex')
  const active = (pairs) =>
    hash(
      Buffer.concat([
        text('bitcaster/encrypted-wallet-backup-v2-active-set/v2\0'),
        cbor([3, scope, realm, wallet, 1, pairs]),
      ]),
    )
  const emptyDigest = active([]),
    activeDigest = active([[id(1, 16), descriptorDigest]])
  const resultHead = cbor([3, scope, realm, wallet, 1, 1, 1, 1, activeDigest])
  const mutationId = Buffer.alloc(16, 0x11)
  const mutationPreimage = cbor([
    3,
    'bundle-supersession',
    requestPublicKey,
    3,
    'bundle-supersession',
    scope,
    realm,
    wallet,
    1,
    mutationId,
    0,
    emptyDigest,
    descriptorBytes,
    [],
  ])
  const mutationDigest = hash(
    Buffer.concat([text('bitcaster/encrypted-wallet-backup-v2-mutation/v2\0'), mutationPreimage]),
  )
  const body = [
    3,
    'bundle-supersession-receipt',
    scope,
    realm,
    wallet,
    1,
    requestPublicKey,
    mutationId,
    mutationDigest,
    0,
    emptyDigest,
    resultHead,
    id(1, 16),
    descriptorDigest,
    [[id(49, 16), id(65, 32)]],
    [],
    signingKeyId,
  ]
  const preimage = cbor(body),
    digest = hash(
      Buffer.concat([text('bitcaster/encrypted-wallet-backup-v2-receipt/v2\0'), preimage]),
    )
  const signature = schnorr.sign(digest, signer, Buffer.alloc(32, 0x55))
  return {
    owner,
    preimage: hex(preimage),
    digest: hex(digest),
    signature: hex(signature),
    resultHead: hex(resultHead),
    wire: hex(cbor([3, 'bundle-supersession-receipt-wire', ...body, signature])),
  }
}
writeFileSync(
  new URL('./receipt-vectors.json', import.meta.url),
  JSON.stringify(
    {
      signingKeyId: hex(signingKeyId),
      signingPublicKey: hex(schnorr.getPublicKey(signer)),
      a: receiptCase(ownerA),
      b: receiptCase(ownerB),
    },
    null,
    2,
  ) + '\n',
)
