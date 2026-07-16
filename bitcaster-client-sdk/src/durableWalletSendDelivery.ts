import { Amount, getDecodedToken, type Proof } from "@cashu/cashu-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { sameCashuProofArtifact } from "./proofSelection.ts";

export const DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX = 8 * 1_024 * 1_024;
export const DURABLE_WALLET_SEND_PROOF_COUNT_LIMIT_MAX = 256;
export const DURABLE_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX = 10 * 1_024 * 1_024;
export const DURABLE_WALLET_SEND_NATIVE_OPERATION_BYTES_LIMIT_MAX =
  1 * 1_024 * 1_024;

const DURABLE_WALLET_SEND_TOKEN_BASE_BYTES_UPPER_BOUND = 4 * 1_024;
const DURABLE_WALLET_SEND_TOKEN_PROOF_BYTES_UPPER_BOUND = 1 * 1_024;
const DURABLE_WALLET_SEND_STORAGE_ROW_BYTES_UPPER_BOUND = 4 * 1_024;
const DURABLE_WALLET_SEND_RESULT_PROOF_ROW_BYTES_UPPER_BOUND = 8 * 1_024;
const DURABLE_WALLET_SEND_NATIVE_OPERATION_BASE_BYTES_UPPER_BOUND = 48 * 1_024;
const DURABLE_WALLET_SEND_OUTPUT_ARTIFACT_OVERHEAD_BYTES = 4 * 1_024;
const DURABLE_WALLET_SEND_PROOF_ARTIFACT_OVERHEAD_BYTES = 4 * 1_024;
const DURABLE_WALLET_SEND_CANONICAL_JSON_EXPANSION = 4;
const DURABLE_WALLET_SEND_CUSTODY_ROWS_BYTES_UPPER_BOUND = 64 * 1_024;
const DURABLE_WALLET_SEND_INDEX_OVERHEAD_BYTES_UPPER_BOUND = 64 * 1_024;
const DURABLE_WALLET_SEND_RESULT_PROOF_COUNT_LIMIT_MAX = 512;

const WALLET_SEND_TOKEN_DIGEST_DOMAIN = new TextEncoder().encode(
  "bitcaster/durable-wallet-send-token/v1\0",
);

export interface DurableWalletSendTokenDescriptor {
  schemaVersion: 1;
  byteLength: number;
  tokenDigest: string;
}

export interface DurableWalletSendDeliveryLimits {
  encodedTokenBytes: number;
  proofCount: number;
  durableStorageBytes: number;
  nativeOperationRowBytes: number;
}

export interface DurableWalletSendDeliveryAdmission {
  schemaVersion: 1;
  encodedTokenBytesLimit: number;
  proofCountLimit: number;
  durableStorageBytesLimit: number;
  nativeOperationRowBytesLimit: number;
  sendProofCount: number;
  resultProofCount: number;
  encodedTokenBytesUpperBound: number;
  nativeOperationRowBytesUpperBound: number;
  durableStorageBytesRequired: number;
}

interface DurableWalletSendOutputPlan {
  mintUrl: string;
  unit: string;
  sendOutputs: readonly {
    secret: string;
    blindedMessage: { id: string };
  }[];
  keepOutputs?: readonly {
    secret: string;
    blindedMessage: { id: string };
  }[];
  passthroughProofs?: readonly {
    secret: string;
    id: string;
    amount?: unknown;
    C?: unknown;
    dleq?: unknown;
    p2pkE?: unknown;
    p2pk_e?: unknown;
    witness?: unknown;
  }[];
  inputProofs?: readonly {
    secret: string;
    id: string;
    amount?: unknown;
    C?: unknown;
    dleq?: unknown;
    p2pkE?: unknown;
    p2pk_e?: unknown;
    witness?: unknown;
  }[];
}

/**
 * Admits the exact send-output plan before mint transport. The bound includes
 * the known output secret/keyset bytes plus deliberately conservative CBOR,
 * proof-signature, DLEQ, token-header, and physical-row overhead.
 */
