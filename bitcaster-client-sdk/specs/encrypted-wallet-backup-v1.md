# Encrypted Wallet Backup Object Format v1

This document freezes the byte-level format implemented by
`@bitcaster-market/client-sdk`. It defines encrypted proof objects, private
manifest pages, public head/reference metadata, request authentication,
account-authorized enrollment lifecycle, bounded object transfer, and head CAS.

## Constants

- Version: `1`.
- Realm: ASCII matching
  `^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$` (1..64 bytes).
- Seed: exactly 64 bytes.
- HKDF: SHA-256.
- Root HKDF salt: UTF-8 `bitcaster/encrypted-wallet-backup/hkdf-salt/v1`.
- Proof chunk kind code: `1`.
- Manifest-page kind code: `2`.
- Proof plaintext frame: exactly 262144 bytes; canonical CBOR at most 245760
  bytes; encrypted body exactly 262172 bytes.
- Manifest plaintext frame: exactly 65536 bytes; canonical CBOR at most 65532
  bytes; encrypted body exactly 65564 bytes.
- Maximum records per proof chunk: 512.
- Object identifier: 16 random bytes; retry a collision at most eight times.
- AES key: 32 bytes. Nonce: 12 random bytes. GCM tag: 128 bits.
- Manifest entries per page: at most 512. Manifest pages and total referenced
  objects: at most 1024 each. Total manifest entries: at most 524288.
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
preimages are separate from the object-encryption codec and are defined by the
delegated-request and account-lifecycle sections below.

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
11. `proofKind`: `0` ordinary, `1` CTF. Activity is a temporal disposition,
    not a structural proof kind and is not encoded here.
12. `ctfMetadata`: null for ordinary. CTF uses the closed tuple
    `[conditionId,outcomeLabel,outcomeCollectionId,registeredAt,finalExpiry,
    terminalSeal]`:
    both IDs are 32 bytes; outcome label is UTF-8 text 1..256 bytes with no
    controls or lone surrogates; `registeredAt` is a nonnegative safe Unix
    second; `finalExpiry` is a nonnegative safe Unix second. The identical
    committed record is valid on either side of that expiry boundary.
    `terminalSeal` is null or
    `[1,operationIdDigest32,requestDigest32,13015,classifiedAt]`.
    The SDK accepts the seal only through a non-clonable capability issued from
    an exact committed `ctf-redeem` operation linked to this proof. That
    operation persists the bounded exact oracle witness, commits a canonical
    digest over the exact mint, inputs, outputs, and witness before dispatch,
    records a request-digest-bound mint-submitted marker, reuses those exact
    bytes on restart, and records the authenticated mint's terminal code 13015.
    Only the mint call's own response can supply that code; a local journal or
    completion error with the same shape is not a mint verdict. Restart first
    matches the caller and wallet transport to the persisted mint and replays a
    completed or terminal-local result without requiring mint availability.
    The non-clonable capability is reconstructed only through a one-use
    synchronous callback over the committed operation row, and the proof
    snapshot stores the exact terminal operation ID rather than process-local
    object identity.
    A caller-supplied losing flag, naked error code, changed witness, or cloned
    capability has no authority. The compact seal can only make the proof
    nonselectable; it cannot authorize deletion or spend.
13. `createdAt`: nonnegative safe Unix seconds.
14. `updatedAt`: nonnegative safe Unix seconds not before `createdAt`.

Witness, `p2pk_e`, P2PK, HTLC, external/random/unverified proofs,
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

Each CTF row additionally contains opaque evidence minted only after the
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
value and then treats that value as stored authority. With no receipt, an
unexpired proof classifier must return exactly the sole pin reason
`missing-current-backup-receipt`. A CTF at or after its recorded expiry instead
classifies as complete `user-retained-nonselectable-ctf`; this permits backup
preparation but never permits automatic deletion or local-body eviction.

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

## Private manifest pages

A manifest page is the closed tuple:

```text
[
  1, 2, generation, snapshotNonce16, pageIndex, pageCount, entries
]
```

`generation` is positive. `snapshotNonce` is random and shared by every page in
one snapshot. Page indexes start at zero and are contiguous; `pageCount` is
`1..1024`. Each page contains 1..512 entries, and the complete manifest
contains at most 524288 entries. Entries are strictly ordered by proof ID within
each page; the bounded restore coordinator additionally rejects gaps, overlap,
duplicate IDs/commitments, noncontiguous page indexes, mixed nonce/generation,
or a total inconsistent with the authenticated head.

Each entry is the closed 11-item tuple:

```text
[
  proofId32,
  proofCommitment32,
  chunkObjectId16,
  chunkDigest32,
  mint,
  unit,
  amount,
  proofKind,
  ctfMetadata,
  createdAtUnixSeconds,
  updatedAtUnixSeconds
]
```

The prepared proof source stores a canonical 10-item entry template. It has a
leading record-kind item. The SDK removes that item and inserts fixed-width
`chunkObjectId16` and `chunkDigest32` references. Its pinned
`canonicalManifestEntryBytes` value is the exact byte length of this final
11-item entry. The SDK uses zero-filled fixed-width references for this size.
It does not use the 10-item template length.

The bounded page creator accepts only SDK proof, chunk-object, and Pass-A
boundary capabilities. It does not accept raw canonical page bytes, a raw
boundary tuple, key material, generation, nonce, page index, or page count.
It checks every deterministic binding before it allocates an object ID or uses
encryption randomness.

