import {
  createEncryptedWalletBackupV2AssetIdentity,
  decodeEncryptedWalletBackupV2AssetIdentity,
  ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX,
  encryptedWalletBackupV2LocalAssetKey,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import type { EncryptedWalletBackupV2ProofSetAsset } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import type { EncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk/encryptedWalletBackupV2Bundle";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  decodeCanonicalMintOrigin,
  decodeDurableCustodyScopeId,
} from "@bitcaster/client-sdk/durableCustody";
import {
  requireBrowserProofBackupAuthorityRow,
  requireBrowserProofBackupAuthorityForProof,
  type BrowserProofDerivationLocatorAuthority,
  type BrowserProofBackupAuthorityRow,
} from "./browser-proof-backup-authority";
import { decodeBrowserCustodyConditionalKeysetRow } from "./durable-custody-types";
import { decodeBrowserCustodyProofRow } from "./durable-custody-types";
import type { BrowserCustodyProofRow, BrowserCustodyProofUnit } from "./durable-custody-types";
import type { BitcasterDB } from "./proof-db";

export type EncryptedWalletBackupV2DesiredAction = "replace" | "remove";

/** Structural CTF identity retained when a mint keyset is no longer available. */
export type EncryptedWalletBackupV2TerminalCtfContext = Omit<
  Extract<EncryptedWalletBackupV2ProofSetAsset, { readonly kind: "ctf" }>,
  "kind"
>;

/** The latest V2 replacement or removal intent for one local asset. */
export interface EncryptedWalletBackupV2DesiredAssetRow extends EncryptedWalletBackupV2AssetIdentity {
  readonly scopeId: string;
  readonly localAssetKey: string;
  readonly custodyRevision: string;
  readonly activeProofCount: number;
  readonly desiredAction: EncryptedWalletBackupV2DesiredAction;
  readonly syncState: "pending" | "acknowledged";
  readonly terminalCtfContext: EncryptedWalletBackupV2TerminalCtfContext | null;
}

export function createEncryptedWalletBackupV2DesiredAssetRow(input: {
  readonly scopeId: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly custodyRevision: bigint;
  readonly activeProofCount: number;
  /**
   * Pass the complete CTF tuple from an SDK-verified proof or local keyset.
   * CTF rows used only to derive a local asset key may leave this null.
   */
  readonly terminalCtfContext?: EncryptedWalletBackupV2TerminalCtfContext | null;
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
    terminalCtfContext: input.terminalCtfContext ?? null,
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
  const terminalCtfContext = decodeTerminalCtfContext(value.terminalCtfContext);
  if (asset.assetIdentity === "cashu:ordinary") {
    if (terminalCtfContext !== null) {
      throw new Error("browser V2 desired asset CTF context is foreign");
    }
  } else if (
    terminalCtfContext !== null &&
    `ctf:${terminalCtfContext.conditionId}:${terminalCtfContext.outcomeCollectionId}` !==
      asset.assetIdentity
  ) {
    throw new Error("browser V2 desired asset CTF context is foreign");
  }
  return {
    scopeId,
    localAssetKey,
    ...asset,
    custodyRevision: decimalUint64(parseDecimalUint64(value.custodyRevision)),
    activeProofCount,
    desiredAction,
    syncState: requireSyncState(value.syncState),
    terminalCtfContext,
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
  "terminalCtfContext",
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

function decodeTerminalCtfContext(
  value: unknown,
): EncryptedWalletBackupV2TerminalCtfContext | null {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, terminalCtfContextFields)) {
    throw new Error("browser V2 desired asset CTF context is invalid");
  }
  const conditionId = requireLowerHex(value.conditionId, "condition id");
  const outcomeCollectionId = requireLowerHex(value.outcomeCollectionId, "outcome collection id");
  const outcomeLabel = requireUtf8Text(value.outcomeLabel, "outcome label");
  const registeredAt = requireUnixTime(value.registeredAt, "registered time");
  const finalExpiry =
    value.finalExpiry === null ? null : requirePositiveUnixTime(value.finalExpiry, "final expiry");
  if (finalExpiry !== null && finalExpiry <= registeredAt) {
    throw new Error("browser V2 desired asset CTF context is invalid");
  }
  return Object.freeze({
    conditionId,
    outcomeLabel,
    outcomeCollectionId,
    registeredAt,
    finalExpiry,
  });
}

const terminalCtfContextFields = [
  "conditionId",
  "outcomeLabel",
  "outcomeCollectionId",
  "registeredAt",
  "finalExpiry",
] as const;

function requireLowerHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`browser V2 desired asset CTF context ${label} is invalid`);
  }
  return value;
}