export function planDurableWalletSendDeliveryAdmission(input: {
  outputPlan: DurableWalletSendOutputPlan;
  limits: DurableWalletSendDeliveryLimits;
}): DurableWalletSendDeliveryAdmission {
  const mintUrl = normalizeMintUrl(input.outputPlan.mintUrl);
  const unit = requireBoundedText(input.outputPlan.unit, "unit", 64);
  const limits = requireDeliveryLimits(input.limits);
  const outputs = input.outputPlan.sendOutputs;
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error("durable wallet-send output plan is empty");
  }
  if (outputs.length > limits.proofCount) {
    throw new Error(
      "durable wallet-send output plan exceeds its proof count limit",
    );
  }
  let encodedTokenBytesUpperBound =
    DURABLE_WALLET_SEND_TOKEN_BASE_BYTES_UPPER_BOUND +
    utf8Bytes(mintUrl) +
    utf8Bytes(unit);
  for (const output of outputs) {
    if (typeof output !== "object" || output === null) {
      throw new Error("durable wallet-send output plan is invalid");
    }
    const secret = requireBoundedText(output.secret, "output secret", 2_048);
    const keysetId = requireBoundedText(
      output.blindedMessage?.id,
      "output keyset id",
      512,
    );
    encodedTokenBytesUpperBound +=
      DURABLE_WALLET_SEND_TOKEN_PROOF_BYTES_UPPER_BOUND +
      utf8Bytes(secret) +
      utf8Bytes(keysetId);
  }
  const keepOutputs = input.outputPlan.keepOutputs ?? [];
  const passthroughProofs = input.outputPlan.passthroughProofs ?? [];
  const inputProofs = input.outputPlan.inputProofs ?? [];
  const outputArtifactBytes = [...outputs, ...keepOutputs].map((output) =>
    plannedOutputArtifactBytes(output.secret, output.blindedMessage?.id),
  );
  const passthroughArtifactBytes = passthroughProofs.map(
    plannedProofArtifactBytes,
  );
  const inputArtifactBytes = inputProofs.map(plannedProofArtifactBytes);
  const resultProofCount =
    outputs.length + keepOutputs.length + passthroughProofs.length;
  if (resultProofCount > DURABLE_WALLET_SEND_RESULT_PROOF_COUNT_LIMIT_MAX) {
    throw new Error(
      "durable wallet-send output plan exceeds its result proof limit",
    );
  }
  const generatedProofBytes = outputArtifactBytes.map(
    (bytes) => bytes + DURABLE_WALLET_SEND_PROOF_ARTIFACT_OVERHEAD_BYTES,
  );
  const nativeOperationRowBytesUpperBound =
    DURABLE_WALLET_SEND_NATIVE_OPERATION_BASE_BYTES_UPPER_BOUND +
    sumBytes(inputArtifactBytes) * 2 +
    sumBytes(passthroughArtifactBytes) * 3 +
    sumBytes(outputArtifactBytes) * 2 +
    sumBytes(generatedProofBytes);
  if (nativeOperationRowBytesUpperBound > limits.nativeOperationRowBytes) {
    throw new Error(
      "durable wallet-send output plan exceeds its native operation row limit",
    );
  }
  const durableStorageBytesRequired =
    encodedTokenBytesUpperBound +
    DURABLE_WALLET_SEND_STORAGE_ROW_BYTES_UPPER_BOUND +
    resultProofCount * DURABLE_WALLET_SEND_RESULT_PROOF_ROW_BYTES_UPPER_BOUND +
    nativeOperationRowBytesUpperBound +
    DURABLE_WALLET_SEND_CUSTODY_ROWS_BYTES_UPPER_BOUND +
    DURABLE_WALLET_SEND_INDEX_OVERHEAD_BYTES_UPPER_BOUND;
  if (encodedTokenBytesUpperBound > limits.encodedTokenBytes) {
    throw new Error(
      "durable wallet-send output plan exceeds its token byte limit",
    );
  }
  if (durableStorageBytesRequired > limits.durableStorageBytes) {
    throw new Error(
      "durable wallet-send output plan exceeds its storage limit",
    );
  }
  return {
    schemaVersion: 1,
    encodedTokenBytesLimit: limits.encodedTokenBytes,
    proofCountLimit: limits.proofCount,
    durableStorageBytesLimit: limits.durableStorageBytes,
    nativeOperationRowBytesLimit: limits.nativeOperationRowBytes,
    sendProofCount: outputs.length,
    resultProofCount,
    encodedTokenBytesUpperBound,
    nativeOperationRowBytesUpperBound,
    durableStorageBytesRequired,
  };
}

