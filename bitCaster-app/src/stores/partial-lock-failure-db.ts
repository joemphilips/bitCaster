import type { Proof } from "@cashu/cashu-ts";
import {
  amountToNumber,
  sameCashuProofArtifact,
  type CashuProofArtifactLike,
} from "@bitcaster/client-sdk/proofSelection";
import type { PartialLockHeldRecord } from "@bitcaster/client-sdk/swapFailure";
import { normalizeUrl } from "@/lib/url";
import {
  BitcasterDB,
  currentGuiWalletId,
  db,
  locateStoredProofs,
  prepareStoredProofForWrite,
  requireStoredProofRow,
  storedProofIds,
  type StoredProof,
  type StoredProofRow,
} from "./proof-db";
import { assertSameStoredProofAuthority } from "./gui-native-proof-custody";
import {
  validateGuiPartialLockFailureRecord,
  type GuiPartialLockFailureRecord,
} from "./partial-lock-failure-model";
import {
  walletIdFromHeldGuiWalletLock,
  type GuiWalletLockContext,
} from "./gui-wallet-lock";

export interface CommitGuiPartialLockFailureInput {
  record: PartialLockHeldRecord;
  spentProofs: Proof[];
  replacementProofs: StoredProof[];
}

export async function commitGuiPartialLockFailureUnderLock(
  lock: GuiWalletLockContext,
  input: CommitGuiPartialLockFailureInput,
  database: BitcasterDB = db,
): Promise<GuiPartialLockFailureRecord> {
  const record = validateGuiPartialLockFailureRecord(input.record);
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  const spentProofs = requireUniqueProofs(input.spentProofs, "spent");
  const replacementProofs = requireUniqueReplacementProofs(
    input.replacementProofs,
    walletId,
  );
  assertPartialLockReplacementAuthority(record, replacementProofs);
  assertDisjointProofSets(spentProofs, replacementProofs);
  return database.transaction(
    "rw",
    database.proofs,
    database.partialLockFailures,
    async () =>
      commitPartialLockTransaction(
        database,
        walletId,
        record,
        spentProofs,
        replacementProofs,
      ),
  );
}

export async function getGuiPartialLockFailure(
  tradeId: string,
  database: BitcasterDB = db,
): Promise<GuiPartialLockFailureRecord | null> {
  return getGuiPartialLockFailureForWallet(
    currentGuiWalletId(),
    tradeId,
    database,
  );
}

export async function getGuiPartialLockFailureUnderLock(
  lock: GuiWalletLockContext,
  tradeId: string,
  database: BitcasterDB = db,
): Promise<GuiPartialLockFailureRecord | null> {
  return getGuiPartialLockFailureForWallet(
    walletIdFromHeldGuiWalletLock(lock),
    tradeId,
    database,
  );
}

async function getGuiPartialLockFailureForWallet(
  walletId: string,
  tradeId: string,
  database: BitcasterDB,
): Promise<GuiPartialLockFailureRecord | null> {
  const row = await database.partialLockFailures.get([
    walletId,
    requireTradeId(tradeId),
  ]);
  if (!row) return null;
  if (row.walletId !== walletId) {
    throw new Error("Partial-lock failure belongs to another wallet");
  }
  return validateGuiPartialLockFailureRecord(row);
}

export async function listElapsedGuiPartialLockFailures(
  latestRefundLocktime: number,
  database: BitcasterDB = db,
): Promise<GuiPartialLockFailureRecord[]> {
  if (!Number.isSafeInteger(latestRefundLocktime) || latestRefundLocktime < 0) {
    throw new Error("Partial-lock refund cutoff is invalid");
  }
  const walletId = currentGuiWalletId();
  const rows = await database.partialLockFailures
    .where("[walletId+refundLocktime]")
    .between([walletId, 0], [walletId, latestRefundLocktime], true, true)
    .toArray();
  if (rows.some((row) => row.walletId !== walletId)) {
    throw new Error("Partial-lock failure belongs to another wallet");
  }
  return rows
    .map(validateGuiPartialLockFailureRecord)
    .sort((left, right) => left.tradeId.localeCompare(right.tradeId));
}

