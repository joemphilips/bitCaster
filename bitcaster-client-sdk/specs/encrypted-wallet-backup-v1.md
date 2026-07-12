# Encrypted Wallet Backup Object Format v1

This document freezes the byte-level format implemented by
`@bitcaster-market/client-sdk`. It defines opaque encrypted objects only. HTTP
request authentication, enrollment, manifest contents, manifest CAS, and
receipts are separate protocol layers.

## Constants

- Version: `1`.
- Realm: ASCII matching
  `^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$` (1..64 bytes).
- Seed: exactly 64 bytes.
- HKDF: SHA-256.
- Root HKDF salt: UTF-8 `bitcaster/encrypted-wallet-backup/hkdf-salt/v1`.
- Proof chunk kind code: `1`.
- Reserved manifest kind code: `2`. No v1 manifest codec is defined here.
- Plaintext frame: exactly 262144 bytes.
- Maximum canonical proof-chunk CBOR: 245760 bytes.
- Maximum records per proof chunk: 512.
- Object identifier: 16 random bytes; retry a collision at most eight times.
- AES key: 32 bytes. Nonce: 12 random bytes. GCM tag: 128 bits.
- Encrypted body: `nonce[12] || ciphertext[262144] || tag[16]`, exactly
  262172 bytes.
- Generation: a positive JavaScript safe integer.

All CBOR is deterministic RFC 8949 encoding: shortest integers and lengths,
definite-length arrays/strings only, and no maps or tags. A decoder must reject
non-canonical input after decoding by re-encoding and comparing every byte.

## Key derivation

Let `CBOR(x)` be deterministic CBOR and `HKDF(ikm,salt,info,L)` be WebCrypto
HKDF-SHA-256 `deriveBits`.

```text
rootSalt       = UTF8("bitcaster/encrypted-wallet-backup/hkdf-salt/v1")
encryptionRoot = HKDF(seed64, rootSalt,
                      CBOR([1,"encryption-root",realm]), 32)
requestRoot    = HKDF(seed64, rootSalt,
                      CBOR([1,"request-auth-root",realm]), 32)
vaultId        = HKDF(encryptionRoot, rootSalt,
                      CBOR([1,"vault-id",realm]), 32)
objectKey      = HKDF(encryptionRoot, objectId16,
                      CBOR([1,"object-key",realm,vaultId,kindCode]), 32)
```

For request-authentication public-key derivation only, candidates are:

```text
candidate(counter) = HKDF(requestRoot, rootSalt,
                          CBOR([1,"request-auth-scalar",realm,counter]), 32)
```

Counters are unsigned integers `0..255`. The first big-endian candidate `x`
with `0 < x < secp256k1_n` is the scalar. Exhaustion is an error. The public
key is the 32-byte x-only secp256k1 public key. Request signing and request
preimages are intentionally not defined by this version of the object codec.

A public key handle exposes only version, realm, lowercase-hex vault ID, and
lowercase-hex request-authentication public key. Seed and derived roots remain
private capability state and are never serializable.

## Proof chunk plaintext

The only production plaintext in this version is the positional array:

```text
[1, 1, records]
```

The first item is format version and the second is object kind. `records` is a
definite array of 1 through 512 records, sorted strictly by `proofId` bytes.
Duplicate proof IDs are forbidden.

Each record is a closed 14-item positional array:

```text
[
  proofId, commitment, mint, unit, keyset, amount, secret, signature,
  dleq, counter, proofKind, ctfOutcome, createdAt, updatedAt
]
```

Fields are:

1. `proofId`: 32-byte global durable proof identity.
   Legacy Base64, Base64url, padded, and unpadded keyset aliases use one
   identity derived from the decoded keyset bytes; the exact keyset text below
   remains wire-visible and commitment-bound.
2. `commitment`: 32-byte SHA-256 commitment defined below.
3. `mint`: canonical HTTP(S) mint URL, no credentials/query/fragment/percent-
   encoded path, no trailing slash, at most 2048 UTF-8 bytes.
4. `unit`: UTF-8 text, 1..64 bytes, with no controls or lone surrogates.
5. `keyset`: `[keysetKind,keysetText]` where:
   - `0`: a cashu-ts-accepted canonical Base64 or Base64url legacy ID, padded
     or unpadded; its exact input text is kept without normalization;
   - `1`: deprecated v0 lowercase keyset ID, exactly 16 hex characters total,
     beginning `00`;
   - `2`: lowercase `01` or `02` plus 64 lowercase hex characters.
   Unresolved 16-hex modern IDs are forbidden.
6. `amount`: canonical unsigned decimal text (`[1-9][0-9]*`) not exceeding
   `18446744073709551615`.
7. `secret`: exactly 64 ASCII bytes containing the lowercase-hex encoding of
   the 32-byte deterministically derived Cashu secret. No normalization occurs.
8. `signature`: compressed point bytes; 33 bytes for legacy/`00`/`01`, 48
   bytes for `02`.