export function requireDurableWalletSendDeliveryAdmission(
  value: unknown,
): DurableWalletSendDeliveryAdmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("durable wallet-send delivery admission is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "encodedTokenBytesLimit",
    "proofCountLimit",
    "durableStorageBytesLimit",
    "nativeOperationRowBytesLimit",
    "sendProofCount",
    "resultProofCount",
    "encodedTokenBytesUpperBound",
    "nativeOperationRowBytesUpperBound",
    "durableStorageBytesRequired",
  ];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    record.schemaVersion !== 1
  ) {
    throw new Error("durable wallet-send delivery admission is invalid");
  }
  const limits = requireDeliveryLimits({
    encodedTokenBytes: record.encodedTokenBytesLimit,
    proofCount: record.proofCountLimit,
    durableStorageBytes: record.durableStorageBytesLimit,
    nativeOperationRowBytes: record.nativeOperationRowBytesLimit,
  });
  const sendProofCount = requirePositiveSafeInteger(
    record.sendProofCount,
    "send proof count",
  );
  const encodedTokenBytesUpperBound = requirePositiveSafeInteger(
    record.encodedTokenBytesUpperBound,
    "token byte upper bound",
  );
  const resultProofCount = requirePositiveSafeInteger(
    record.resultProofCount,
    "result proof count",
  );
  const durableStorageBytesRequired = requirePositiveSafeInteger(
    record.durableStorageBytesRequired,
    "storage byte requirement",
  );
  const nativeOperationRowBytesUpperBound = requirePositiveSafeInteger(
    record.nativeOperationRowBytesUpperBound,
    "native operation row byte upper bound",
  );
  if (
    sendProofCount > limits.proofCount ||
    resultProofCount < sendProofCount ||
    resultProofCount > DURABLE_WALLET_SEND_RESULT_PROOF_COUNT_LIMIT_MAX ||
    encodedTokenBytesUpperBound > limits.encodedTokenBytes ||
    nativeOperationRowBytesUpperBound > limits.nativeOperationRowBytes ||
    nativeOperationRowBytesUpperBound <
      DURABLE_WALLET_SEND_NATIVE_OPERATION_BASE_BYTES_UPPER_BOUND +
        resultProofCount *
          (DURABLE_WALLET_SEND_OUTPUT_ARTIFACT_OVERHEAD_BYTES +
            DURABLE_WALLET_SEND_PROOF_ARTIFACT_OVERHEAD_BYTES) ||
    durableStorageBytesRequired > limits.durableStorageBytes ||
    durableStorageBytesRequired <
      encodedTokenBytesUpperBound +
        DURABLE_WALLET_SEND_STORAGE_ROW_BYTES_UPPER_BOUND +
        resultProofCount *
          DURABLE_WALLET_SEND_RESULT_PROOF_ROW_BYTES_UPPER_BOUND +
        nativeOperationRowBytesUpperBound +
        DURABLE_WALLET_SEND_CUSTODY_ROWS_BYTES_UPPER_BOUND +
        DURABLE_WALLET_SEND_INDEX_OVERHEAD_BYTES_UPPER_BOUND
  ) {
    throw new Error("durable wallet-send delivery admission is invalid");
  }
  return {
    schemaVersion: 1,
    encodedTokenBytesLimit: limits.encodedTokenBytes,
    proofCountLimit: limits.proofCount,
    durableStorageBytesLimit: limits.durableStorageBytes,
    nativeOperationRowBytesLimit: limits.nativeOperationRowBytes,
    sendProofCount,
    resultProofCount,
    encodedTokenBytesUpperBound,
    nativeOperationRowBytesUpperBound,
    durableStorageBytesRequired,
  };
}