`proofKind` is `0` for ordinary or `1` for CTF. Its CTF tuple, optional compact
terminal seal, and all
mint/unit/amount/time bounds are identical to the proof record. Ordinary
entries require null CTF metadata. These encrypted summaries rebuild ordinary
mint/unit balances and CTF positions without loading every proof body; they do
not establish spendability. Each entry binds exactly one proof commitment to
one immutable chunk. Independently packed chunks may interleave; pages flatten
all bindings into proof-ID order and may refer to the same chunk from different
pages.

Manifest pages use the same object-key derivation with kind `2`, a 65536-byte
zero-padded frame, and AAD:

```text
[1,2,realm,vaultId32,objectId16,generation,65536]
```

The digest algorithm is unchanged. A changed page receives a fresh object ID
and nonce. The service sees only the encrypted object and public reference.

## Bounded restore verification

Restore begins from an authenticated current head. The SDK issues an opaque,
one-use manifest cursor bound to that exact head and key capability. A copied,
foreign, reused, skipped, or out-of-order cursor/page is invalid. Advancing the
cursor requires contiguous page indexes, strict proof-ID order across page
boundaries, and an exact final entry count equal to the head. An authenticated
empty head produces an already-complete cursor. The cursor contains only the
generation, page count, next page index, restored entry count, and completion
flag; it does not materialize the complete manifest.

Proof verification accepts 1..64 selections per call. Every selection binds
an exact proof ID in an authenticated current-head page to the exact decrypted
chunk object ID, digest, generation, commitment, metadata, timestamps, and
private key capability. CTF expiry is derived inclusively from the committed
`finalExpiry` and the validated restore effective time; adapters cannot supply
an `expired` boolean.

For ordinary and unexpired CTF proofs, the SDK deduplicates and sorts
`(mint,unit,keysetId)` requests and calls one
bounded keyset-resolution port with the caller's exact backup-cycle abort
signal. Its closed response must contain every requested identity exactly once
and no foreign identity. Ordinary keysets must pass cashu-ts keyset-ID
verification. CTF keysets must additionally reproduce the condition ID,
outcome collection ID, registration time, and final expiry committed by the
proof and manifest. Mint keys contain 1..64 canonical positive denominations
and curve-correct compressed public keys.

The SDK then verifies each Cashu signature with cashu-ts in four-proof work
slices, checks the cycle signal, and cooperatively yields between slices.
secp256k1 proofs require and verify DLEQ; BLS proofs use BLS pairing verification
and contain no DLEQ. In the same slices it derives the curve-appropriate NUT-07
`Y` from the private proof secret and sends only
`(proofId,mint,keysetId,Y)` through one bounded state port. The
closed response must map every query exactly once. Only `UNSPENT` is accepted;
`PENDING`, `SPENT`, missing, duplicate, foreign, or unknown responses fail
before storage. A CTF at or after recorded expiry, or carrying a valid compact
verified-losing seal, takes a separate integrity tier: authenticated
current-head membership, AEAD/canonical decoding, exact
record commitment, and seed-derived secret/proof identity are still required,
but the SDK calls neither the live keyset port nor NUT-07. It commits the
complete proof body with disposition `user-retained-nonselectable`, reason
`recorded-ctf-expiry-passed` or `verified-losing-outcome`, and storage class
`user-retained-nonselectable-ctf`. It cannot become selectable through this
path. Mixed selections send only their ordinary/unexpired subset to the live
ports.

Finally, one asynchronous adapter transaction receives the same exact
backup-cycle abort signal, receives the exact proposed proof/classification
rows, and must synchronously invoke the SDK's one-use commit callback exactly
once with the current state for every proof ID. In explicit `complete-origin`
mode the SDK permits an absent row, an exact candidate classification with no
local body, or that same classification plus the exact idempotent proof body;
accepting the exact existing states makes a crashed progressive origin rebuild
resumable. `hydrate-existing` permits only the two exact existing states and
never turns a missing local classification into a new row. The sole monotonic
exception is an exact same-head, same-binding, same-commitment and same-body CTF
transition from remotely backed/selectable to user-retained/nonselectable when
its recorded expiry is reached. A second enumerated monotonic transition accepts
a newer authenticated current-head record whose exact parent is the correlated
active record and that adds a valid verified-losing seal to the same stable
proof ID and exact Cashu proof body; both classification/proof pairs, the
no-seal predecessor commitment, chunk bindings, and parent generation/digest
are checked together. The reverse
transition and generic merge are forbidden. “Absent” means the global proof
identity has no proof, classification,
reservation, operation link, pin, spent marker, or tombstone in that same
physical transaction; a missing body row alone is not absence. A reserved,
ambiguous, operation-linked, pinned, stale-head, mismatched-commitment, spent,
or otherwise conflicting row is never overwritten. The adapter applies the
authorized rows in that same transaction; cancellation closes the callback
before any late continuation.

Each committed proof is bound to realm, vault, head generation and digest,
exact parent generation and digest (or a null genesis parent),
chunk object and digest, proof commitment, complete proof body and timestamps,
and one closed disposition: `selectable` with null reason, or
`user-retained-nonselectable` with the v1 reason
`recorded-ctf-expiry-passed` or `verified-losing-outcome`. Its paired storage classification is respectively
`remotely-backed-deterministic-proof` or
`user-retained-nonselectable-ctf`, with the exact current snapshot, chunk, and
commitment binding. Substitution, extra fields, reversed timestamps,
repeated or escaped callbacks, thenables, or partial commits are invalid. The
public result exposes only generation, manifest digest, proof IDs, and count;
it never exposes proof secrets.

