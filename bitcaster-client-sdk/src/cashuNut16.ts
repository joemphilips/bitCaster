import { getDecodedToken } from "@cashu/cashu-ts";
import { UR, UrFountainDecoder, UrFountainEncoder } from "@qrkit/bc-ur-web";

export const CASHU_NUT16_TOKEN_BYTES_LIMIT_MAX = 256 * 1_024;
export const CASHU_NUT16_PROOF_COUNT_LIMIT_MAX = 256;
export const CASHU_NUT16_FRAGMENT_COUNT_LIMIT_MAX = 2_048;
export const CASHU_NUT16_FRAGMENT_CODE_UNITS_LIMIT_MAX = 2_048;
export const CASHU_NUT16_RECEIVED_FRAGMENT_LIMIT_MAX = 4_096;
export const CASHU_NUT16_MIXED_FRAGMENT_LIMIT_MAX = 64;
export const CASHU_NUT16_DECODER_LIFETIME_MS_MAX = 2 * 60_000;
export const CASHU_NUT16_FRAGMENT_BYTES_MAX = 200;

const CASHU_NUT16_CBOR_OVERHEAD_BYTES_MAX = 16;
const CASHU_NUT16_UR_TYPE = "bytes";

export interface CashuNut16Encoder {
  readonly tokenByteLength: number;
  readonly fragmentCount: number;
  nextPart(): string;
}

export type CashuNut16DecodeResult =
  | {
      kind: "pending";
      progress: number;
      receivedFragmentCount: number;
      expectedFragmentCount: number;
    }
  | {
      kind: "complete";
      token: string;
      tokenByteLength: number;
      proofCount: number;
    };

interface MultipartIdentity {
  type: string;
  sequenceNumber: number;
  sequenceLength: number;
  messageLength: number;
  checksum: number;
}

export class CashuNut16Decoder {
  readonly #decoder = new UrFountainDecoder();
  readonly #seenParts = new Set<string>();
  #identity: MultipartIdentity | null = null;
  #startedAtMs: number | null = null;
  #mixedFragmentCount = 0;
  #closed = false;

  receivePart(
    value: string,
    observedAtMs = Date.now(),
  ): CashuNut16DecodeResult {
    this.#requireOpen();
    const part = requireUrPart(value);
    const observed = requireTimestamp(observedAtMs);
    this.#requireLifetime(observed);
    if (!part.isFragment) {
      this.#closed = true;
      return completeResult(requireBytesUrPayload(part));
    }
    const identity = requireMultipartIdentity(part);
    this.#requireSameSequence(identity);
    const canonicalPart = part.toString();
    if (this.#seenParts.has(canonicalPart)) {
      return this.#pendingResult(identity);
    }
    const workLimit = Math.min(
      CASHU_NUT16_RECEIVED_FRAGMENT_LIMIT_MAX,
      identity.sequenceLength + CASHU_NUT16_MIXED_FRAGMENT_LIMIT_MAX,
    );
    if (this.#seenParts.size >= workLimit) {
      this.close();
      throw new Error("Cashu NUT-16 fragment work limit exceeded");
    }
    if (
      identity.sequenceNumber > identity.sequenceLength &&
      this.#mixedFragmentCount >= CASHU_NUT16_MIXED_FRAGMENT_LIMIT_MAX
    ) {
      this.close();
      throw new Error("Cashu NUT-16 mixed fragment work limit exceeded");
    }
    this.#seenParts.add(canonicalPart);
    if (identity.sequenceNumber > identity.sequenceLength) {
      this.#mixedFragmentCount += 1;
    }
    if (!this.#decoder.receivePartUr(part)) {
      throw new Error("Cashu NUT-16 fragment is corrupt or foreign");
    }
    if (!this.#decoder.isComplete()) return this.#pendingResult(identity);
    if (!this.#decoder.isSuccessful()) {
      throw new Error("Cashu NUT-16 sequence is corrupt");
    }
    const result = this.#decoder.resultUr;
    if (!result || result.type !== CASHU_NUT16_UR_TYPE || result.isFragment) {
      throw new Error("Cashu NUT-16 result is invalid");
    }
    this.#closed = true;
    return completeResult(requireBytesUrPayload(result));
  }

  close(): void {
    this.#closed = true;
    this.#decoder.reset();
    this.#seenParts.clear();
    this.#identity = null;
    this.#mixedFragmentCount = 0;
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("Cashu NUT-16 decoder is closed");
  }

  #requireLifetime(observedAtMs: number): void {
    this.#startedAtMs ??= observedAtMs;
    if (
      observedAtMs < this.#startedAtMs ||
      observedAtMs - this.#startedAtMs > CASHU_NUT16_DECODER_LIFETIME_MS_MAX
    ) {
      this.close();
      throw new Error("Cashu NUT-16 decoder expired");
    }
  }