export function requireDurableWalletSendResultWithinAdmission(input: {
  admission: unknown;
  encodedToken: string;
  sendProofCount: number;
  resultProofCount: number;
}): DurableWalletSendTokenDescriptor {
  const admission = requireDurableWalletSendDeliveryAdmission(input.admission);
  const descriptor = describeDurableWalletSendToken(input.encodedToken);
  if (
    input.sendProofCount !== admission.sendProofCount ||
    input.resultProofCount !== admission.resultProofCount ||
    descriptor.byteLength > admission.encodedTokenBytesUpperBound ||
    descriptor.byteLength > admission.encodedTokenBytesLimit
  ) {
    throw new Error("durable wallet-send result exceeds its admitted envelope");
  }
  return descriptor;
}

export function describeDurableWalletSendToken(
  encodedToken: string,
): DurableWalletSendTokenDescriptor {
  if (typeof encodedToken !== "string" || encodedToken.length === 0) {
    throw new Error("durable wallet-send token is invalid");
  }
  if (encodedToken.length > DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX) {
    throw new Error("durable wallet-send token exceeds the byte limit");
  }
  const bytes = new TextEncoder().encode(encodedToken);
  if (bytes.byteLength > DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX) {
    throw new Error("durable wallet-send token exceeds the byte limit");
  }
  return {
    schemaVersion: 1,
    byteLength: bytes.byteLength,
    tokenDigest: bytesToHex(
      sha256(concatBytes(WALLET_SEND_TOKEN_DIGEST_DOMAIN, bytes)),
    ),
  };
}

export function requireExactDurableWalletSendToken(input: {
  encodedToken: string;
  mintUrl: string;
  unit: string;
  sendProofs: readonly Proof[];
}): DurableWalletSendTokenDescriptor {
  const descriptor = describeDurableWalletSendToken(input.encodedToken);
  if (input.sendProofs.length === 0) {
    throw new Error("durable wallet-send result is empty");
  }
  let decoded;
  try {
    decoded = getDecodedToken(
      input.encodedToken,
      input.sendProofs.map(({ id }) => id),
    );
  } catch (error) {
    throw new Error("durable wallet-send token is invalid", { cause: error });
  }
  if (
    normalizeMintUrl(decoded.mint) !== normalizeMintUrl(input.mintUrl) ||
    decoded.unit !== input.unit ||
    decoded.proofs.length !== input.sendProofs.length ||
    decoded.proofs.some((proof, index) => {
      const expected = input.sendProofs[index];
      return expected === undefined || !sameCashuProofArtifact(proof, expected);
    })
  ) {
    throw new Error("durable wallet-send token conflicts with its result");
  }
  return descriptor;
}

function normalizeMintUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error("durable wallet-send mint is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("durable wallet-send mint is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("durable wallet-send mint is invalid");
  }
  return parsed.href.replace(/\/+$/, "");
}