The host's foreground deadline may win the API race after the local transaction
commits. The SDK returns the deadline and does not infer absence. A retry repeats
the exact operation and succeeds only against the byte-identical committed
proof and classification; it never selects a fresh proof or creates a second
row.

## Public reference set and head

A public object reference is `[objectId16, objectDigest32]`. The reference set
is:

```text
[1,"reference-set",manifestPageReferences,proofChunkReferences]
```

Page references remain in page-index order. Chunk references are sorted by
object ID. IDs and digests are each independently unique across both arrays.
The set has at most 1024 objects,
its canonical encoding is at most 65536 bytes, and contains no proof ID,
commitment, mint, market, condition, balance, or position.

The canonical head is the closed tuple:

```text
[
  1,
  "manifest-head",
  realm,
  vaultId32,
  backupPublicKey32,
  generation,
  null | [parentGeneration,parentManifestDigest32],
  snapshotNonce16,
  manifestPageReferences,
  proofChunkReferences,
  proofCount,
  storedBytes,
  referenceSetDigest32
]
```

`manifestDigest = SHA256(canonicalHead)` and
`referenceSetDigest = SHA256(canonicalReferenceSet)`. `storedBytes` is exactly
`pageCount*65564 + chunkCount*262172`. Generation one has null parent; every
later generation is exactly parent generation plus one. The local snapshot ID
is derived from version, realm, backup public key, generation, and manifest
digest as specified by the SDK storage contract.

The complete target is rejected when this exact stored-byte total exceeds 64
MiB. A non-empty target has at least one page and chunk, page/chunk counts obey
their 512-entry bounds against `proofCount`, and the empty target has no
references. These relationships are checked independently while preparing a
head and whenever an attempt, batch, finalized partition, or restored head is
decoded.

The client also enforces the conservative staged-child lower bound before any
child upload is sealed:

```text
parentReachableStoredBytes + nonInheritedTargetDeltaStoredBytes <= 67108864
```

The delta contains every new child manifest page plus every target proof chunk
whose exact `(objectId,digest)` is not inherited from the exact parent. Genesis
uses zero parent bytes; an empty child has a zero delta. No caller-provided peak
or delta scalar is authoritative. The service's authenticated-account-wide
quota remains authoritative and may still reject an upload that passes this
per-vault client lower bound.

Every non-empty child writes new manifest pages at exactly the child generation.
The parentless manifest builder is a generation-one-only capability. Every
later generation, including a full one-for-one replacement, must be constructed
through the authenticated-parent incremental builder, and the resulting head
accepts only the exact authenticated parent captured by that builder.
Proof-chunk generation may be less than or equal to the child generation. An
exact `(objectId,digest)` found in the authenticated exact parent is inherited;
every other chunk is part of the current attempt's uploaded delta. The child
reference set is the union of its new pages, newly packed chunks, and the
selected intersection with the exact parent chunk references. Removed or
repacked proofs remove their old chunk reference when no retained entry uses it. The final transactional
snapshot seal authenticates the exact union of new prepared proof bindings and
selected inherited `(proofId,commitment)` stubs; inherited metadata never creates
a spendable or selectable proof capability.

An empty wallet is a canonical head with zero proofs, pages, chunks, objects,
and stored bytes. It is valid both at generation one and as the exact child that
removes the last proof. The empty child pins nothing, so every object reachable
only from its parent becomes eligible for bounded garbage collection after the
head transition and retention rules permit it.

The CAS body is the immutable canonical tuple:

```text
[
  1,
  "head-cas",
  uploadAttemptId16,
  expectedManifestDigest32OrNull,
  canonicalHeadBytes,
  canonicalReferenceSetBytes
]
```

The service recomputes both digests, object count, kinds, generations, ownership,
and stored bytes from immutable object metadata. In the same atomic transaction
as the head comparison, it requires `uploadAttemptId16` to identify the exact
active, non-abandoned remote attempt; validates that its uploaded objects are
exactly all new pages plus only the chunk-reference delta not inherited from the
exact current parent; finalizes that attempt; pins the target union; unpins
removals; and advances the head. There is no separate remote finalize endpoint.
An abandoned attempt cannot authorize CAS, even when its objects still exist,
and an unknown attempt normally conflicts. There is one narrow zero-delta
exception: CAS may atomically create and finalize an absent attempt only when
the service recomputes an exact zero-object target delta, the target is the
canonical empty vault, all expected-parent/current-head checks pass, the vault's
staged-attempt slot is empty, and no conflicting or abandoned tombstone exists.
Every other unknown attempt conflicts. This exception grants no authority to an
object-bearing or non-empty target. The service accepts generation one from no
head, an exact current-plus-one child, or an exact idempotent retry already at the target.
Same-generation different bytes, a skipped generation, a wrong parent, altered
references, or an attempt-state mismatch is a conflict/fork.

## Delegated request proof

Subsequent vault operations use BIP340 Schnorr. The signed preimage is:

```text
[
  1,
  "backup-request",
  realm,
  vaultId32,
  requestAuthPublicKey32,
  enrollmentEpoch,
  method,
  exactHttpsUrl,
  issuedAtUnixSeconds,
  expiresAtUnixSeconds,
  replayNonce16,
  payloadLength,
  SHA256(exactRequestBody)
]
```