9. `dleq`: for secp256k1, `[e,s,r]` with three 32-byte values; for BLS, null.
10. `counter`: unsigned integer `0..2147483647`.
11. `proofKind`: `0` ordinary, `1` active CTF.
12. `ctfMetadata`: null for ordinary. Active CTF uses the closed tuple
    `[conditionId,outcomeLabel,outcomeCollectionId,registeredAt,finalExpiry]`:
    both IDs are 32 bytes; outcome label is UTF-8 text 1..256 bytes with no
    controls or lone surrogates; `registeredAt` is a nonnegative safe Unix
    second; `finalExpiry` is a nonnegative safe Unix second strictly after
    the preparation effective time. Expired CTF is forbidden.
13. `createdAt`: nonnegative safe Unix seconds.
14. `updatedAt`: nonnegative safe Unix seconds not before `createdAt`.

Witness, `p2pk_e`, P2PK, HTLC, external/random/unverified proofs, expired CTF,
unknown provenance/condition, active reservations, ambiguous mint work, and
nonterminal proof links are forbidden.

The preparation input supplies the exact seed, Cashu proof, counter, mint/unit,
timestamps, and an adapter-neutral proof-snapshot transaction port. The SDK
computes the stable proof key, opens the adapter's asynchronous physical
transaction, and mints private authority only inside one synchronous SDK read
callback over the committed typed row. The callback cannot escape, run twice,
return a thenable, or substitute foreign work. The row binds snapshot ID and
revision, expected proof ID, expected committed record commitment, and all
classifier facts. Callers cannot supply those facts directly.

An active CTF row additionally contains opaque evidence minted only after the
SDK bounds exact MintKeys and ConditionalKeysetMetadata and cashu-ts
`Keyset.verifyConditionalKeysetId` succeeds. That evidence binds mint, unit,
modern `01` keyset/curve, condition ID, outcome label/collection ID,
registration time, and final expiry; an ordinary keyset cannot be relabeled as
CTF. Adapters reconstruct this non-serializable evidence from their committed
bounded MintKeys and metadata after restart. For each keyset, the implementation
uses cashu-ts `createSecretAndBlindingFactorDeriver(seed,keysetText)` and
requires the derived secret to equal the proof's exact lowercase-hex secret.
The implementation derives `proofId` and commitment again and requires exact
agreement with the authoritative snapshot; it never self-computes an expected
value and then treats that value as stored authority. With no receipt, the
classifier must return exactly the sole pin reason
`missing-current-backup-receipt`.

The commitment is:

```text
SHA256(CBOR([1,"proof-record-commitment",mint,unit,keyset,amount,secret,
             signature,dleq,counter,proofKind,ctfMetadata,createdAt,updatedAt]))
```

The record codec is secret-bearing. Preparation returns an opaque frozen
handle whose public fields contain only lowercase-hex proof ID and commitment;
the exact record bytes are held in private capability state. Packing accepts
only exact handles. Decryption recomputes both identities but returns only an
opaque frozen decoded-chunk capability and record count. It exposes no proof
body or active/selectable disposition. The later verification phase alone may
open that capability after keyset, curve, condition, signature/DLEQ, and NUT-07
checks.

## Bounded decoding

Before invoking a general CBOR materializer, the implementation scans the
single frame and enforces the frame/input bound, maximum depth, total token
bound, every array/string/byte-string length, exact root/record array lengths,
and record count. Maps, tags, indefinite items, negative integers, floats,
booleans, undefined, and big integers are rejected. Null is permitted only in
the DLEQ position and ordinary-proof CTF position defined above; CTF
`registeredAt` is never null. Trailing CBOR data is forbidden.

Restore reuses one NUT-13 deriver per exact keyset and decodes at most four
records before a cooperative host yield. One chunk remains bounded to 512
records and 245760 canonical bytes; larger vaults are future cursor-driven
sequences of independently bounded chunks, never one unbounded materialization.

## Framing, encryption, and digest

The plaintext frame is:

```text
uint32be(cborLength) || canonicalCbor || zeroPadding
```

and is exactly 262144 bytes. Nonzero padding is invalid.

The authenticated additional data is deterministic CBOR:

```text
[1,kindCode,realm,vaultId32,objectId16,generation,262144]
```

AES-256-GCM encrypts the full padded frame with the object key, 12-byte nonce,
AAD above, and 128-bit tag. Metadata and body lengths are checked before
decryption. The object digest is lowercase hex:

```text
SHA256(uint32be(aadLength) || aad || body)
```

One prepared object is immutable for an object ID. Transport retries reuse its
exact body and digest. Decryption failures, tampering, truncation, invalid
padding, invalid CBOR, and identity/commitment mismatches return a generic
`corrupt encrypted wallet backup object` error and never include secret data.

## Reserved manifest framing

Kind `2` reserves a distinct 65536-byte frame and a 65532-byte maximum
canonical CBOR payload for a future manifest protocol. Its future body length
would be 65564 bytes (`12 + 65536 + 16`), and its AAD would carry padded length
65536. This document defines no usable generic manifest encoder or decoder.
