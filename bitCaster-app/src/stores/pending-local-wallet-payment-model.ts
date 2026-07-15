import { Amount, getEncodedTokenV4, type Proof } from "@cashu/cashu-ts";
import { DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX } from "@bitcaster/client-sdk/durableCustody";
import {
  COLLATERAL_UNIT_REGISTRY,
  parseMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import {
  amountToNumber,
  sameCashuProofArtifact,
  type CashuProofArtifactLike,
} from "@bitcaster/client-sdk/proofSelection";
import type { components } from "@/generated/api";
import { normalizeUrl } from "@/lib/url";

const IDENTIFIER_MAX_LENGTH = 256;
const PROOF_FIELD_MAX_LENGTH = 4_096;
const PROOF_SERIALIZED_MAX_BYTES = 16_384;
const WITNESS_SIGNATURE_LIMIT = 64;
const ERROR_MAX_LENGTH = 1_024;
const RETRY_COUNT_MAX = 16;
export const PENDING_ECASH_DEPOSIT_TOKEN_MAX_BYTES = 8 * 1024 * 1024;
const DEPOSIT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type DepositState = components["schemas"]["DepositState"];

export type PendingEcashDepositRemoteState = Exclude<DepositState, "credited">;
export type PendingEcashDepositRecoveryState = "active" | "blocked";

export interface PendingEcashDepositSerializedToken {
  schemaVersion: 1;
  encoding: "utf-8";
  bytes: Uint8Array;
}

export class PendingEcashDepositAuthorityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PendingEcashDepositAuthorityError";
  }
}

export interface PendingEcashDepositRequest {
  conditionId: string;
  mintUrl: string;
  amountSubunits: number;
  baseAsset: MarketBaseAsset;
  unit: CashuProofUnit;
  divisibility: number;
  fundAmm: boolean;
  creatorPubkey: string | null;
  /** Scheme-agnostic authenticated identity bound to the original POST. */
  fundingIdentity: string;
}

interface PendingEcashDepositBase {
  depositId: string;
  splitOperationId: string;
  request: PendingEcashDepositRequest;
  remoteState: PendingEcashDepositRemoteState | null;
  createdAt: number;
  updatedAt: number;
  retryCount: number;
  nextAttemptAt: number;
  lastError: string | null;
  recoveryState: PendingEcashDepositRecoveryState;
}

export interface PreparedPendingEcashDeposit extends PendingEcashDepositBase {
  phase: "prepared";
}

export interface ReservedPendingEcashDeposit extends PendingEcashDepositBase {
  phase: "reserved";
  sendProofs: Proof[];
  serializedToken: PendingEcashDepositSerializedToken;
}

export type PendingLocalWalletPaymentRecord =
  | PreparedPendingEcashDeposit
  | ReservedPendingEcashDeposit;

export type PendingLocalWalletPaymentRow = PendingLocalWalletPaymentRecord & {
  walletId: string;
};

export type NewPreparedPendingEcashDeposit = Omit<
  PreparedPendingEcashDeposit,
  "lastError" | "remoteState" | "retryCount" | "nextAttemptAt" | "recoveryState"
> & {
  lastError?: string | null;
  remoteState?: null;
  retryCount?: 0;
  nextAttemptAt?: number;
  recoveryState?: "active";
};

export function depositSplitOperationId(depositId: string): string {
  return `ecash-deposit-split:${requireDepositId(depositId)}`;
}

export function normalizePendingPaymentRow(
  candidate: unknown,
  walletId: string,
): PendingLocalWalletPaymentRow {
  const row = requireObject(candidate);
  const common = normalizeCommonPayment(row, walletId);
  switch (row.phase) {
    case "prepared":
      requireExactKeys(
        row,
        [
          "walletId",
          "depositId",
          "splitOperationId",
          "phase",
          "request",
          "remoteState",
          "createdAt",
          "updatedAt",
          "retryCount",
          "nextAttemptAt",
          "lastError",
          "recoveryState",
        ],
        "record",
      );
      if (common.remoteState !== null) {
        throw new Error("Prepared ecash deposit cannot have remote progress");
      }
      return { ...common, phase: "prepared" };
    case "reserved":
      requireExactKeys(
        row,
        [
          "walletId",
          "depositId",
          "splitOperationId",
          "phase",
          "request",
          "remoteState",
          "createdAt",
          "updatedAt",
          "retryCount",
          "nextAttemptAt",
          "lastError",
          "sendProofs",
          "serializedToken",
          "recoveryState",
        ],
        "record",
      );
      return {
        ...common,
        phase: "reserved",
        sendProofs: requireSendProofs(row.sendProofs, common.request),
        serializedToken: normalizePendingEcashDepositSerializedToken(
          row.serializedToken,
        ),
      };
    default:
      throw new Error("Pending ecash deposit phase is invalid");
  }
}