The signature is `BIP340_SIGN(SHA256(preimage), requestScalar, auxRand32)`.
Methods are exactly `GET`, `PUT`, `POST`, or `DELETE`. The signed URL is the
exact ASCII serialization (absolute HTTPS, no credentials or fragment, at most
2048 bytes); query ordering is not normalized. Payloads are at most 4 MiB. The
freshness window is `1..60` seconds; verification accepts issue time at most 30
seconds in the future and requires current time not after expiry. Replay nonce
scope is `(realm,vault,key,epoch,nonce)`, retained through expiry plus the
server clock-skew allowance. Revocation/epoch validation happens before replay
lookup. Durable object/CAS idempotency is independent of the short-lived nonce.
Bounded coordinators read their injected clock immediately before each remote
dispatch; they do not reuse one timestamp across a slow upload or retry loop.

Delegated GET requests and object DELETE requests have an exactly empty HTTP
body. Their signed `payloadLength` is exactly zero and their signed body digest
is `SHA256(empty)`. Upload-attempt DELETE is different: it carries and signs the
canonical abort body defined below. Account lifecycle requests also carry their
canonical account request body and are not delegated requests.

This delegated proof is used only for enrollment-epoch discovery, object
PUT/GET/DELETE, upload-attempt abort, head GET, and head compare-and-swap. It is
not used for account-authorized enroll, revoke, or whole-vault deletion. Those
three lifecycle operations use only the scheme-neutral account authorization
envelope below; an HTTP adapter must not attach `Authorization: BackupV1` to
them. Conversely, delegated endpoints do not accept the account authorization
envelope as a substitute for the exact request proof.

The ordinary proof builder requires `enrollmentEpoch >= 1`. A separate
seed-derived epoch-discovery GET uses epoch zero only at the discovery endpoint.
It reveals either the active epoch or one common `not-enrolled` result for
absent/revoked/foreign bindings; it never lists vaults. This permits a seed to
recover its active epoch after local-origin loss without account-auth prompts.

An HTTP adapter serializes the proof as deterministic CBOR:

```text
[
  1,"backup-request-proof",realm,vaultId32,requestAuthPublicKey32,
  enrollmentEpoch,method,url,issuedAt,expiresAt,replayNonce16,
  payloadLength,payloadDigest32,signature64
]
```

and sends it as unpadded Base64url after `Authorization: BackupV1 `. Responses
and request-proof headers use `Cache-Control: no-store`.

## Account-authorized vault lifecycle

The SDK account port is authentication-scheme neutral. Its initial web adapter
may use NIP-98, but the canonical SDK intent contains no Nostr type or key:

```text
[
  1,"backup-account-operation",action,exactHttpMethod,exactHttpsUrl,realm,vaultId32,
  requestAuthPublicKey32,expectedEnrollmentEpoch,operationId16
]
```

`action` is `enroll`, `revoke`, or `delete`; method is `POST`, `POST`, or
`DELETE` respectively, and the absolute URL is serialized exactly as for a
delegated request. There is no key/vault replacement
operation. The port receives the exact intent and its SHA-256 digest and returns
a lowercase scheme identifier plus at most 16 KiB of opaque authorization. The
transport body is:

```text
[
  1,"backup-account-request",canonicalIntentBytes,intentDigest32,
  authorizationScheme,opaqueAuthorizationBytes
]
```

The initial account-authorization profile is
`nip98-backup-intent-v1`. Its opaque authorization is the exact UTF-8 encoding
of one minified JSON object whose fields appear in this order:

```text
{"id":eventId,"pubkey":ownerPubkey,"created_at":issuedAt,"kind":27235,
 "tags":[["u",exactHttpsUrl],["method",exactMethod],
         ["backup-intent",lowerHexSha256CanonicalIntent]],
 "content":"","sig":signature}
```

The displayed whitespace is explanatory only; the encoded object contains no
optional whitespace. The event uses the ordinary NIP-01 event-id preimage and
BIP-340 signature rules. It has exactly the three two-element tags shown, in
that order, and empty content. Unknown, duplicate, reordered, or additional
tags and fields fail closed. In particular, this profile does not use the
standard NIP-98 `payload` tag: the signed object is embedded inside the outer
account request, so signing that complete body would be circular. Instead, the
versioned `backup-intent` extension binds the already frozen canonical intent.
The service verifies the exact configured public HTTPS URL, exact method,
lowercase event/public-key/signature encodings, event id, signature, and a
maximum absolute clock difference of 60 seconds. The verified event pubkey is
the scheme-specific account subject; generic backup domain and persistence
store the scheme and opaque subject without treating Nostr as the universal
application identity.

An enroll at expected epoch zero creates an absent vault at epoch one. An exact
retry of the latest successfully applied lifecycle operation is idempotent. The
service retains exactly one applied lifecycle receipt per vault. A later
successful lifecycle mutation atomically replaces that receipt; retrying an
older superseded operation then returns the authenticated current-state
`conflict`, while rejected and conflicting attempts create no receipt. This
bounds lifecycle idempotency state to O(1) per vault. An already-active
identical vault is reopened without mutation through epoch discovery.
Revoke/delete require a positive exact epoch
and advance the monotonic tombstone epoch; an old delegated key fails
immediately. The closed TLS-authenticated response is either
`[1,"account-result",operationId16,intentDigest32,"committed",epoch,lifecycle]`,
`[1,"account-result",operationId16,intentDigest32,"conflict",epoch,lifecycle]`,
or the common bounded error tuple. The operation id and intent digest must equal
the exact request before the response can be persisted. The client persists
those bindings with the exact observation before returning authority. Because
the response is account-authenticated and scoped
to one seed-derived vault, a conflict may reveal its current tombstone epoch;
this lets origin-loss recovery explicitly re-enroll a revoked or deleted vault.
Re-enrollment is an owner-authorized CAS that advances the epoch and starts an
empty active backup; deleted ciphertext is never restored. It is not an
implicit key replacement. A different seed produces a different vault
ID and key and starts an independent empty vault. One account may own multiple
vaults; quota is aggregated by authenticated account, not preallocated per
vault.

