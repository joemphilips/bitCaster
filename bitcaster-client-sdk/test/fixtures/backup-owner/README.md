# Owner account byte vectors

Run `node test/fixtures/backup-owner/generate.mjs` from the SDK directory.
The generator imports no SDK module and no CBOR library. It uses a small CBOR
encoder, Node HKDF/SHA256, and the existing Schnorr primitive. It derives the
fixed request key independently from the documented seed/realm domains.
The fixed counter-zero scalar is valid for this fixture.

The seed and account key are public test data. Zero auxiliary randomness is
only a vector input. Production uses fresh runtime randomness.

`vectors.json` records the owner preimages, intent, account credential,
authorized inner request, possession preimage/digest/signature, and complete
outer request. The SDK test compares complete bytes, not only a round trip.
Encryption, wallet identity and request-key derivation stay unchanged.

Run `node test/fixtures/backup-owner/generate-http.mjs` to reproduce
`http-vectors.json`. This generator uses its own CBOR encoder. It reads the
independent account and request vectors. It does not import an SDK encoder.
The vectors fix the owner HTTP envelope, error, discovery refusal, and account
result bytes. Ciphertext object and signed mutation formats keep their existing
independent vectors.