function requireUtf8Text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > 256
  ) {
    throw new Error(`browser V2 desired asset CTF context ${label} is invalid`);
  }
  return value;
}

function requireUnixTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`browser V2 desired asset CTF context ${label} is invalid`);
  }
  return value;
}

function requirePositiveUnixTime(value: unknown, label: string): number {
  const timestamp = requireUnixTime(value, label);
  if (timestamp < 1) throw new Error(`browser V2 desired asset CTF context ${label} is invalid`);
  return timestamp;
}

function sameTerminalCtfContext(
  left: EncryptedWalletBackupV2TerminalCtfContext | null,
  right: EncryptedWalletBackupV2TerminalCtfContext | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.conditionId === right.conditionId &&
      left.outcomeLabel === right.outcomeLabel &&
      left.outcomeCollectionId === right.outcomeCollectionId &&
      left.registeredAt === right.registeredAt &&
      left.finalExpiry === right.finalExpiry)
  );
}

function mergeTerminalCtfContext(
  current: EncryptedWalletBackupV2TerminalCtfContext | null,
  update: EncryptedWalletBackupV2TerminalCtfContext | null,
): EncryptedWalletBackupV2TerminalCtfContext | null {
  if (current !== null && update !== null && !sameTerminalCtfContext(current, update)) {
    throw new Error("browser V2 desired asset CTF context conflicts");
  }
  return current ?? update;
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
  readonly beforeLocator: BrowserProofDerivationLocatorAuthority;
  readonly afterProof: BrowserCustodyProofRow;
  readonly afterLocator: BrowserProofDerivationLocatorAuthority;
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
    if (before && isBackupEligible(before, change.beforeLocator)) {
      const asset = knownAssetForProof(before, conditionalKeysetForProof);
      addDesiredAssetUpdate(
        updates,
        asset ?? (await loadConditionalAssetForProof(database, before)),
        -1,
      );
    }
    if (isBackupEligible(change.afterProof, change.afterLocator)) {
      const asset = knownAssetForProof(change.afterProof, conditionalKeysetForProof);
      addDesiredAssetUpdate(
        updates,
        asset ?? (await loadConditionalAssetForProof(database, change.afterProof)),
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
  addDesiredAssetUpdate(
    updates,
    knownAssetForProof(active) ?? (await loadConditionalAssetForProof(input.database, active)),
    0,
  );
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
  for (const state of ["selectable", "locked", "verified-losing"] as const) {
    const rows = await database.custodyProofs
      .where("[scopeId+normalizedMint+unit+keysetId+selectability]")
      .equals([expected.scopeId, expected.normalizedMint, expected.unit, expected.keysetId, state])
      .limit(513)
      .toArray();
    const proofs = rows.map((row) => decodeActiveProofReference(row, expected));
    const authorities = await database.custodyProofBackupAuthorities.bulkGet(
      proofs.map((proof) => [proof.scopeId, proof.proofId]),
    );
    for (const [index, proof] of proofs.entries()) {
      const authority = requireBrowserProofBackupAuthorityForProof(authorities[index], proof);
      if (isBackupEligible(proof, authority.derivationLocator)) return proof;
    }
  }
  return null;
}

interface DesiredAssetUpdate {
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly terminalCtfContext: EncryptedWalletBackupV2TerminalCtfContext | null;
  delta: number;
}

interface DesiredAssetMaterial {
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly terminalCtfContext: EncryptedWalletBackupV2TerminalCtfContext | null;
}

function addDesiredAssetUpdate(
  updates: Map<string, DesiredAssetUpdate>,
  material: DesiredAssetMaterial,
  delta: number,
): void {
  const key = encryptedWalletBackupV2LocalAssetKey(material.asset);
  const current = updates.get(key);
  if (current) {
    if (!sameTerminalCtfContext(current.terminalCtfContext, material.terminalCtfContext)) {
      throw new Error("browser V2 desired asset CTF context conflicts");
    }
    current.delta += delta;
    return;
  }
  updates.set(key, { ...material, delta });
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
    if (
      current &&
      (current.assetIdentity !== update.asset.assetIdentity ||
        current.mintUrl !== update.asset.mintUrl ||
        current.unit !== update.asset.unit)
    ) {
      throw new Error("browser V2 desired asset authority is foreign");
    }
    if (update.asset.assetIdentity.startsWith("ctf:") && update.terminalCtfContext === null) {
      throw new Error("browser V2 desired asset conditional context is missing");
    }
    const terminalCtfContext = current
      ? mergeTerminalCtfContext(current.terminalCtfContext, update.terminalCtfContext)
      : update.terminalCtfContext;
    const activeProofCount = (current?.activeProofCount ?? 0) + update.delta;
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId,
        asset: update.asset,
        terminalCtfContext,
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
  switch (proof.selectability) {
    case "selectable":
    case "locked":
    case "verified-losing":
      return true;
    case "spent":
      return false;
    default:
      throw new Error("browser V2 desired asset proof state is invalid");
  }
}

function isBackupEligible(
  proof: BrowserCustodyProofRow,
  derivationLocator: BrowserProofDerivationLocatorAuthority,
): boolean {
  return isActive(proof) && derivationLocator !== null;
}

function knownAssetForProof(
  proof: BrowserCustodyProofRow,
  conditionalKeysetForProof?: (
    proof: BrowserCustodyProofRow,
  ) => ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow> | undefined,
): DesiredAssetMaterial | undefined {
  if (proof.assetKind === "regular") {
    return {
      asset: createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: proof.normalizedMint,
        unit: proof.unit,
        asset: { kind: "ordinary" },
      }),
      terminalCtfContext: null,
    };
  }
  if (conditionalKeysetForProof === undefined) return undefined;
  const keyset = conditionalKeysetForProof(proof);
  if (keyset === undefined && proof.selectability !== "verified-losing") {
    throw new Error("browser V2 desired asset conditional authority is missing");
  }
  if (keyset === undefined) return undefined;
  return conditionalAssetForProof(proof, keyset);
}