function requireDeliveryLimits(
  value: DurableWalletSendDeliveryLimits | Record<string, unknown>,
): DurableWalletSendDeliveryLimits {
  const encodedTokenBytes = requirePositiveSafeInteger(
    value.encodedTokenBytes,
    "token byte limit",
  );
  const proofCount = requirePositiveSafeInteger(
    value.proofCount,
    "proof count limit",
  );
  const durableStorageBytes = requirePositiveSafeInteger(
    value.durableStorageBytes,
    "storage byte limit",
  );
  const nativeOperationRowBytes = requirePositiveSafeInteger(
    value.nativeOperationRowBytes,
    "native operation row byte limit",
  );
  if (
    encodedTokenBytes > DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX ||
    proofCount > DURABLE_WALLET_SEND_PROOF_COUNT_LIMIT_MAX ||
    durableStorageBytes > DURABLE_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX ||
    nativeOperationRowBytes >
      DURABLE_WALLET_SEND_NATIVE_OPERATION_BYTES_LIMIT_MAX
  ) {
    throw new Error("durable wallet-send delivery limits are invalid");
  }
  return {
    encodedTokenBytes,
    proofCount,
    durableStorageBytes,
    nativeOperationRowBytes,
  };
}

function plannedOutputArtifactBytes(
  secretValue: unknown,
  idValue: unknown,
): number {
  const secret = requireBoundedText(secretValue, "output secret", 2_048);
  const id = requireBoundedText(idValue, "output keyset id", 512);
  return (
    DURABLE_WALLET_SEND_OUTPUT_ARTIFACT_OVERHEAD_BYTES +
    DURABLE_WALLET_SEND_CANONICAL_JSON_EXPANSION *
      (utf8Bytes(secret) + utf8Bytes(id))
  );
}

function plannedProofArtifactBytes(
  proof: DurableWalletSendOutputPlan["passthroughProofs"] extends
    | readonly (infer T)[]
    | undefined
    ? T
    : never,
): number {
  if (typeof proof !== "object" || proof === null) {
    throw new Error("durable wallet-send proof artifact is invalid");
  }
  const allowedFields = new Set([
    "id",
    "amount",
    "secret",
    "C",
    "dleq",
    "p2pkE",
    "p2pk_e",
    "witness",
  ]);
  if (Object.keys(proof).some((field) => !allowedFields.has(field))) {
    throw new Error("durable wallet-send proof artifact is invalid");
  }
  const textBytes = [
    requireBoundedText(proof.secret, "proof secret", 16_384),
    requireBoundedText(proof.id, "proof keyset id", 512),
    optionalBoundedText(proof.amount, "proof amount", 128),
    optionalBoundedText(proof.C, "proof signature", 96),
    optionalBoundedText(proof.p2pkE ?? proof.p2pk_e, "proof ephemeral key", 66),
    optionalBoundedText(proof.witness, "proof witness", 16_384),
    ...plannedDleqTexts(proof.dleq),
  ].reduce((sum, value) => sum + utf8Bytes(value), 0);
  return (
    DURABLE_WALLET_SEND_PROOF_ARTIFACT_OVERHEAD_BYTES +
    DURABLE_WALLET_SEND_CANONICAL_JSON_EXPANSION * textBytes
  );
}

function plannedDleqTexts(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("durable wallet-send proof dleq is invalid");
  }
  const dleq = value as Record<string, unknown>;
  if (Object.keys(dleq).some((field) => !["e", "s", "r"].includes(field))) {
    throw new Error("durable wallet-send proof dleq is invalid");
  }
  return [
    optionalBoundedText(dleq.e, "proof dleq e", 512),
    optionalBoundedText(dleq.s, "proof dleq s", 512),
    optionalBoundedText(dleq.r, "proof dleq r", 512),
  ];
}

function optionalBoundedText(
  value: unknown,
  name: string,
  maxCodeUnits: number,
): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "bigint") {
    value = value.toString();
  } else if (value instanceof Amount) {
    value = value.toBigInt().toString();
  }
  return requireBoundedText(value, name, maxCodeUnits);
}

function sumBytes(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`durable wallet-send ${name} is invalid`);
  }
  return value as number;
}

function requireBoundedText(
  value: unknown,
  name: string,
  maxCodeUnits: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxCodeUnits
  ) {
    throw new Error(`durable wallet-send ${name} is invalid`);
  }
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
