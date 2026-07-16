import assert from "node:assert/strict";
import test from "node:test";
import { Amount, getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { UR, UrFountainEncoder } from "@qrkit/bc-ur-web";
import {
  CASHU_NUT16_DECODER_LIFETIME_MS_MAX,
  CASHU_NUT16_FRAGMENT_COUNT_LIMIT_MAX,
  CASHU_NUT16_FRAGMENT_CODE_UNITS_LIMIT_MAX,
  CASHU_NUT16_MIXED_FRAGMENT_LIMIT_MAX,
  CASHU_NUT16_TOKEN_BYTES_LIMIT_MAX,
  CashuNut16Decoder,
  createCashuNut16Encoder,
} from "../src/cashuNut16.ts";

const INDEPENDENT_TOKEN =
  "cashuBo2FtdGh0dHBzOi8vbWludC5leGFtcGxlYXVjc2F0YXSBomFpSAARIjNEVWZ3YXCBo2FhCGFzeEAxMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExYWNYIQIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIg";

// Generated and pinned with @ngraveio/bc-ur 1.1.13, the implementation linked
// from NUT-16. Keeping the producer outside this dependency catches a
// self-roundtrip-only wire incompatibility.
const INDEPENDENT_PARTS = [
  "ur:bytes/1-5/lpadahcstncyfwneztlehddwhdtpiahsjkiskpfwjleyfgjyieflisdyiefdfwkngwinetkoidhgjzkpiefxecjzihflfgjyiaflksjzhkhdhfimhsfwbgfx",
  "ur:bytes/2-5/lpaoahcstncyfwneztlehddwiaeyfgdyhkhdgufwjljnfgjogufpfpgmgaimglfehfhghteohkhdfxfwjleyfgisfxflfgknihfefpksgtghfeksbnwskglo",
  "ur:bytes/3-5/lpaxahcstncyfwneztlehddwgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksbznyfdlg",
  "ur:bytes/4-5/lpaaahcstncyfwneztlehddwgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfeksgtghfekshkhgglhkgagygainwmfxrolr",
  "ur:bytes/5-5/lpahahcstncyfwneztlehddwgaingaingaingaingaingaingaingaingaingaingaingaingaingaingaingaingaingaingaingaingaioaeaeplcsfssa",
] as const;

test("decodes the pinned independent NUT-16 fixture", () => {
  const decoder = new CashuNut16Decoder();
  for (const [index, part] of INDEPENDENT_PARTS.entries()) {
    const result = decoder.receivePart(part, 1_000 + index);
    if (index < INDEPENDENT_PARTS.length - 1) {
      assert.equal(result.kind, "pending");
      continue;
    }
    assert.deepEqual(result, {
      kind: "complete",
      token: INDEPENDENT_TOKEN,
      tokenByteLength: new TextEncoder().encode(INDEPENDENT_TOKEN).byteLength,
      proofCount: 1,
    });
  }
});

test("encodes and decodes a bounded multipart Cashu token", () => {
  const token = encodedToken(24);
  const encoder = createCashuNut16Encoder(token);
  assert.ok(encoder.fragmentCount >= 2);
  const decoder = new CashuNut16Decoder();
  let completed: ReturnType<CashuNut16Decoder["receivePart"]> | null = null;
  for (let index = 0; index < encoder.fragmentCount; index += 1) {
    completed = decoder.receivePart(encoder.nextPart(), 2_000 + index);
  }
  assert.equal(completed?.kind, "complete");
  if (completed?.kind === "complete") {
    assert.equal(completed.token, token);
    assert.equal(completed.proofCount, 24);
  }
});

test("does not count an exact duplicate fragment twice", () => {
  const decoder = new CashuNut16Decoder();
  const first = decoder.receivePart(INDEPENDENT_PARTS[0], 1_000);
  assert.equal(first.kind, "pending");
  const duplicate = decoder.receivePart(INDEPENDENT_PARTS[0], 1_001);
  assert.deepEqual(duplicate, first);
});

test("canonicalizes fragment aliases before duplicate and work accounting", () => {
  const decoder = new CashuNut16Decoder();
  const first = decoder.receivePart(INDEPENDENT_PARTS[0], 1_000);
  const alias = decoder.receivePart(
    `  ${INDEPENDENT_PARTS[0].toUpperCase()}  `,
    1_001,
  );
  assert.deepEqual(alias, first);
  assert.equal(alias.kind, "pending");
  if (alias.kind === "pending") {
    assert.equal(alias.receivedFragmentCount, 1);
  }
});

test("supports missing and out-of-order fragments without inventing completion", () => {
  const missing = new CashuNut16Decoder();
  for (const [index, part] of INDEPENDENT_PARTS.slice(0, -1).entries()) {
    assert.equal(missing.receivePart(part, 2_000 + index).kind, "pending");
  }
  const outOfOrder = new CashuNut16Decoder();
  let result: ReturnType<CashuNut16Decoder["receivePart"]> | null = null;
  for (const [index, part] of [...INDEPENDENT_PARTS].reverse().entries()) {
    result = outOfOrder.receivePart(part, 3_000 + index);
  }
  assert.equal(result?.kind, "complete");
  if (result?.kind === "complete")
    assert.equal(result.token, INDEPENDENT_TOKEN);
});

test("closes after single-part or multipart completion", () => {
  const single = new CashuNut16Decoder();
  const singlePart = UR.fromCbor({
    type: "bytes",
    payload: encodeCborByteString(new TextEncoder().encode(INDEPENDENT_TOKEN)),
  }).toString();
  assert.equal(single.receivePart(singlePart, 1_000).kind, "complete");
  assert.throws(
    () => single.receivePart(singlePart, 1_001),
    /decoder is closed/,
  );

  const multipart = new CashuNut16Decoder();
  for (const [index, part] of INDEPENDENT_PARTS.entries()) {
    multipart.receivePart(part, 2_000 + index);
  }
  assert.throws(
    () => multipart.receivePart(INDEPENDENT_PARTS[0], 3_000),
    /decoder is closed/,
  );
});

test("rejects mixed, foreign, corrupt, and expired sequences", () => {
  const decoder = new CashuNut16Decoder();
  decoder.receivePart(INDEPENDENT_PARTS[0], 1_000);
  const foreign = createCashuNut16Encoder(encodedToken(8)).nextPart();
  assert.throws(() => decoder.receivePart(foreign, 1_001), /mixed or foreign/);
  assert.throws(
    () =>
      new CashuNut16Decoder().receivePart(
        `${INDEPENDENT_PARTS[0].slice(0, 60)}x${INDEPENDENT_PARTS[0].slice(61)}`,
        1_000,
      ),
    /invalid|corrupt/,
  );
  assert.throws(
    () =>
      new CashuNut16Decoder().receivePart(
        INDEPENDENT_PARTS[0].replace("ur:bytes", "ur:crypto-seed"),
        1_000,
      ),
    /type is foreign/,
  );
  const expired = new CashuNut16Decoder();
  expired.receivePart(INDEPENDENT_PARTS[0], 1_000);
  assert.throws(
    () =>
      expired.receivePart(
        INDEPENDENT_PARTS[1],
        1_000 + CASHU_NUT16_DECODER_LIFETIME_MS_MAX + 1,
      ),
    /expired/,
  );
});

test("rejects advertised sizes, fragment counts, and display input above bounds", () => {
  const oversized = new Uint8Array(CASHU_NUT16_TOKEN_BYTES_LIMIT_MAX + 32).fill(
    0x61,
  );
  const oversizedEncoder = new UrFountainEncoder(
    UR.fromCbor({
      type: "bytes",
      payload: encodeCborByteString(oversized),
    }),
    200,
    200,
    0,
    2,
  );
  assert.throws(
    () =>
      new CashuNut16Decoder().receivePart(
        oversizedEncoder.nextPartUr().toString(),
        1_000,
      ),
    /exceeds its limits/,
  );

  const excessiveFragments = new UrFountainEncoder(
    UR.fromCbor({
      type: "bytes",
      payload: encodeCborByteString(new Uint8Array(65_536)),
    }),
    1,
    1,
    0,
    2,
  );
  assert.ok(
    excessiveFragments.getPureFragmentCount() >
      CASHU_NUT16_FRAGMENT_COUNT_LIMIT_MAX,
  );
  assert.throws(
    () =>
      new CashuNut16Decoder().receivePart(
        excessiveFragments.nextPartUr().toString(),
        1_000,
      ),
    /exceeds its limits/,
  );

  assert.throws(
    () =>
      new CashuNut16Decoder().receivePart(
        `ur:bytes/${"a".repeat(CASHU_NUT16_FRAGMENT_CODE_UNITS_LIMIT_MAX)}`,
        1_000,
      ),
    /fragment size is invalid/,
  );
});

test("rejects a token above the proof-count limit before encoding", () => {
  assert.throws(
    () => createCashuNut16Encoder(encodedToken(257)),
    /proof count/,
  );
});

test("closes before excess mixed fountain work can exhaust the decoder", () => {
  const encoder = new UrFountainEncoder(
    UR.fromCbor({
      type: "bytes",
      payload: encodeCborByteString(new Uint8Array(65_536)),
    }),
    200,
    200,
    0,
    2,
  );
  const pureFragmentCount = encoder.getPureFragmentCount();
  assert.ok(pureFragmentCount > CASHU_NUT16_MIXED_FRAGMENT_LIMIT_MAX);
  for (let index = 0; index < pureFragmentCount; index += 1) {
    encoder.nextPartUr();
  }

  const decoder = new CashuNut16Decoder();
  for (
    let index = 0;
    index < CASHU_NUT16_MIXED_FRAGMENT_LIMIT_MAX;
    index += 1
  ) {
    assert.equal(
      decoder.receivePart(encoder.nextPartUr().toString(), 1_000 + index).kind,
      "pending",
    );
  }
  assert.throws(
    () =>
      decoder.receivePart(
        encoder.nextPartUr().toString(),
        1_000 + CASHU_NUT16_MIXED_FRAGMENT_LIMIT_MAX,
      ),
    /mixed fragment work limit/,
  );
  assert.throws(
    () => decoder.receivePart(encoder.nextPartUr().toString(), 2_000),
    /decoder is closed/,
  );
});

function encodedToken(proofCount: number): string {
  return getEncodedTokenV4({
    mint: "https://mint.example",
    unit: "sat",
    proofs: Array.from({ length: proofCount }, (_, index) => proof(index)),
  });
}

function proof(index: number): Proof {
  return {
    id: "0011223344556677",
    amount: Amount.from(1),
    secret: index.toString(16).padStart(64, "0"),
    C: `02${(index + 1).toString(16).padStart(64, "0")}`,
  };
}

function encodeCborByteString(bytes: Uint8Array): Uint8Array {
  const length = bytes.byteLength;
  const header =
    length < 24
      ? Uint8Array.of(0x40 + length)
      : length <= 0xff
        ? Uint8Array.of(0x58, length)
        : length <= 0xffff
          ? Uint8Array.of(0x59, length >>> 8, length & 0xff)
          : Uint8Array.of(
              0x5a,
              (length >>> 24) & 0xff,
              (length >>> 16) & 0xff,
              (length >>> 8) & 0xff,
              length & 0xff,
            );
  const encoded = new Uint8Array(header.byteLength + length);
  encoded.set(header);
  encoded.set(bytes, header.byteLength);
  return encoded;
}