Revocation invalidates the old delegated epoch immediately. Re-enrollment and
deletion also make the old head logically unreachable immediately, but reserved
bytes remain charged until physical cleanup is safe. The service fully buffers
and verifies each bounded object body before it obtains a database-clock PUT
claim immediately before the conditional blob write. The claim has a 15-second
deadline, binds the reservation's exact database-authoritative digest and body
length, and the exact claim identifier returned by the write is required for
object finalization. The blob request is capped by the claim's remaining
database lifetime. Cleanup waits until an unclaimed reservation's expiry plus
15 seconds, or a claimed PUT's deadline plus 15 seconds. Old-epoch finalization
fails; therefore an upload that completes late remains covered by the same
deletion claim instead of becoming an unaccounted blob.

## Object PUT and bounded client cycles

The exact signed PUT body is:

```text
[
  1,"object-put",uploadAttemptId16,kind,realm,vaultId32,objectId16,generation,
  paddedLength,objectDigest32,aadBytes,encryptedBodyBytes
]
```

The exact signed attempt-abort body is:

```text
[1,"upload-attempt-abort",uploadAttemptId16,targetManifestDigest32]
```

The service accepts an exact idempotent retry or stores the immutable object;
the same ID with different bytes fails. It reserves declared bytes before
reading/buffering the body and recomputes AAD, length, and digest before
finalizing. The attempt ID groups bounded batches into one per-vault staged
update. An incomplete target that has not gained CAS authority can be abandoned;
its objects become bounded garbage rather than a partially acknowledged head.

Before any batch exists, the client durably seals one active-upload-attempt
aggregate containing the exact realm, vault, attempt ID, target and parent
digests, canonical target, canonical parent head, and inherited-delta bytes,
local snapshot identity, bounded insert-only batch IDs, current foreground
batch ID, and lifecycle. Genesis persists a null canonical parent. For a child,
`SHA256(canonicalParentHead)` equals the parent digest and decoding that exact
head must prove the same realm, vault, backup key, target-minus-one generation,
reference digest, reference counts, and stored-byte formula. The child peak is
then recomputed from that persisted parent and the exact inherited chunk
intersection during every restart decode.
Exactly one live staged attempt exists for an exact `(realm,vault)`; sealing
another fails while the prior attempt is `active`, `abort-uncertain`,
`cas-journaled`, or `fork-cleanup-uncertain`. Only `abandoned` and `complete`
release that slot.
Restart uses one scope-bound attempt-or-null claim without a caller-known
attempt ID; an adapter rejects multiple or foreign records rather than choosing
one. A mutation requires the SDK-issued owner claim
`(ownerId,ownerEpoch,leaseExpiresAt)`; the adapter checks the current epoch and
its own database clock atomically with every batch seal, PUT-state transition,
CAS handoff/transition, and abort. A different owner may take over only after database-time
lease expiry. Every explicit claim or renewal grant, including one to the same
owner, increments the epoch and replaces prior authority. Batch IDs are
insert-only or exact-idempotent. Object IDs and object digests are each
independently unique across the complete attempt partition. Every batch carries
byte-exact copies of the aggregate target and inherited reference sets;
inherited references contain proof chunks only, never manifest pages.

Every mutation port is a database transaction: it invokes its SDK validation
callback synchronously exactly once, returns the callback's exact value, and
rolls back every write if validation rejects. The SDK retains an immutable
expected record and gives adapters separate byte-array and collection copies,
so adapter mutation cannot rewrite the authority used for comparison.

At most one payload-bearing foreground batch is active. Batch seal atomically
sets `activeBatchId`; a different sibling cannot seal until acknowledgement
atomically clears it. Abort and CAS handoff fence and clear it. Upload execution
has a separate database-time lease and monotonically increasing execution epoch,
so two coordinators cannot concurrently resume the same `put-uncertain` batch.
An unexpired execution lease rejects another runner; after expiry, restart claims
a new execution epoch and reuses the exact persisted PUT bytes. Recovery claims
the attempt and active batch consistently. The client validates both the owner
claim and execution epoch/lease after constructing each request proof and
immediately before every PUT dispatch. A request already in flight when an epoch
changes remains harmless because the server accepts it only while the remote
attempt is active and rejects it after the attempt-wide abort/handoff fence.
The aggregate lifecycle is `active -> abort-uncertain -> abandoned` or
`active -> cas-journaled -> complete`. A foreign authenticated head changes
`cas-journaled` to `fork-cleanup-uncertain`; the exact upload-attempt abort then
resumes to `abandoned` or `complete`. Fencing and tombstoning apply to every
sibling batch.

One SDK foreground upload cycle persists exact PUT bytes before I/O and enforces
all of these independently:

- at most 16 remote requests;
- at most 4194304 uploaded bytes, counting canonical PUT payloads;
- at most four concurrent requests;
- at most four distinct parent chunks used as repack sources.