export async function removeGuiPartialLockFailureUnderLock(
  lock: GuiWalletLockContext,
  tradeId: string,
  database: BitcasterDB = db,
): Promise<void> {
  await database.partialLockFailures.delete([
    walletIdFromHeldGuiWalletLock(lock),
    requireTradeId(tradeId),
  ]);
}

async function commitPartialLockTransaction(
  database: BitcasterDB,
  walletId: string,
  record: GuiPartialLockFailureRecord,
  spentProofs: Proof[],
  replacementProofs: StoredProofRow[],
): Promise<GuiPartialLockFailureRecord> {
  const spentIdentities = locateStoredProofs(
    spentProofs,
    record.mintUrl,
    replacementProofs[0]?.unit,
  );
  const spentProofIds = storedProofIds(spentIdentities);
  const replacementProofIds = storedProofIds(replacementProofs);
  const [currentInputs, currentOutputs, existingRecord] = await Promise.all([
    database.proofs.bulkGet(spentProofIds),
    database.proofs.bulkGet(replacementProofIds),
    database.partialLockFailures.get([walletId, record.tradeId]),
  ]);
  assertProofRowsBelongToWallet(currentInputs, walletId);
  assertProofRowsBelongToWallet(currentOutputs, walletId);
  assertCurrentInputs(record, spentProofs, currentInputs);
  const nextProofs = mergeExistingOutputs(replacementProofs, currentOutputs);
  assertExactExistingRecord(existingRecord, record);
  await database.proofs.bulkDelete(spentProofIds);
  await database.proofs.bulkPut(nextProofs);
  await database.partialLockFailures.put({ ...record, walletId });
  return structuredClone(record);
}

function requireUniqueProofs(proofs: Proof[], label: string): Proof[] {
  if (proofs.length === 0) {
    throw new Error(`Partial-lock ${label} proof set must not be empty`);
  }
  for (const proof of proofs) requireProtocolProof(proof, label);
  if (new Set(proofs.map(({ secret }) => secret)).size !== proofs.length) {
    throw new Error(`Partial-lock ${label} proof set contains duplicates`);
  }
  return structuredClone(proofs);
}

function requireUniqueReplacementProofs(
  proofs: StoredProof[],
  walletId: string,
): StoredProofRow[] {
  const now = Date.now();
  const normalized = proofs.map((proof) =>
    prepareStoredProofForWrite(proof, now, walletId),
  );
  if (normalized.length === 0) {
    throw new Error("Partial-lock replacement proof set must not be empty");
  }
  if (
    new Set(normalized.map(({ secret }) => secret)).size !== normalized.length
  ) {
    throw new Error("Partial-lock replacement proof set contains duplicates");
  }
  if (new Set(normalized.map(({ unit }) => unit)).size !== 1) {
    throw new Error("Partial-lock replacement proof units are inconsistent");
  }
  return normalized;
}

function assertProofRowsBelongToWallet(
  rows: readonly (StoredProofRow | undefined)[],
  walletId: string,
): void {
  if (rows.some((row) => row && row.walletId !== walletId)) {
    throw new Error("Partial-lock proof belongs to another wallet scope");
  }
  rows.forEach((row) => {
    if (row) requireStoredProofRow(row, walletId);
  });
}

function assertPartialLockReplacementAuthority(
  record: GuiPartialLockFailureRecord,
  proofs: readonly StoredProof[],
): void {
  const expectedLocked = new Map(
    record.lockedProofs.map((proof) => [proof.secret, proof]),
  );
  const locked = proofs.filter(
    ({ reservedBy }) => reservedBy === record.tradeId,
  );
  if (locked.length !== expectedLocked.size) {
    throw new Error(
      "Partial-lock replacement does not contain the exact locked proofs",
    );
  }
  for (const proof of proofs) {
    assertReplacementMetadata(record, proof);
    if (proof.reservedBy && proof.reservedBy !== record.tradeId) {
      throw new Error(
        "Partial-lock replacement is reserved by another operation",
      );
    }
    const expected = expectedLocked.get(proof.secret);
    if (proof.reservedBy === record.tradeId && !expected) {
      throw new Error(
        "Partial-lock replacement contains an unknown locked proof",
      );
    }
    if (expected) assertSameProtocolProof(proof, expected);
  }
}

