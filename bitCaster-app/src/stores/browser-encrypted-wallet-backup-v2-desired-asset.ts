import {
  createEncryptedWalletBackupV2AssetIdentity,
  decodeEncryptedWalletBackupV2AssetIdentity,
  ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX,
  encryptedWalletBackupV2LocalAssetKey,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import type { EncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk/encryptedWalletBackupV2Bundle";
import {
  decodeCanonicalMintOrigin,
  decodeDurableCustodyScopeId,
} from "@bitcaster/client-sdk/durableCustody";
import { decodeBrowserCustodyConditionalKeysetRow } from "./durable-custody-types";
import { decodeBrowserCustodyProofRow } from "./durable-custody-types";
import type { BrowserCustodyProofRow, BrowserCustodyProofUnit } from "./durable-custody-types";
import type { BitcasterDB } from "./proof-db";

export type EncryptedWalletBackupV2DesiredAction = "replace" | "remove";

/** The latest V2 replacement or removal intent for one local asset. */
export interface EncryptedWalletBackupV2DesiredAssetRow extends EncryptedWalletBackupV2AssetIdentity {
  readonly scopeId: string;
  readonly localAssetKey: string;
  readonly custodyRevision: string;
  readonly activeProofCount: number;
  readonly desiredAction: EncryptedWalletBackupV2DesiredAction;
  readonly syncState: "pending" | "acknowledged";
}

export function createEncryptedWalletBackupV2DesiredAssetRow(input: {
  readonly scopeId: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly custodyRevision: bigint;
  readonly activeProofCount: number;
}): EncryptedWalletBackupV2DesiredAssetRow {
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(input.asset);
  return decodeEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    localAssetKey: encryptedWalletBackupV2LocalAssetKey(asset),
    ...asset,
    custodyRevision: decimalUint64(input.custodyRevision),
    activeProofCount: requireActiveProofCount(input.activeProofCount),
    desiredAction: input.activeProofCount === 0 ? "remove" : "replace",
    syncState: "pending",
  });
}

export function decodeEncryptedWalletBackupV2DesiredAssetRow(
  value: unknown,
): EncryptedWalletBackupV2DesiredAssetRow {
  if (!isRecord(value) || !exactKeys(value, rowFields)) {
    throw new Error("browser V2 desired asset row is invalid");
  }
  const scopeId = decodeDurableCustodyScopeId(value.scopeId);
  const asset = decodeEncryptedWalletBackupV2AssetIdentity({
    mintUrl: value.mintUrl,
    unit: value.unit,
    assetIdentity: value.assetIdentity,
  });
  const localAssetKey = encryptedWalletBackupV2LocalAssetKey(asset);
  if (value.localAssetKey !== localAssetKey) {
    throw new Error("browser V2 desired asset key is invalid");
  }
  const activeProofCount = requireActiveProofCount(value.activeProofCount);
  const desiredAction = requireAction(value.desiredAction);
  if ((activeProofCount === 0 ? "remove" : "replace") !== desiredAction) {
    throw new Error("browser V2 desired asset action is inconsistent");
  }
  return {
    scopeId,
    localAssetKey,
    ...asset,
    custodyRevision: decimalUint64(parseDecimalUint64(value.custodyRevision)),
    activeProofCount,
    desiredAction,
    syncState: requireSyncState(value.syncState),
  };
}

export function incrementEncryptedWalletBackupV2DesiredAssetRevision(value: bigint): bigint {
  const revision = parseDecimalUint64(decimalUint64(value));
  if (revision === UINT64_MAX) {
    throw new Error("browser V2 desired asset revision exceeds uint64");
  }
  return revision + 1n;
}

const rowFields = [
  "scopeId",
  "localAssetKey",
  "mintUrl",
  "unit",
  "assetIdentity",
  "custodyRevision",
  "activeProofCount",
  "desiredAction",
  "syncState",
] as const;
const UINT64_MAX = (1n << 64n) - 1n;

function decimalUint64(value: bigint): string {
  if (value < 0n || value > UINT64_MAX) {
    throw new Error("browser V2 desired asset revision is invalid");
  }
  return value.toString();
}

function parseDecimalUint64(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error("browser V2 desired asset revision is invalid");
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new Error("browser V2 desired asset revision is invalid");
  return parsed;
}

function requireAction(value: unknown): EncryptedWalletBackupV2DesiredAction {
  if (value === "replace" || value === "remove") return value;
  throw new Error("browser V2 desired asset action is invalid");
}

function requireSyncState(value: unknown): "pending" | "acknowledged" {
  if (value === "pending" || value === "acknowledged") return value;
  throw new Error("browser V2 desired asset sync state is invalid");
}

function requireActiveProofCount(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX
  ) {
    throw new Error("browser V2 desired asset active proof count is invalid");
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === fields.length && keys.every((key, index) => key === [...fields].sort()[index])
  );
}

export interface BrowserV2DesiredAssetProofChange {
  readonly beforeProof: BrowserCustodyProofRow | null;
  readonly afterProof: BrowserCustodyProofRow;
  readonly payloadChanged: boolean;
}

export async function advanceBrowserV2DesiredAssetsForProofChanges(
  database: BitcasterDB,
  scopeId: string,
  changes: readonly BrowserV2DesiredAssetProofChange[],
  conditionalKeysetForProof?: (
    proof: BrowserCustodyProofRow,
  ) => ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow> | undefined,
): Promise<void> {
  const updates = new Map<string, DesiredAssetUpdate>();
  for (const change of changes) {
    if (!change.payloadChanged) continue;
    const before = change.beforeProof;
    if (before && isActive(before)) {
      addDesiredAssetUpdate(
        updates,
        await assetForProof(database, before, conditionalKeysetForProof),
        -1,
      );
    }
    if (isActive(change.afterProof)) {
      addDesiredAssetUpdate(
        updates,
        await assetForProof(database, change.afterProof, conditionalKeysetForProof),
        1,
      );
    }
  }
  await persistDesiredAssetUpdates(database, scopeId, updates);
}