Fifteen maximum proof-chunk PUTs fit the byte budget; the request-count limit
does not weaken the byte limit. These are per-cycle limits, not cumulative
limits for the target. Planning consumes an SDK-issued prepared-head
capability, not caller-provided object descriptors, byte counts, target totals,
or repack flags. The capability contains the real prepared page/chunk objects
and exact non-inherited delta. For each newly prepared chunk, incremental
manifest construction records the distinct exact-parent chunk IDs from which
retained proofs moved; genesis and wholly new proofs have no repack source. A
cycle's repack count is the union of those source IDs across its selected
chunks. The stable planner greedily fills every nonfinal cycle until no
remaining prepared object can fit its request, byte, and source-union
capacities, and creates at most 64 cycles. The 64-cycle ledger limit is defense
in depth: 256 maximum proof chunks already exceed the 64 MiB stored-object
ceiling, while 255 proof chunks plus three manifest pages fit. The planner
rejects a target whose exact head `storedBytes` (including inherited objects)
exceeds that ceiling, whose parent-plus-new-delta lower bound exceeds that
ceiling, or whose capability omits the new-object delta;
canonical PUT payload bytes are counted
separately against each cycle's 4 MiB transport limit.
CAS handoff separately validates the complete target-wide batch ledger,
reference delta, independent ID/digest uniqueness, and quota-bound target;
per-cycle bounds never weaken those whole-target checks. Each post-expiry
execution claim is a new bounded cycle over the same exact persisted batch, not
an unbounded continuation counter. A crash in `put-uncertain` retries the exact
persisted bytes. Acknowledged batches compact away ciphertext while retaining
their bounded reference/length ledger. Before issuing DELETE, abandonment
durably and exclusively transitions a batch from `sealed`, `put-uncertain`, or
`acknowledged` to `abort-uncertain`; restart retries the exact abort and records
`abandoned` only after remote acknowledgement. CAS handoff atomically
transitions the complete acknowledged batch set to locally `finalized`, inserts
or reads the exact deterministic CAS row, links it from the aggregate, and
commits `cas-journaled`. Local batch finalization is not remote finalization;
there is no separately committed finalized-awaiting-CAS state. These transitions
are mutually exclusive: stale abort authority cannot cross handoff, and handoff
cannot cross `abort-uncertain` or `abandoned`. The adapter, not the caller, loads the complete
`(uploadAttemptId,targetManifestDigest)` partition inside that transaction,
rejects any mixed or duplicate row, and rolls the transition back if the SDK's
synchronous validation callback rejects. Reads used for restart likewise return
the complete partition rather than filtering out non-finalized rows.

Persisted execution history is closed: `sealed` is epoch zero with payloads;
`put-uncertain` is epoch one or later with a live lease and payloads;
`acknowledged` and `finalized` are epoch one or later with no payloads;
`abandoned` has no payloads; and `abort-uncertain` has no lease and permits only
the complete pre-compaction or complete post-acknowledgement payload form.
Mixed per-item payload presence and impossible state/epoch substitutions fail
rehydration.

If a crash loses an unprepared remainder, the delegated client tombstones the
attempt through its idempotent abort endpoint; the service rejects late PUTs and
queues unpinned objects for bounded garbage collection before the client
rebuilds from the still-authoritative local snapshot. Only the combined
coordinator transaction may mint CAS authority. Its CAS ID is the first 16
bytes of
`SHA256(CBOR([1,"backup-cas-attempt-id",realm,vaultId32,uploadAttemptId16,targetManifestDigest32]))`.
The caller supplies no CAS ID, target, snapshot identity, finalized capability,
or independent CAS store. The coordinator uses one physical database
transaction and enforces transactional referential integrity plus a unique
upload-to-CAS relation, so orphan or multiple linked rows cannot exist. SQLite
and PostgreSQL adapters use a physical foreign key and unique constraint. Dexie
adapters use a same-transaction upload-attempt existence check plus a unique
index.
After restart, one scope-bound aggregate claim discovers the work: `active`
resumes its exact batch or handoff, `cas-journaled` loads only its exact linked
CAS row, and `fork-cleanup-uncertain` resumes only its exact abort. Missing,
multiple, foreign, or mismatched links fail closed. Snapshot metadata and the
CAS target are derived from the persisted aggregate and never accepted from the
caller. One canonical parser derives every duplicated target summary field from
the aggregate's canonical head and reference-set bytes, including parent
generation/digest, snapshot nonce, derived snapshot ID, reference-set digest,
counts, and byte totals. Restart and fork cleanup reject any linked CAS summary
that differs from that derivation before signing or dispatch.