  #requireSameSequence(identity: MultipartIdentity): void {
    if (this.#identity === null) {
      this.#identity = identity;
      return;
    }
    if (
      this.#identity.type !== identity.type ||
      this.#identity.sequenceLength !== identity.sequenceLength ||
      this.#identity.messageLength !== identity.messageLength ||
      this.#identity.checksum !== identity.checksum
    ) {
      throw new Error("Cashu NUT-16 sequence is mixed or foreign");
    }
  }

  #pendingResult(identity: MultipartIdentity): CashuNut16DecodeResult {
    return {
      kind: "pending",
      progress: Math.min(Math.max(this.#decoder.getProgress(), 0), 1),
      receivedFragmentCount: this.#seenParts.size,
      expectedFragmentCount: identity.sequenceLength,
    };
  }
}

export function createCashuNut16Encoder(token: string): CashuNut16Encoder {
  const bytes = requireCashuToken(token);
  const encoder = new UrFountainEncoder(
    UR.fromCbor({
      type: CASHU_NUT16_UR_TYPE,
      payload: encodeCborByteString(bytes),
    }),
    CASHU_NUT16_FRAGMENT_BYTES_MAX,
    CASHU_NUT16_FRAGMENT_BYTES_MAX,
    0,
    2,
  );
  const fragmentCount = encoder.getPureFragmentCount();
  if (
    fragmentCount < 2 ||
    fragmentCount > CASHU_NUT16_FRAGMENT_COUNT_LIMIT_MAX
  ) {
    throw new Error("Cashu NUT-16 fragment count is unsupported");
  }
  return {
    tokenByteLength: bytes.byteLength,
    fragmentCount,
    nextPart: () => {
      const part = encoder.nextPartUr().toString();
      if (part.length > CASHU_NUT16_FRAGMENT_CODE_UNITS_LIMIT_MAX) {
        throw new Error("Cashu NUT-16 fragment exceeds its display limit");
      }
      return part;
    },
  };
}

function requireUrPart(value: string): UR {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > CASHU_NUT16_FRAGMENT_CODE_UNITS_LIMIT_MAX
  ) {
    throw new Error("Cashu NUT-16 fragment size is invalid");
  }
  let part: UR;
  try {
    part = UR.fromString(value.trim().toLowerCase());
  } catch (error) {
    throw new Error("Cashu NUT-16 fragment is invalid", { cause: error });
  }
  if (part.type !== CASHU_NUT16_UR_TYPE) {
    throw new Error("Cashu NUT-16 fragment type is foreign");
  }
  return part;
}