async function loadConditionalAssetForProof(
  database: BitcasterDB,
  proof: BrowserCustodyProofRow,
): Promise<DesiredAssetMaterial> {
  if (proof.assetKind !== "conditional") {
    throw new Error("browser V2 desired asset conditional proof is required");
  }
  const raw = await database.custodyConditionalKeysets.get([
    proof.scopeId,
    proof.normalizedMint,
    proof.unit,
    proof.keysetId,
  ]);
  if (raw === undefined && proof.selectability === "verified-losing") {
    return loadRemoteTerminalAssetForProof(database, proof);
  }
  if (raw === undefined) {
    throw new Error("browser V2 desired asset conditional authority is missing");
  }
  return conditionalAssetForProof(proof, decodeBrowserCustodyConditionalKeysetRow(raw));
}

async function loadRemoteTerminalAssetForProof(
  database: BitcasterDB,
  proof: BrowserCustodyProofRow,
  suppliedAuthority?: BrowserProofBackupAuthorityRow,
): Promise<DesiredAssetMaterial> {
  if (
    proof.assetKind !== "conditional" ||
    proof.conditionId === null ||
    proof.outcomeCollection === null
  ) {
    throw new Error("browser V2 desired asset conditional proof is required");
  }
  let authority: BrowserProofBackupAuthorityRow;
  if (suppliedAuthority === undefined) {
    const authorityRaw = await database.custodyProofBackupAuthorities.get([
      proof.scopeId,
      proof.proofId,
    ]);
    if (authorityRaw === undefined) {
      throw new Error("browser V2 desired asset remote terminal authority is missing");
    }
    authority = requireBrowserProofBackupAuthorityForProof(authorityRaw, proof);
  } else {
    authority = requireBrowserProofBackupAuthorityRow(suppliedAuthority);
    if (
      authority.scopeId !== proof.scopeId ||
      authority.proofId !== proof.proofId ||
      authority.proofFingerprint !== proof.proofFingerprint ||
      authority.proofState !== proof.selectability
    ) {
      throw new Error("browser V2 desired asset remote terminal authority is foreign");
    }
  }
  if (
    authority.backupState !== "remote-backed" ||
    authority.terminalAuthority?.kind !== "remote-seal"
  ) {
    throw new Error("browser V2 desired asset remote terminal authority is foreign");
  }
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: proof.conditionId,
    outcomeCollection: proof.outcomeCollection,
  });
  const asset = decodeEncryptedWalletBackupV2AssetIdentity({
    mintUrl: proof.normalizedMint,
    unit: proof.unit,
    assetIdentity: `ctf:${proof.conditionId}:${outcomeCollectionId}`,
  });
  const desiredRaw = await database.encryptedWalletBackupV2DesiredAssets.get([
    proof.scopeId,
    encryptedWalletBackupV2LocalAssetKey(asset),
  ]);
  if (desiredRaw === undefined) {
    throw new Error("browser V2 desired asset terminal context is missing");
  }
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(desiredRaw);
  const context = desired.terminalCtfContext;
  if (
    desired.scopeId !== proof.scopeId ||
    desired.mintUrl !== proof.normalizedMint ||
    desired.unit !== proof.unit ||
    desired.assetIdentity !== asset.assetIdentity
  ) {
    throw new Error("browser V2 desired asset terminal context is foreign");
  }
  if (context === null) {
    throw new Error("browser V2 desired asset terminal context is missing");
  }
  if (
    context.conditionId !== proof.conditionId ||
    context.outcomeLabel !== proof.outcomeCollection ||
    context.outcomeCollectionId !== outcomeCollectionId
  ) {
    throw new Error("browser V2 desired asset terminal context is foreign");
  }
  return { asset, terminalCtfContext: context };
}

/** Validate a persisted remote-sealed proof before a keyset-free custody write. */
export async function requireBrowserV2KeysetFreeTerminalContextForProof(input: {
  readonly database: BitcasterDB;
  readonly proof: BrowserCustodyProofRow;
  readonly authority: unknown;
}): Promise<void> {
  if (input.proof.selectability !== "verified-losing") {
    throw new Error("browser V2 desired asset terminal proof state is invalid");
  }
  await loadRemoteTerminalAssetForProof(
    input.database,
    input.proof,
    requireBrowserProofBackupAuthorityRow(input.authority),
  );
}

function conditionalAssetForProof(
  proof: BrowserCustodyProofRow,
  keyset: ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow>,
): DesiredAssetMaterial {
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
  return {
    asset: createEncryptedWalletBackupV2AssetIdentity({
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
    }),
    terminalCtfContext: {
      conditionId: keyset.conditionId,
      outcomeLabel: keyset.outcomeCollection,
      outcomeCollectionId: keyset.outcomeCollectionId,
      registeredAt: keyset.registeredAtUnixSeconds,
      finalExpiry: keyset.finalExpiryUnixSeconds,
    },
  };
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