Every CAS transition revalidates the current aggregate owner epoch and
database-time lease. After asynchronous request signing, the SDK immediately
revalidates that exact aggregate claim and linked CAS row before dispatch; it
does not claim that an already-sent request can be recalled. CAS dispatch is
durably recorded before I/O. A lost CAS response is resolved by
authenticated head read: target means acknowledged, parent permits an exact-byte
retry within the initial-plus-two-retry allowance, and any other head is a fork.
If the exact parent remains after the final allowance, the attempt records
`retry-exhausted` with a durable not-before boundary atomically stamped from the
adapter's database clock plus the shared bounded retry schedule. An authenticated
quota or
backpressure response may suspend the same attempt earlier, after one through
three dispatches: quota uses the five-second default, while rate-limit,
overload, or unavailability may supply a validated 1–3,600 second delay.
The adapter stamps that boundary before its follow-up authenticated head read;
head backpressure, transport failure, or restart therefore cannot erase it.
Client/request clock skew cannot shorten either boundary, and suspension is not
misclassified as a fork. At or after that boundary, the adapter atomically
resumes the same exact attempt row, upload-attempt ID, target digest, and
canonical CAS bytes in `reconcile-before-retry`. It must authenticate the
current head before another CAS dispatch: target acknowledges, parent reopens
the exact-byte allowance, and any other head rejects the fork. It cannot create
a replacement target or reset the allowance early. Authenticated target
observation atomically changes the CAS row to `acknowledged` and aggregate to
`complete`. Parent observation retries while the aggregate stays
`cas-journaled`; a foreign head atomically changes the CAS row to
`fork-rejected` and aggregate to `fork-cleanup-uncertain`. Remote CAS and abort
serialize: late CAS after abort sees abandoned/conflict, while late abort after
CAS receives authenticated `already-finalized`. That cleanup result completes
the aggregate but never creates current-head or proof-eviction receipt authority.
Coordinator persistence is bounded at every terminal path. When an authenticated
target observation would change the CAS row to `acknowledged` and the aggregate
to `complete`, the adapter first invokes the SDK validation callback against
those terminal snapshots and the complete finalized batch partition. The SDK
validates exact partition membership and immutable batch identity before the
adapter deletes the upload aggregate, every batch, and the linked CAS row in
that same transaction. Nonterminal CAS transitions do not load the batch
partition. Fork cleanup does the same
after validating the exact immutable `fork-rejected` CAS identity and the
terminal `abandoned` or `complete` partition. Callback rejection rolls back the
terminal transition and deletion. Terminal coordinator rows are not receipt or
restart authority and are never retained as history; durable current-head state
and authenticated backup receipts remain separate authorities.
The pre-CAS abort path is bounded by the same rule: after the remote attempt is
authenticated as abandoned, the adapter invokes the SDK callback against the
terminal aggregate and all abandoned batches, then deletes that aggregate and
partition in the same transaction. Callback rejection rolls back both the
terminal transition and deletion.
An SDK-created current-head capability plus a decrypted current manifest-page
membership is the only source of a per-proof backup receipt. Arbitrary callbacks,
cloned evidence, old heads, or merely existing blobs cannot authorize local
proof eviction.

## HTTP resources and bounded errors

All paths are relative to one configured HTTPS origin. `{realm}`, `{vaultId}`,
and `{objectId}` use the canonical values above.

```text
POST   /v1/encrypted-wallet-backup/realms/{realm}/vaults:enroll
GET    /v1/encrypted-wallet-backup/realms/{realm}/vaults/{vaultId}/enrollment-epoch
POST   /v1/encrypted-wallet-backup/realms/{realm}/vaults/{vaultId}:revoke
DELETE /v1/encrypted-wallet-backup/realms/{realm}/vaults/{vaultId}
DELETE /v1/encrypted-wallet-backup/realms/{realm}/vaults/{vaultId}/upload-attempts/{attemptId}
PUT    /v1/encrypted-wallet-backup/realms/{realm}/vaults/{vaultId}/objects/{objectId}
GET    /v1/encrypted-wallet-backup/realms/{realm}/vaults/{vaultId}/objects/{objectId}
DELETE /v1/encrypted-wallet-backup/realms/{realm}/vaults/{vaultId}/objects/{objectId}
GET    /v1/encrypted-wallet-backup/realms/{realm}/vaults/{vaultId}/head
POST   /v1/encrypted-wallet-backup/realms/{realm}/vaults/{vaultId}/head:compare-and-swap
```

CBOR request/response media type is `application/cbor`. Success bodies are
closed RFC 8949 deterministic-CBOR definite arrays specific to the operation:

```text
account lifecycle:
  [1,"account-result",operationId16,intentDigest32,"committed"|"conflict",
     epoch,"active"|"revoked"|"deleted"]

enrollment epoch:
  [1,"enrollment-epoch-result",requestDigest32,"active",epoch]
  [1,"enrollment-epoch-result",requestDigest32,"not-enrolled"]

current head:
  [1,"head-result",requestDigest32,"found",epoch,
     canonicalHeadBytes,canonicalReferenceSetBytes]
  [1,"head-result",requestDigest32,"not-found",epoch]

object GET:
  [1,"object-result",requestDigest32,"found",kindCode,realm,vaultId32,
     objectId16,generation,paddedLength,objectDigest32,aadBytes,
     encryptedBodyBytes]
  [1,"object-result",requestDigest32,"not-found"]

object PUT:
  [1,"object-put-result",requestDigest32,"stored"|"already-stored"]

object DELETE:
  [1,"object-delete-result",requestDigest32,"deleted"|"already-deleted"]

upload-attempt abort:
  [1,"upload-attempt-abort-result",requestDigest32,
     "abandoned"|"already-abandoned"|"already-finalized"]

head compare-and-swap:
  [1,"head-cas-result",requestDigest32,"committed"|"conflict"]
```

`requestDigest32` is `SHA256` of the exact delegated request-proof preimage.
It binds the TLS response to the request that produced it and prevents a client
or adapter from swapping concurrent responses. It is not a server signature,
receipt, or proof of future storage. Server authentication is normal platform
TLS using the operating system/browser PKI, hostname verification, and the
configured HTTPS origin. V1 adds no application-layer server signing or custom
certificate-pinning protocol.

