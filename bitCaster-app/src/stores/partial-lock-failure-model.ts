import { DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX } from "@bitcaster/client-sdk/durableCustody";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import type {
  OutcomeMetadata,
  PartialLockHeldRecord,
  PartialLockProofRecord,
} from "@bitcaster/client-sdk/swapFailure";
import { normalizeUrl } from "@/lib/url";
import { normalizePendingPaymentProofs } from "./pending-local-wallet-payment-model";

const IDENTIFIER_MAX_LENGTH = 256;
const DETAIL_MAX_LENGTH = 1_024;

export interface GuiPartialLockFailureRecord extends Omit<
  PartialLockHeldRecord,
  "orderId" | "mintUrl" | "createdAt"
> {
  orderId: string;
  mintUrl: string;
  createdAt: number;
}

export function validateGuiPartialLockFailureRecord(
  value: unknown,
): GuiPartialLockFailureRecord {
  const record = requireRecord(value, "Partial-lock failure");
  requireExactKeys(
    record,
    [
      "kind",
      "tradeId",
      "orderId",
      "mintUrl",
      "refundLocktime",
      "affectedKeysets",
      "detail",
      "outcomeByKeyset",
      "lockedProofs",
      "createdAt",
      "walletId",
    ],
    "Partial-lock failure",
  );
  if (record.kind !== "PartialLockHeld") {
    throw new Error("Partial-lock failure kind is invalid");
  }
  const tradeId = requireString(record.tradeId, "tradeId");
  const orderId = requireString(record.orderId, "orderId");
  const mintUrl = normalizeUrl(requireString(record.mintUrl, "mintUrl"));
  const affectedKeysets = requireUniqueStrings(
    record.affectedKeysets,
    "affectedKeysets",
  );
  const lockedProofs = requireLockedProofs(record.lockedProofs);
  assertExactLockedKeysets(lockedProofs, affectedKeysets);
  return {
    kind: "PartialLockHeld",
    tradeId,
    orderId,
    mintUrl,
    refundLocktime: requireInteger(record.refundLocktime, "refundLocktime"),
    affectedKeysets,
    detail: requireString(record.detail, "detail", DETAIL_MAX_LENGTH),
    outcomeByKeyset: requireOutcomeByKeyset(
      record.outcomeByKeyset,
      affectedKeysets,
    ),
    lockedProofs,
    createdAt: requireInteger(record.createdAt, "createdAt"),
  };
}

function requireLockedProofs(value: unknown): PartialLockProofRecord[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX
  ) {
    throw new Error("Partial-lock failure lockedProofs must not be empty");
  }
  const proofs = normalizePendingPaymentProofs(
    value,
    "partial-lock proofs",
  ).map((proof) => ({ ...proof, amount: amountToNumber(proof.amount) }));
  if (new Set(proofs.map(({ secret }) => secret)).size !== proofs.length) {
    throw new Error("Partial-lock failure contains duplicate proof secrets");
  }
  return proofs;
}

function requireOutcomeByKeyset(
  value: unknown,
  affectedKeysets: readonly string[],
): Record<string, OutcomeMetadata> {
  const source = requireRecord(value, "outcomeByKeyset");
  if (
    Object.keys(source).length !== affectedKeysets.length ||
    affectedKeysets.some((keysetId) => !(keysetId in source))
  ) {
    throw new Error("Partial-lock failure outcome metadata is not exact");
  }
  return Object.fromEntries(
    affectedKeysets.map((keysetId) => [
      keysetId,
      requireOutcomeMetadata(source[keysetId], keysetId),
    ]),
  );
}

function requireOutcomeMetadata(
  value: unknown,
  keysetId: string,
): OutcomeMetadata {
  const metadata = requireRecord(value, `outcomeByKeyset.${keysetId}`);
  requireExactKeys(
    metadata,
    ["conditionId", "outcomeCollection", "marketId"],
    `outcomeByKeyset.${keysetId}`,
  );
  const conditionId = requireString(metadata.conditionId, "conditionId");
  const outcomeCollection = requireString(
    metadata.outcomeCollection,
    "outcomeCollection",
  );
  const marketId = requireString(metadata.marketId, "marketId");
  if (marketId !== `${conditionId}-${outcomeCollection}`) {
    throw new Error(
      `Partial-lock failure market id is invalid for ${keysetId}`,
    );
  }
  return { conditionId, outcomeCollection, marketId };
}

function assertExactLockedKeysets(
  proofs: readonly PartialLockProofRecord[],
  affectedKeysets: readonly string[],
): void {
  const lockedKeysets = new Set(proofs.map(({ id }) => id));
  if (
    lockedKeysets.size !== affectedKeysets.length ||
    affectedKeysets.some((keysetId) => !lockedKeysets.has(keysetId))
  ) {
    throw new Error("Partial-lock failure affected keysets are not exact");
  }
}

function requireUniqueStrings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX
  ) {
    throw new Error(`Partial-lock failure ${field} must not be empty`);
  }
  const values = value.map((candidate) => requireString(candidate, field));
  if (new Set(values).size !== values.length) {
    throw new Error(`Partial-lock failure ${field} contains duplicates`);
  }
  return values;
}

function requireString(
  value: unknown,
  field: string,
  maxLength = IDENTIFIER_MAX_LENGTH,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`Partial-lock failure ${field} is invalid`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Partial-lock failure ${field} is invalid`);
  }
  return value as number;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const known = new Set(allowed);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new Error(`${field} contains unknown fields`);
  }
}