export function requirePendingPaymentRow(
  row: PendingLocalWalletPaymentRow | undefined,
  walletId: string,
  depositId: string,
): PendingLocalWalletPaymentRow | undefined {
  if (!row) return undefined;
  const normalized = normalizePendingPaymentRow(row, walletId);
  if (normalized.depositId !== requireDepositId(depositId)) {
    throw new Error("Pending ecash deposit identity is invalid");
  }
  return normalized;
}

export function samePaymentProofSet(
  left: readonly CashuProofArtifactLike[],
  right: readonly CashuProofArtifactLike[],
): boolean {
  if (left.length !== right.length) return false;
  const rightBySecret = new Map(right.map((proof) => [proof.secret, proof]));
  return left.every((proof) =>
    samePaymentProofValue(proof, rightBySecret.get(proof.secret)),
  );
}

export function samePaymentProofValue(
  left: CashuProofArtifactLike,
  right: CashuProofArtifactLike | undefined,
): boolean {
  return sameCashuProofArtifact(left, right);
}

export function requireDepositId(value: unknown): string {
  if (typeof value !== "string" || !DEPOSIT_ID_PATTERN.test(value)) {
    throw new Error("Pending ecash deposit identifier is invalid");
  }
  return value;
}

export function pendingPaymentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/cashu[AB][A-Za-z0-9_-]+/g, "[redacted ecash token]")
    .slice(0, ERROR_MAX_LENGTH);
}

export function serializePendingEcashDepositToken(
  token: string,
): PendingEcashDepositSerializedToken {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Pending ecash deposit serialized token is invalid");
  }
  return normalizePendingEcashDepositSerializedToken({
    schemaVersion: 1,
    encoding: "utf-8",
    bytes: new TextEncoder().encode(token),
  });
}

export function decodePendingEcashDepositToken(
  artifact: PendingEcashDepositSerializedToken,
): string {
  const normalized = normalizePendingEcashDepositSerializedToken(artifact);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(normalized.bytes);
  } catch (error) {
    throw new Error("Pending ecash deposit serialized token is invalid", {
      cause: error,
    });
  }
}

export function assertPendingEcashDepositTokenMatchesProofs(
  artifact: PendingEcashDepositSerializedToken,
  request: PendingEcashDepositRequest,
  sendProofs: readonly Proof[],
): void {
  const serialized = decodePendingEcashDepositToken(artifact);
  try {
    const expected = getEncodedTokenV4({
      mint: request.mintUrl,
      unit: request.unit,
      proofs: [...sendProofs],
    });
    if (serialized !== expected) {
      throw new Error("canonical token changed");
    }
  } catch (error) {
    throw new Error(
      "Pending ecash deposit serialized token does not match its proofs",
      { cause: error },
    );
  }
}

export function samePendingEcashDepositSerializedToken(
  left: PendingEcashDepositSerializedToken,
  right: PendingEcashDepositSerializedToken,
): boolean {
  const leftBytes = left.bytes;
  const rightBytes = right.bytes;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.encoding === right.encoding &&
    leftBytes.length === rightBytes.length &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}

export function normalizePendingEcashDepositSerializedToken(
  value: unknown,
): PendingEcashDepositSerializedToken {
  const artifact = requireObject(value);
  requireExactKeys(
    artifact,
    ["schemaVersion", "encoding", "bytes"],
    "serialized token",
  );
  if (
    artifact.schemaVersion !== 1 ||
    artifact.encoding !== "utf-8" ||
    !isUint8Array(artifact.bytes) ||
    artifact.bytes.byteLength === 0 ||
    artifact.bytes.byteLength > PENDING_ECASH_DEPOSIT_TOKEN_MAX_BYTES
  ) {
    throw new Error("Pending ecash deposit serialized token is invalid");
  }
  const bytes = new Uint8Array(artifact.bytes);
  try {
    const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (token.length === 0) {
      throw new Error("empty token");
    }
  } catch (error) {
    throw new Error("Pending ecash deposit serialized token is invalid", {
      cause: error,
    });
  }
  return { schemaVersion: 1, encoding: "utf-8", bytes };
}

function isUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

export function normalizePendingPaymentProofs(
  candidate: unknown,
  label: string,
): Proof[] {
  return requireProofArray(candidate, label);
}

function normalizeCommonPayment(
  row: Record<string, unknown>,
  walletId: string,
): PendingEcashDepositBase & { walletId: string } {
  const depositId = requireDepositId(row.depositId);
  const splitOperationId = requireBoundedString(
    row.splitOperationId,
    "split operation identifier",
  );
  if (splitOperationId !== depositSplitOperationId(depositId)) {
    throw new Error("Pending ecash deposit split identity is invalid");
  }
  const createdAt = requireTimestamp(row.createdAt);
  const updatedAt = requireTimestamp(row.updatedAt);
  const retryCount = requireRetryCount(row.retryCount);
  const nextAttemptAt = requireTimestamp(row.nextAttemptAt);
  if (updatedAt < createdAt || nextAttemptAt < createdAt) {
    throw new Error("Pending ecash deposit timestamps are invalid");
  }
  return {
    walletId: requireWallet(row.walletId, walletId),
    depositId,
    splitOperationId,
    request: requireRequest(row.request),
    remoteState: requireRemoteState(row.remoteState),
    createdAt,
    updatedAt,
    retryCount,
    nextAttemptAt,
    lastError: requireLastError(row.lastError),
    recoveryState: requireRecoveryState(row.recoveryState),
  };
}

function requireRequest(candidate: unknown): PendingEcashDepositRequest {
  const request = requireObject(candidate);
  requireExactKeys(
    request,
    [
      "conditionId",
      "mintUrl",
      "amountSubunits",
      "baseAsset",
      "unit",
      "divisibility",
      "fundAmm",
      "creatorPubkey",
      "fundingIdentity",
    ],
    "request",
  );
  const unit = parseCashuProofUnit(
    requireBoundedString(request.unit, "Cashu unit"),
  );
  if (!unit) throw new Error("Pending ecash deposit Cashu unit is invalid");
  const persistedBaseAsset = requireBoundedString(
    request.baseAsset,
    "base asset",
  );
  const baseAsset = parseMarketBaseAsset(persistedBaseAsset);
  if (!baseAsset || baseAsset !== persistedBaseAsset) {
    throw new Error("Pending ecash deposit base asset is invalid");
  }
  if (COLLATERAL_UNIT_REGISTRY[unit].baseAsset !== baseAsset) {
    throw new Error("Pending ecash deposit unit does not match its base asset");
  }
  const amountSubunits = requirePositiveSafeInteger(
    request.amountSubunits,
    "amount",
  );
  const divisibility = requirePositiveSafeInteger(
    request.divisibility,
    "divisibility",
  );
  if (typeof request.fundAmm !== "boolean") {
    throw new Error("Pending ecash deposit funding mode is invalid");
  }
  return {
    conditionId: requireBoundedString(request.conditionId, "condition"),
    mintUrl: normalizeUrl(requireBoundedString(request.mintUrl, "mint URL")),
    amountSubunits,
    baseAsset,
    unit,
    divisibility,
    fundAmm: request.fundAmm,
    creatorPubkey: requireNullableBoundedString(
      request.creatorPubkey,
      "creator identity",
    ),
    fundingIdentity: requireBoundedString(
      request.fundingIdentity,
      "funding identity",
    ),
  };
}

function requireSendProofs(
  candidate: unknown,
  request: PendingEcashDepositRequest,
): Proof[] {
  const proofs = requireProofArray(candidate, "send proofs");
  if (
    proofs.length === 0 ||
    proofs.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX ||
    new Set(proofs.map(({ secret }) => secret)).size !== proofs.length ||
    proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0) !==
      request.amountSubunits
  ) {
    throw new Error("Pending ecash deposit send proofs are invalid");
  }
  return proofs;
}