The `not-enrolled` and both `not-found` tuples are semantic absence results.
They are successful HTTP 200 responses bound to the exact request. A generic
HTTP 404 `not-found` error is unbound, fatal/non-authoritative transport
evidence and must never be converted into enrollment, empty-head, object-
absence, deletion, receipt, or eviction authority. Account and head-CAS
`conflict` are likewise bound HTTP 200 semantic results; generic HTTP 409
`conflict` remains an error.

Before materializing a response, the client enforces these inclusive operation-
specific body limits:

| response operation | maximum bytes |
| --- | ---: |
| account lifecycle | 256 |
| enrollment epoch | 128 |
| current head | 132096 |
| object GET | 266272 |
| object PUT/DELETE, attempt abort, head CAS | 128 |
| any error | 128 |

Every response must be one exact flat tuple. Maps, tags, floats, negative
integers, indefinite items, non-minimal integer/length encodings, invalid UTF-8,
unknown versions/discriminators/values, wrong arity/types/ranges, trailing
bytes, and over-cap bodies fail before semantic decoding. Embedded head,
reference-set, and AAD byte strings are independently bounded, preflighted,
strictly decoded, and required to re-encode byte-for-byte canonically.

For object GET, the decoding context supplies the expected realm, vault id,
object id, object digest, kind, and current authenticated head generation. The
response and strictly decoded AAD must bind all of those object identity fields,
and the client recomputes
`SHA256(uint32be(aadLength) || aad || encryptedBody)` before accepting the
object. Padded length is 262144 for a proof chunk and 65536 for a manifest page;
the encrypted body is exactly padded length plus the 12-byte nonce and 16-byte
tag. Generation is positive. A manifest page must equal the current head
generation. An inherited proof chunk may be older, but must be at most the
current head generation. Future-generation objects, old manifest pages, or any
response/AAD mismatch fail closed. This rule does not expand the public
reference format.

Error bodies are always:

```text
[1,"error",code,retryAfterSecondsOrNull]
```

The closed v1 code set is `invalid-request`, `unauthorized`, `not-found`,
`conflict`, `replay-rejected`, `quota-exceeded`, `rate-limited`, `overloaded`,
and `unavailable`. Authentication errors do not distinguish account, vault,
key, epoch, revoked, or missing state. Error text, URLs, owner/vault/object IDs,
ciphertext, proof identifiers, and digests are never returned in diagnostic
bodies or emitted as log/metric labels.

The HTTP status, error code, and operation matrix is closed:

| HTTP | permitted code | permitted operations |
| ---: | --- | --- |
| 200 | exact operation-specific success tuple above | only its named operation |
| 400 | `invalid-request` | all operations |
| 401 | `unauthorized` | all operations |
| 404 | `not-found` | all operations; always fatal/non-authoritative |
| 409 | `conflict`, `replay-rejected` | all operations |
| 429 | `rate-limited` | all operations |
| 429 | `quota-exceeded` | account enrollment, object PUT, and head CAS only |
| 503 | `overloaded`, `unavailable` | all operations |

No other operation/status/code combination is valid. `retryAfterSecondsOrNull`
must be null for `invalid-request`, `unauthorized`, `not-found`, `conflict`,
`replay-rejected`, and `quota-exceeded`. For `rate-limited`, `overloaded`, and
`unavailable`, it is either null or an unsigned integer in `1..3600`. An HTTP
adapter must reject redirects, content encoding, a missing or parameterized
`application/cbor` response media type, or any response that is not
`Cache-Control: no-store`; those transport checks precede this codec.
An account-enrollment `quota-exceeded` response is a terminal refusal for a new
lifetime-distinct vault identity and is not scheduled as storage-byte
backpressure. Object PUT and head CAS retain their existing quota-backoff
behavior.

Each adapter request has a 15-second fail-safe. SDK coordinators require a
host-supplied absolute cycle signal and do not impose the browser foreground
quota-recovery deadline on background or native-client work. Every adopting
host defines and validates a finite whole-cycle policy and tests that its signal
fires; an unbounded placeholder signal is not conformant.

The database-time retry boundary is a minimum. The one live CAS row for a vault
persists a consecutive-failure streak. Shared SDK scheduling increments that
streak, applies a five-second exponential base capped at one hour, and then
adds deterministic jitter of up to 20 percent without crossing the cap. The
unjittered delay is the greater of the exponential delay and a validated server
hint, so scheduling never shortens the hint. Only an acknowledged target head
resets the streak. Restart reloads the same row and cannot reset it; a terminal
fork ends the attempt. Host adapters wake at or after the computed boundary.

The cross-client jitter input is UTF-8
`bitcaster/encrypted-wallet-backup-retry/v1`, NUL, realm, NUL, lowercase
64-hex vault ID, NUL, lowercase 32-hex attempt ID, NUL, and the decimal
post-increment streak. Interpret the first four SHA-256 bytes as an unsigned
big-endian integer. The jitter room is the lesser of floor(unjittered delay / 5)
and the remaining milliseconds below the one-hour cap; the jitter is that
integer modulo `(jitter room + 1)`. Implementations reject a persisted streak
outside `0..32`; increment saturates at 32.

Object DELETE requires the exact delegated owner/vault/key/epoch binding and
exact object ownership. In one service transaction it rejects a current-head-
reachable, staged, reserved, or pinned object; those cases and a same-ID/
different-object conflict use HTTP 409 `conflict`. A genuinely missing object
is idempotent `already-deleted`. A successful DELETE result is only remote
garbage-maintenance evidence. It is never current-head, backup-receipt,
reachability, proof-eviction, proof-deletion, or local-custody authority.