export async function advanceBrowserV2DesiredAssetsForCounter(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly normalizedMint: string;
  readonly unit: BrowserCustodyProofUnit;
  readonly keysetId: string;
}): Promise<void> {
  const scopeId = decodeDurableCustodyScopeId(input.scopeId);
  const normalizedMint = decodeCanonicalMintOrigin(input.normalizedMint);
  const active = await firstActiveProof(input.database, {
    ...input,
    scopeId,
    normalizedMint,
  });
  if (active === null) return;
  const updates = new Map<string, DesiredAssetUpdate>();
  addDesiredAssetUpdate(updates, await assetForProof(input.database, active), 0);
  await persistDesiredAssetUpdates(input.database, scopeId, updates);
}

async function firstActiveProof(
  database: BitcasterDB,
  expected: {
    readonly scopeId: string;
    readonly normalizedMint: string;
    readonly unit: BrowserCustodyProofUnit;
    readonly keysetId: string;
  },
): Promise<BrowserCustodyProofRow | null> {
  for (const state of ["selectable", "locked"] as const) {
    const raw = await database.custodyProofs
      .where("[scopeId+normalizedMint+unit+keysetId+selectability]")
      .equals([expected.scopeId, expected.normalizedMint, expected.unit, expected.keysetId, state])
      .first();
    if (raw !== undefined) return decodeActiveProofReference(raw, expected);
  }
  return null;
}

interface DesiredAssetUpdate {
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  delta: number;
}

function addDesiredAssetUpdate(
  updates: Map<string, DesiredAssetUpdate>,
  asset: EncryptedWalletBackupV2AssetIdentity,
  delta: number,
): void {
  const key = encryptedWalletBackupV2LocalAssetKey(asset);
  const current = updates.get(key);
  if (current) {
    current.delta += delta;
    return;
  }
  updates.set(key, { asset, delta });
}

async function persistDesiredAssetUpdates(
  database: BitcasterDB,
  scopeId: string,
  updates: ReadonlyMap<string, DesiredAssetUpdate>,
): Promise<void> {
  for (const [localAssetKey, update] of updates) {
    const raw = await database.encryptedWalletBackupV2DesiredAssets.get([scopeId, localAssetKey]);
    const current =
      raw === undefined ? undefined : decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
    if (current === undefined && update.delta <= 0) {
      throw new Error("browser V2 desired asset authority is missing");
    }
    if (current && (current.scopeId !== scopeId || current.localAssetKey !== localAssetKey)) {
      throw new Error("browser V2 desired asset authority is foreign");
    }
    const activeProofCount = (current?.activeProofCount ?? 0) + update.delta;
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId,
        asset: update.asset,
        custodyRevision:
          current === undefined
            ? 1n
            : incrementEncryptedWalletBackupV2DesiredAssetRevision(BigInt(current.custodyRevision)),
        activeProofCount,
      }),
    );
  }
}

function isActive(proof: BrowserCustodyProofRow): boolean {
  return proof.selectability === "selectable" || proof.selectability === "locked";
}

async function assetForProof(
  database: BitcasterDB,
  proof: BrowserCustodyProofRow,
  conditionalKeysetForProof?: (
    proof: BrowserCustodyProofRow,
  ) => ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow> | undefined,
): Promise<EncryptedWalletBackupV2AssetIdentity> {
  if (proof.assetKind === "regular") {
    return createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: proof.normalizedMint,
      unit: proof.unit,
      asset: { kind: "ordinary" },
    });
  }
  const raw = conditionalKeysetForProof
    ? conditionalKeysetForProof(proof)
    : await database.custodyConditionalKeysets.get([
        proof.scopeId,
        proof.normalizedMint,
        proof.unit,
        proof.keysetId,
      ]);
  if (raw === undefined)
    throw new Error("browser V2 desired asset conditional authority is missing");
  const keyset = decodeBrowserCustodyConditionalKeysetRow(raw);
  if (
    keyset.scopeId !== proof.scopeId ||
    keyset.normalizedMint !== proof.normalizedMint ||
    keyset.unit !== proof.unit ||
    keyset.keysetId !== proof.keysetId ||
    keyset.conditionId !== proof.conditionId ||
    keyset.outcomeCollection !== proof.outcomeCollection
  ) {
    throw new Error("browser V2 desired asset conditional authority is foreign");
  }
  return createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: proof.normalizedMint,
    unit: proof.unit,
    asset: {
      kind: "ctf",
      conditionId: keyset.conditionId,
      outcomeLabel: keyset.outcomeCollection,
      outcomeCollectionId: keyset.outcomeCollectionId,
      registeredAt: keyset.registeredAtUnixSeconds,
      finalExpiry: keyset.finalExpiryUnixSeconds,
    },
  });
}

function decodeActiveProofReference(
  value: unknown,
  expected: {
    readonly scopeId: string;
    readonly normalizedMint: string;
    readonly unit: BrowserCustodyProofUnit;
    readonly keysetId: string;
  },
): BrowserCustodyProofRow {
  const proof = decodeBrowserCustodyProofRow(value);
  if (
    proof.scopeId !== expected.scopeId ||
    proof.normalizedMint !== expected.normalizedMint ||
    proof.unit !== expected.unit ||
    proof.keysetId !== expected.keysetId ||
    !isActive(proof)
  ) {
    throw new Error("browser V2 desired asset counter proof is foreign");
  }
  return proof;
}
