// Independent byte-layout oracle: no SDK or CBOR-library imports.
import { writeFileSync, readFileSync } from 'node:fs'
const hex = (b) => Buffer.from(b).toString('hex')
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
const requests = JSON.parse(
  readFileSync(new URL('./request-vectors.json', import.meta.url), 'utf8'),
)
const account = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const b = (s) => Buffer.from(s, 'hex')
const error = cbor([3, 'encrypted-wallet-backup-v2-error', 'current-inventory', 'unavailable', 1])
const listingError = cbor([
  3,
  'encrypted-wallet-backup-v2-error',
  'owner-discovery',
  'rate-limited',
  2,
])
const envelope = (kind, body) =>
  cbor([
    3,
    'encrypted-wallet-backup-v2-http-response',
    kind,
    b(requests.scoped.digest),
    b(requests.ownerA),
    requests.realm,
    b(requests.walletId),
    1,
    body,
  ])
const accountPrefix = [
  3,
  'account-result',
  'enroll',
  b(requests.ownerA),
  account.realm,
  b(account.walletId),
  Buffer.alloc(16, 1),
  b(account.intentDigest),
]
writeFileSync(
  new URL('./http-vectors.json', import.meta.url),
  JSON.stringify(
    {
      scoped: hex(envelope('current-inventory', Buffer.from([1, 2, 3]))),
      scopedError: hex(envelope('error', error)),
      error: hex(error),
      epoch: hex(cbor([3, 'enrollment-epoch-result', 'active', 1])),
      discoveryError: hex(
        cbor([
          1,
          'backup-owner-discovery-error',
          b(requests.discovery.digest),
          requests.realm,
          b(requests.walletId),
          b(requests.requestAuthPublicKey),
          null,
          listingError,
        ]),
      ),
      accountResult: hex(cbor([...accountPrefix, 'committed', 1, 'active'])),
      accountError: hex(cbor([3, 'account-error', ...accountPrefix.slice(2), 'unavailable', 1])),
      genericError: hex(cbor([3, 'error', 'unauthorized', null])),
    },
    null,
    2,
  ) + '\n',
)