function requireMultipartIdentity(part: UR): MultipartIdentity {
  let decoded: unknown;
  try {
    decoded = part.decode();
  } catch (error) {
    throw new Error("Cashu NUT-16 fragment payload is corrupt", {
      cause: error,
    });
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 5 ||
    !Number.isSafeInteger(decoded[0]) ||
    !Number.isSafeInteger(decoded[1]) ||
    !Number.isSafeInteger(decoded[2]) ||
    !Number.isSafeInteger(decoded[3]) ||
    !isUint8Array(decoded[4])
  ) {
    throw new Error("Cashu NUT-16 fragment payload is invalid");
  }
  const [sequenceNumber, sequenceLength, messageLength, checksum, fragment] =
    decoded;
  if (
    sequenceNumber < 1 ||
    sequenceLength < 2 ||
    sequenceLength > CASHU_NUT16_FRAGMENT_COUNT_LIMIT_MAX ||
    messageLength < 1 ||
    messageLength >
      CASHU_NUT16_TOKEN_BYTES_LIMIT_MAX + CASHU_NUT16_CBOR_OVERHEAD_BYTES_MAX ||
    checksum < 0 ||
    checksum > 0xffff_ffff ||
    fragment.byteLength < 1 ||
    fragment.byteLength > CASHU_NUT16_FRAGMENT_BYTES_MAX
  ) {
    throw new Error("Cashu NUT-16 fragment payload exceeds its limits");
  }
  return {
    type: part.type,
    sequenceNumber,
    sequenceLength,
    messageLength,
    checksum,
  };
}

function requireBytesUrPayload(value: UR): Uint8Array {
  let decoded: unknown;
  try {
    decoded = value.decode();
  } catch (error) {
    throw new Error("Cashu NUT-16 result is corrupt", { cause: error });
  }
  if (!isUint8Array(decoded)) {
    throw new Error("Cashu NUT-16 result is not a byte payload");
  }
  return decoded as Uint8Array;
}

function completeResult(bytes: Uint8Array): CashuNut16DecodeResult {
  if (bytes.byteLength > CASHU_NUT16_TOKEN_BYTES_LIMIT_MAX) {
    throw new Error("Cashu NUT-16 token exceeds its byte limit");
  }
  let token: string;
  try {
    token = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Cashu NUT-16 token is not UTF-8", { cause: error });
  }
  const exactBytes = requireCashuToken(token);
  const decoded = decodeCashuToken(token);
  return {
    kind: "complete",
    token,
    tokenByteLength: exactBytes.byteLength,
    proofCount: decoded.proofs.length,
  };
}

function requireCashuToken(token: string): Uint8Array {
  if (typeof token !== "string" || !/^cashu[AB]/.test(token)) {
    throw new Error("Cashu NUT-16 payload is not a Cashu token");
  }
  const bytes = new TextEncoder().encode(token);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > CASHU_NUT16_TOKEN_BYTES_LIMIT_MAX
  ) {
    throw new Error("Cashu NUT-16 token exceeds its byte limit");
  }
  decodeCashuToken(token);
  return bytes;
}

function decodeCashuToken(token: string) {
  let decoded: ReturnType<typeof getDecodedToken>;
  try {
    decoded = getDecodedToken(token, []);
  } catch (error) {
    throw new Error("Cashu NUT-16 payload is not a valid Cashu token", {
      cause: error,
    });
  }
  if (
    decoded.proofs.length < 1 ||
    decoded.proofs.length > CASHU_NUT16_PROOF_COUNT_LIMIT_MAX
  ) {
    throw new Error("Cashu NUT-16 proof count is invalid");
  }
  return decoded;
}

function requireTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Cashu NUT-16 observation time is invalid");
  }
  return value;
}

function isUint8Array(value: unknown): boolean {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function encodeCborByteString(bytes: Uint8Array): Uint8Array {
  const length = bytes.byteLength;
  let header: Uint8Array;
  if (length < 24) {
    header = Uint8Array.of(0x40 + length);
  } else if (length <= 0xff) {
    header = Uint8Array.of(0x58, length);
  } else if (length <= 0xffff) {
    header = Uint8Array.of(0x59, length >>> 8, length & 0xff);
  } else {
    header = Uint8Array.of(
      0x5a,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    );
  }
  const encoded = new Uint8Array(header.byteLength + length);
  encoded.set(header);
  encoded.set(bytes, header.byteLength);
  return encoded;
}
