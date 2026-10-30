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
const account = Buffer.alloc(32, 0x31),
  subject = hex(schnorr.getPublicKey(account)),
  scheme = 'nip98-backup-intent-v1'
const url =
    'https://backup.example/v1/encrypted-wallet-backup/realms/backup.production/wallets:enroll',
  now = 1800000000
const I = cbor([
  1,
  'backup-account-operation',
  'enroll',
  'POST',
  url,
  realm,
  wallet,
  requestPublicKey,
  0,
  Buffer.alloc(16, 1),
])
const tags = [
  ['u', url],
  ['method', 'POST'],
  ['backup-intent', hex(hash(I))],
]
const id = hex(hash(text(JSON.stringify([0, subject, now, 27235, tags, '']))))
const credential = text(
  JSON.stringify({
    id,
    pubkey: subject,
    created_at: now,
    kind: 27235,
    tags,
    content: '',
    sig: hex(schnorr.sign(Buffer.from(id, 'hex'), account, Buffer.alloc(32))),
  }),
)
const A = cbor([1, 'backup-account-request', I, hash(I), scheme, credential])
const P = cbor([1, 'backup-account-request-possession', A]),
  D = hash(P),
  sig = schnorr.sign(D, requestKey, Buffer.alloc(32))
const owner = [scheme, subject]
const owners = [
  owner,
  ['test', 'Alice'],
  ['test', 'alice'],
  ['other', 'Alice'],
  ['test', 'é'],
  ['test', 'é'],
  ['test', 'a:b|c'],
].map(([scheme, subject]) => ({
  scheme,
  subject,
  preimage: hex(cbor([1, 'backup-owner-scope', scheme, subject])),
  digest: hex(hash(cbor([1, 'backup-owner-scope', scheme, subject]))),
}))
const fixture = {
  realm,
  url,
  now,
  walletId: hex(wallet),
  requestAuthPublicKey: hex(requestPublicKey),
  ownerSubject: subject,
  owners,
  intent: hex(I),
  intentDigest: hex(hash(I)),
  authorization: hex(credential),
  authorizedRequest: hex(A),
  possessionPreimage: hex(P),
  possessionDigest: hex(D),
  possession: hex(sig),
  wire: hex(cbor([2, 'backup-account-request', A, sig])),
}
writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n')
