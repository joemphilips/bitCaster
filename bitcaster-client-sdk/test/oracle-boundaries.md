# Market input and oracle backup boundary checks

Use these linked test families when changing text limits, oracle codecs, or
backup capacity. A comparison of constants is not sufficient. The tests use
the real serializers and validators at each boundary.

Use Node 22 or a supported newer Node release. Install workspace dependencies
and build the SDK before running native consumers. Run heavy suites in sequence
on a busy host. Do not increase test deadlines to hide a missing completion
signal.

## SDK policy and wire checks

From `bitcaster-client-sdk/`:

```bash
node --experimental-strip-types --test --test-concurrency=2 \
  test/marketCreationLimits.test.ts test/marketCreationInput.test.ts \
  test/marketCreationTextBoundaries.test.ts test/oracleAnnouncementTags.test.ts \
  test/oracleBackupCapacity.test.ts test/oracleBackup.test.ts \
  test/oracleBackupAccess.test.ts
```

These checks cover Unicode code points, UTF-8 bytes, malformed surrogates,
serialized metadata, exact boundaries, old-format fixtures, strict compact
schemas, version selection, and observed lifecycle regression. They also check
the conservative reservation for future signing and publication.

`fixtures/oracle-backup-v1.json` is a synthetic test fixture. Its test key is
public and must never hold real authority or funds.

## Real native lifecycle and recovery

Build the native helper from the same source revision as the test checkout.
From the public repository root:

```bash
npm run build:native-oracle-helper --workspace @bitcaster-market/daemon
```

From `bitcaster-daemon/`, set `BITCASTER_TEST_NATIVE_ORACLE_HELPER` to the built
executable, then run:

```bash
node --experimental-strip-types --experimental-test-module-mocks \
  --import ./test/dataDirTestSetup.ts --test --test-concurrency=1 \
  test/oracleBackupCapacity.test.ts test/nativeMarketOracle.test.ts \
  test/nativeOracleBackup.test.ts test/nativeOracleImportedStore.test.ts
```

The capacity matrix must execute, not skip. A missing helper causes real-crypto
tests to skip and does not provide acceptance evidence.

The matrix creates real signed announcements, attestations, and explanations.
It checks version 1 and version 2 encoding, NIP-44 encryption, terminal nonce
retirement, native validation, SQLite restore, and retained retry bytes. It
includes current text limits and the larger compact policy, eight maximum-size
outcomes, multibyte text, JSON escapes, and long event IDs. The measured encoded
size must not exceed its reservation.

Destination URLs in this matrix are serialization data. The matrix does not
call a mint, an engine, or public relays. Real transport checks are separate.

## Browser and WASM

Use the official generated WASM bundle and its provenance check. From
`bitCaster-app/`:

```bash
npx vitest run --config vitest.browser.config.ts \
  src/lib/__tests__/browserOracleBackup.browser.test.ts \
  src/lib/__tests__/browserOraclePublicationHandoff.browser.test.ts
```

Keep the Chromium sandbox enabled. These cases exercise actual WASM validation,
IndexedDB restoration, maximum compact records, and publication handoff. They
supplement the native matrix; they do not prove delivery to a deployed relay.

## Mint registration

From `cdk/`:

```bash
cargo test -j 7 -p cdk --no-default-features --features mint,test-utils \
  serialized_metadata_limit
```

These real registration tests preserve multilingual metadata at 16384 serialized
UTF-8 bytes and reject 16385 bytes before fee validation. They are separate
from the oracle lifecycle matrix.

## Connected acceptance

The embedding application's product suite must exercise the complete creation
and recovery paths through owned local or authorized staging services. Verify
that invalid pasted text remains visible and blocks payment, that maximum
active-policy text reaches persisted mint metadata, and that browser-created
authority restores in an empty native profile. Test English and Japanese error
messages, maturity boundaries, and narrow layouts at their owning UI layer.

Before activating larger inputs, repeat connected acceptance with the compact
writer and larger policy active. Dual-reader success alone does not authorize
writer activation. Keep the current writer and reservation version aligned,
and retain old-format recovery fixtures after activation.