function assertReplacementMetadata(
  record: GuiPartialLockFailureRecord,
  proof: StoredProof,
): void {
  const metadata = proof.id ? record.outcomeByKeyset[proof.id] : undefined;
  if (
    normalizeUrl(proof.mintUrl) !== record.mintUrl ||
    !proof.unit ||
    !proof.baseAsset ||
    !metadata ||
    proof.conditionId !== metadata.conditionId ||
    proof.outcomeCollection !== metadata.outcomeCollection ||
    proof.marketId !== metadata.marketId
  ) {
    throw new Error("Partial-lock replacement metadata is invalid");
  }
}

function assertCurrentInputs(
  record: GuiPartialLockFailureRecord,
  expected: readonly Proof[],
  current: readonly (StoredProof | undefined)[],
): void {
  current.forEach((proof, index) => {
    if (!proof) return;
    assertSameProtocolProof(proof, expected[index]!);
    const metadata = proof.id ? record.outcomeByKeyset[proof.id] : undefined;
    if (
      proof.reservedBy !== record.tradeId ||
      normalizeUrl(proof.mintUrl) !== record.mintUrl ||
      !metadata ||
      proof.conditionId !== metadata.conditionId ||
      proof.outcomeCollection !== metadata.outcomeCollection ||
      proof.marketId !== metadata.marketId
    ) {
      throw new Error("Partial-lock input is not owned by the exact trade");
    }
  });
}

function mergeExistingOutputs(
  expected: readonly StoredProofRow[],
  existing: readonly (StoredProofRow | undefined)[],
): StoredProofRow[] {
  return expected.map((proof, index) => {
    const current = existing[index];
    if (!current) return proof;
    assertSameStoredProofAuthority(current, proof);
    return { ...proof, receivedAt: current.receivedAt ?? proof.receivedAt };
  });
}

function assertExactExistingRecord(
  existing: GuiPartialLockFailureRecord | undefined,
  expected: GuiPartialLockFailureRecord,
): void {
  if (!existing) return;
  const canonical = validateGuiPartialLockFailureRecord(existing);
  if (JSON.stringify(canonical) !== JSON.stringify(expected)) {
    throw new Error(
      "Partial-lock recovery record conflicts with existing authority",
    );
  }
}

function assertDisjointProofSets(
  spentProofs: readonly Proof[],
  replacementProofs: readonly Proof[],
): void {
  const spentSecrets = new Set(spentProofs.map(({ secret }) => secret));
  if (replacementProofs.some(({ secret }) => spentSecrets.has(secret))) {
    throw new Error("Partial-lock replacement reuses a spent proof secret");
  }
}

function assertSameProtocolProof(
  actual: Proof,
  expected: CashuProofArtifactLike,
): void {
  if (!sameCashuProofArtifact(actual, expected)) {
    throw new Error("Partial-lock proof authority does not match");
  }
}

function requireProtocolProof(proof: Proof, label: string): void {
  if (
    typeof proof.id !== "string" ||
    proof.id.length === 0 ||
    typeof proof.secret !== "string" ||
    proof.secret.length === 0 ||
    typeof proof.C !== "string" ||
    proof.C.length === 0 ||
    !Number.isSafeInteger(amountToNumber(proof.amount)) ||
    amountToNumber(proof.amount) <= 0
  ) {
    throw new Error(`Partial-lock ${label} proof is invalid`);
  }
}

function requireTradeId(tradeId: string): string {
  if (tradeId.length === 0) throw new Error("Partial-lock trade id is invalid");
  return tradeId;
}