function requireProofArray(candidate: unknown, label: string): Proof[] {
  if (!Array.isArray(candidate)) {
    throw new Error(`Pending ecash deposit ${label} are invalid`);
  }
  return candidate.map((value) => {
    const proof = requireObject(value);
    requireExactKeys(proof, ["id", "amount", "secret", "C"], "proof", [
      "dleq",
      "p2pk_e",
      "witness",
    ]);
    const amount = amountToNumber(proof.amount as never);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error("Pending ecash deposit proof amount is invalid");
    }
    const normalized: Proof = {
      id: requireBoundedString(proof.id, "proof keyset id"),
      amount: Amount.from(amount),
      secret: requireBoundedString(
        proof.secret,
        "proof secret",
        PROOF_FIELD_MAX_LENGTH,
      ),
      C: requireBoundedString(
        proof.C,
        "proof signature",
        PROOF_FIELD_MAX_LENGTH,
      ),
      ...(proof.dleq === undefined ? {} : { dleq: requireDleq(proof.dleq) }),
      ...(proof.p2pk_e === undefined
        ? {}
        : { p2pk_e: requireBoundedString(proof.p2pk_e, "proof P2PK E") }),
      ...(proof.witness === undefined
        ? {}
        : { witness: requireWitness(proof.witness) }),
    };
    if (
      new TextEncoder().encode(JSON.stringify(normalized)).byteLength >
      PROOF_SERIALIZED_MAX_BYTES
    ) {
      throw new Error("Pending ecash deposit proof is too large");
    }
    return normalized;
  });
}

function requireDleq(value: unknown): NonNullable<Proof["dleq"]> {
  const dleq = requireObject(value);
  requireExactKeys(dleq, ["s", "e"], "proof DLEQ", ["r"]);
  return {
    s: requireBoundedString(dleq.s, "proof DLEQ s"),
    e: requireBoundedString(dleq.e, "proof DLEQ e"),
    ...(dleq.r === undefined
      ? {}
      : { r: requireBoundedString(dleq.r, "proof DLEQ r") }),
  };
}

function requireWitness(value: unknown): NonNullable<Proof["witness"]> {
  if (typeof value === "string") {
    return requireBoundedString(value, "proof witness", PROOF_FIELD_MAX_LENGTH);
  }
  const witness = requireObject(value);
  requireExactKeys(witness, [], "proof witness", ["preimage", "signatures"]);
  const signatures =
    witness.signatures === undefined
      ? undefined
      : requireSignatures(witness.signatures);
  if (witness.preimage !== undefined) {
    return {
      preimage: requireBoundedString(witness.preimage, "proof preimage"),
      ...(signatures === undefined ? {} : { signatures }),
    };
  }
  return signatures === undefined ? {} : { signatures };
}

function requireSignatures(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > WITNESS_SIGNATURE_LIMIT) {
    throw new Error("Pending ecash deposit proof signatures are invalid");
  }
  return value.map((signature) =>
    requireBoundedString(signature, "proof signature witness"),
  );
}

function requireRemoteState(
  value: unknown,
): PendingEcashDepositRemoteState | null {
  switch (value) {
    case null:
    case "requested":
    case "paid":
    case "failed":
      return value;
    default:
      throw new Error("Pending ecash deposit remote state is invalid");
  }
}

function requireRecoveryState(
  value: unknown,
): PendingEcashDepositRecoveryState {
  switch (value) {
    case "active":
    case "blocked":
      return value;
    default:
      throw new Error("Pending ecash deposit recovery state is invalid");
  }
}

function requireWallet(value: unknown, expected: string): string {
  if (value !== expected) {
    throw new Error("Pending ecash deposit belongs to another wallet scope");
  }
  return expected;
}

function requireTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Pending ecash deposit timestamp is invalid");
  }
  return value;
}

function requireRetryCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > RETRY_COUNT_MAX
  ) {
    throw new Error("Pending ecash deposit retry count is invalid");
  }
  return value;
}

function requireLastError(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > ERROR_MAX_LENGTH) {
    throw new Error("Pending ecash deposit error is invalid");
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Pending ecash deposit ${label} is invalid`);
  }
  return value;
}

function requireNullableBoundedString(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : requireBoundedString(value, label);
}

function requireBoundedString(
  value: unknown,
  label: string,
  maxLength = IDENTIFIER_MAX_LENGTH,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`Pending ecash deposit ${label} is invalid`);
  }
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pending ecash deposit record is invalid");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const known = new Set([...required, ...optional]);
  const fields = Object.keys(value);
  if (
    fields.some((key) => !known.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`Pending ecash deposit ${label} has invalid fields`);
  }
}
