// Independent byte-layout oracle: no SDK or CBOR-library imports.
import { createHash, hkdfSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { schnorr } from '@noble/curves/secp256k1.js'
const hex = (b) => Buffer.from(b).toString('hex')
const hash = (b) => createHash('sha256').update(b).digest()
const text = (s) => Buffer.from(s, 'utf8')
function header(major, n) {
  if (n < 24) return Buffer.from([major * 32 + n])
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
  if (typeof v === 'number') return header(0, v)
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
const now = 1800000000
const empty = hash(Buffer.alloc(0))
const make = (purpose, owner, epoch, url) => {
  const body = [
    2,
    'backup-owner-request',
    purpose,
    owner === null ? null : Buffer.from(owner, 'hex'),
    realm,
    wallet,
    requestPublicKey,
    epoch,
    'GET',
    url,
    now,
    now + 60,
    Buffer.alloc(16, 0x11),
    0,
    empty,
  ]
  const preimage = cbor(body),
    digest = hash(preimage),
    signature = schnorr.sign(digest, requestKey, Buffer.alloc(32, 0x11))
  const wire = cbor([2, 'backup-owner-request-proof', ...body.slice(2), signature])
  return {
    url,
    preimage: hex(preimage),
    digest: hex(digest),
    signature: hex(signature),
    wire: hex(wire),
  }
}
const discovery = make('owner-discovery', null, 0, 'https://backup.example/owners')
const scoped = make('scoped', ownerA, 1, 'https://backup.example/head')
const page = cbor([
  2,
  'backup-owner-discovery-page',
  Buffer.from(discovery.digest, 'hex'),
  realm,
  wallet,
  requestPublicKey,
  null,
  [[Buffer.from(ownerA, 'hex'), 'test', 'Alice', 1]],
  null,
  Buffer.from(ownerA, 'hex'),
])
writeFileSync(
  new URL('./request-vectors.json', import.meta.url),
  JSON.stringify(
    {
      realm,
      now,
      walletId: hex(wallet),
      requestAuthPublicKey: hex(requestPublicKey),
      ownerA,
      ownerB,
      discovery,
      scoped,
      page: hex(page),
    },
    null,
    2,
  ) + '\n',
)
