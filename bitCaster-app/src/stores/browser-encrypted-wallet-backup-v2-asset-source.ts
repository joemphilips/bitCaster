import {
  createEncryptedWalletBackupV2AssetIdentity,
  deserializeDurableCustodyProofArtifact,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  verifyEncryptedWalletBackupConditionalKeyset,
  type EncryptedWalletBackupV2CounterHighWaterMark,
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2PreparedTransportBundle,
  type EncryptedWalletBackupV2ProofSetAsset,
  type EncryptedWalletBackupV2ProofSetProof,
  type EncryptedWalletBackupV2BundleRuntime,
} from "@bitcaster/client-sdk";
import { decodeDurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { requireBrowserProofBackupAuthorityRow } from "./browser-proof-backup-authority";
import {
  decodeEncryptedWalletBackupV2DesiredAssetRow,
  type EncryptedWalletBackupV2DesiredAssetRow,
} from "./browser-encrypted-wallet-backup-v2-desired-asset";
import {
  decodeBrowserCustodyConditionalKeysetRow,
  decodeBrowserCustodyProofRow,
} from "./durable-custody-types";
import type { BitcasterDB } from "./proof-db";

export interface BrowserEncryptedWalletBackupV2AssetSnapshot {
  readonly desired: EncryptedWalletBackupV2DesiredAssetRow;
  readonly asset: ReturnType<typeof createEncryptedWalletBackupV2AssetIdentity>;
  readonly proofs: readonly EncryptedWalletBackupV2ProofSetProof[];
  readonly counterHighWaterMarks: readonly EncryptedWalletBackupV2CounterHighWaterMark[];
}

interface BrowserEncryptedWalletBackupV2AssetSourceInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly localAssetKey: string;
}

/** Reads one bounded, exact custody snapshot for one persisted desired asset. */
export async function readBrowserEncryptedWalletBackupV2AssetSnapshot(
  input: BrowserEncryptedWalletBackupV2AssetSourceInput,
): Promise<BrowserEncryptedWalletBackupV2AssetSnapshot> {
  return materializeAssetSnapshot(await readRawAssetSnapshot(input));
}

async function readRawAssetSnapshot(input: BrowserEncryptedWalletBackupV2AssetSourceInput) {
  return input.database.transaction(
    "r",
    [
      input.database.encryptedWalletBackupV2DesiredAssets,
      input.database.custodyProofs,
      input.database.custodyProofBackupAuthorities,
      input.database.custodyConditionalKeysets,
      input.database.walletCounterAssociations,
      input.database.walletCounterCursors,
    ],
    async () => {
      const rawDesired = await input.database.encryptedWalletBackupV2DesiredAssets.get([
        input.scopeId,
        input.localAssetKey,
      ]);
      if (rawDesired === undefined) throw new Error("browser V2 desired asset is absent");
      const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
      if (desired.scopeId !== input.scopeId || desired.localAssetKey !== input.localAssetKey)
        throw new Error("browser V2 desired asset is foreign");
      const context = desired.assetIdentity.startsWith("ctf:")
        ? await ctfContext(input.database, desired)
        : null;
      const proofRows = await activeRows(input.database, desired, context?.first ?? null);
      const authorities = await input.database.custodyProofBackupAuthorities.bulkGet(
        proofRows.map((row) => [row.scopeId, row.proofId]),
      );
      const keysetIds = [...new Set(proofRows.map(({ keysetId }) => keysetId))];
      const unit = backupUnit(desired.unit);
      const associations = await input.database.walletCounterAssociations.bulkGet(
        keysetIds.map((keysetId) => [input.scopeId, desired.mintUrl, unit, keysetId]),
      );
      const cursors = await input.database.walletCounterCursors.bulkGet(
        keysetIds.map((keysetId) => [input.scopeId, keysetId]),
      );
      return { rawDesired, proofRows, authorities, context, keysetIds, associations, cursors };
    },
  );
}

function materializeAssetSnapshot(
  raw: Awaited<ReturnType<typeof readRawAssetSnapshot>>,
): BrowserEncryptedWalletBackupV2AssetSnapshot {
  const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(raw.rawDesired);
  if (raw.proofRows.length !== desired.activeProofCount)
    throw new Error("browser V2 desired asset proof count is stale");
  const keysets = new Map(
    (raw.context?.keysets ?? []).map((keyset) => [keyset.keysetId, keyset] as const),
  );
  const asset = assetIdentity(desired, raw.proofRows, keysets);
  const proofs = raw.proofRows.map((row, index) =>
    proofSnapshot(row, raw.authorities[index], desired, asset.proofSetAsset, keysets),
  );
  return Object.freeze({
    desired,
    asset: asset.identity,
    proofs: Object.freeze(proofs),
    counterHighWaterMarks: Object.freeze(
      counterMarks(desired, proofs, raw.keysetIds, raw.associations, raw.cursors),
    ),
  });
}

export async function prepareBrowserEncryptedWalletBackupV2AssetBundle(input: {
  readonly snapshot: BrowserEncryptedWalletBackupV2AssetSnapshot;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly seed: Uint8Array;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly bundleIdExists?: (bundleId: string) => boolean | Promise<boolean>;
}): Promise<EncryptedWalletBackupV2PreparedTransportBundle> {
  if (input.snapshot.desired.desiredAction !== "replace")
    throw new Error("browser V2 removal has no proof bundle");
  return prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle: input.keyHandle,
    seed: input.seed,
    asset: input.snapshot.asset,
    proofs: input.snapshot.proofs,
    custodyRevision: BigInt(input.snapshot.desired.custodyRevision),
    counterHighWaterMarks: input.snapshot.counterHighWaterMarks,
    runtime: input.runtime,
    bundleIdExists: input.bundleIdExists,
  });
}

async function activeRows(
  database: BitcasterDB,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  ctf: ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow> | null,
) {
  const selector =
    ctf === null
      ? "[scopeId+normalizedMint+unit+assetKind+selectability]"
      : "[scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability]";
  const values =
    ctf === null
      ? [desired.scopeId, desired.mintUrl, desired.unit, "regular"]
      : [desired.scopeId, desired.mintUrl, desired.unit, ctf.conditionId, ctf.outcomeCollection];
  const states = ["selectable", "locked"] as const;
  const groups = await Promise.all(
    states.map((state) =>
      database.custodyProofs
        .where(selector as never)
        .equals([...values, state] as never)
        .limit(513)
        .toArray(),
    ),
  );
  const rows = groups.flat().map(decodeBrowserCustodyProofRow);
  if (rows.length > 512) throw new Error("browser V2 desired asset proof count exceeds the limit");
  return rows;
}

async function ctfContext(database: BitcasterDB, desired: EncryptedWalletBackupV2DesiredAssetRow) {
  const identity = desired.assetIdentity.split(":");
  if (identity.length !== 3 || identity[0] !== "ctf")
    throw new Error("browser V2 CTF asset identity is invalid");
  const rows = await database.custodyConditionalKeysets
    .where("[scopeId+normalizedMint+unit+conditionId+outcomeCollectionId]" as never)
    .equals([desired.scopeId, desired.mintUrl, desired.unit, identity[1], identity[2]] as never)
    .limit(17)
    .toArray();
  const keysets = rows.map(decodeBrowserCustodyConditionalKeysetRow);
  if (keysets.length > 16)
    throw new Error("browser V2 conditional keyset context exceeds the limit");
  const first = keysets[0];
  if (
    first === undefined ||
    keysets.some((row) => row.outcomeCollection !== first.outcomeCollection)
  )
    throw new Error("browser V2 conditional keyset context is invalid");
  return { first, keysets: Object.freeze(keysets) };
}

function assetIdentity(
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  rows: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[],
  keysets: ReadonlyMap<string, ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow>>,
) {
  if (!desired.assetIdentity.startsWith("ctf:")) {
    const proofSetAsset = { kind: "ordinary" } as const;
    return {
      identity: createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: desired.mintUrl,
        unit: desired.unit,
        asset: proofSetAsset,
      }),
      proofSetAsset,
    };
  }
  const first = rows[0];
  if (first === undefined || first.assetKind !== "conditional")
    throw new Error("browser V2 conditional asset is empty");
  const keyset = keysets.get(first.keysetId);
  if (keyset === undefined) throw new Error("browser V2 conditional keyset is missing");
  keysets.forEach((value) => verifyCtfKeyset(value));
  const asset: EncryptedWalletBackupV2ProofSetAsset = {
    kind: "ctf",
    conditionId: keyset.conditionId,
    outcomeCollectionId: keyset.outcomeCollectionId,
    outcomeLabel: keyset.outcomeCollection,
    registeredAt: keyset.registeredAtUnixSeconds,
    finalExpiry: keyset.finalExpiryUnixSeconds,
  };
  if (`ctf:${asset.conditionId}:${asset.outcomeCollectionId}` !== desired.assetIdentity)
    throw new Error("browser V2 conditional asset is foreign");
  return {
    identity: createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: desired.mintUrl,
      unit: desired.unit,
      asset,
    }),
    proofSetAsset: asset,
  };
}

function proofSnapshot(
  row: ReturnType<typeof decodeBrowserCustodyProofRow>,
  rawAuthority: unknown,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  asset: EncryptedWalletBackupV2ProofSetAsset,
  keysets: ReadonlyMap<string, ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow>>,
) {
  if (
    row.scopeId !== desired.scopeId ||
    row.normalizedMint !== desired.mintUrl ||
    row.unit !== desired.unit
  )
    throw new Error("browser V2 custody proof is foreign");
  if (rawAuthority === undefined) throw new Error("browser V2 proof backup authority is missing");
  const authority = requireBrowserProofBackupAuthorityRow(rawAuthority);
  if (
    authority.scopeId !== row.scopeId ||
    authority.proofId !== row.proofId ||
    authority.proofRevision !== row.revision ||
    authority.proofState !== row.selectability ||
    authority.derivationLocator === null
  )
    throw new Error("browser V2 proof backup authority is foreign");
  if (asset.kind === "ctf") requireCtfKeyset(row, asset, keysets);
  return Object.freeze({
    mintUrl: row.normalizedMint,
    unit: row.unit,
    asset,
    proof: deserializeDurableCustodyProofArtifact(
      JSON.parse(new TextDecoder().decode(row.proofBody)),
    ),
    locator: decodeDurableWalletProofDerivationLocator(authority.derivationLocator),
  });
}

function requireCtfKeyset(
  row: ReturnType<typeof decodeBrowserCustodyProofRow>,
  asset: Extract<EncryptedWalletBackupV2ProofSetAsset, { kind: "ctf" }>,
  keysets: ReadonlyMap<string, ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow>>,
) {
  const keyset = keysets.get(row.keysetId);
  if (keyset === undefined) throw new Error("browser V2 conditional keyset is missing");
  if (
    keyset.conditionId !== asset.conditionId ||
    keyset.outcomeCollectionId !== asset.outcomeCollectionId ||
    keyset.outcomeCollection !== asset.outcomeLabel
  )
    throw new Error("browser V2 conditional keyset is foreign");
}

function verifyCtfKeyset(
  keyset: ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow>,
): void {
  verifyEncryptedWalletBackupConditionalKeyset({
    mint: keyset.normalizedMint,
    unit: keyset.unit,
    outcomeLabel: keyset.outcomeCollection,
    registeredAtUnixSeconds: keyset.registeredAtUnixSeconds,
    mintKeys: {
      id: keyset.keysetId,
      unit: keyset.unit,
      keys: keyset.denominationPublicKeys,
      input_fee_ppk: keyset.inputFeePpk,
      final_expiry: keyset.finalExpiryUnixSeconds,
      conditional: {
        conditionId: keyset.conditionId,
        outcomeCollection: keyset.outcomeCollection,
        outcomeCollectionId: keyset.outcomeCollectionId,
        registeredAt: keyset.registeredAtUnixSeconds,
      },
    },
    conditionalMetadata: {
      conditionId: keyset.conditionId,
      outcomeCollection: keyset.outcomeCollection,
      outcomeCollectionId: keyset.outcomeCollectionId,
      registeredAt: keyset.registeredAtUnixSeconds,
    },
  });
}

function counterMarks(
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  proofs: readonly EncryptedWalletBackupV2ProofSetProof[],
  keysetIds: readonly string[],
  associations: readonly (import("./proof-db").BrowserWalletCounterAssociationRow | undefined)[],
  cursors: readonly (import("./proof-db").BrowserWalletCounterCursorRow | undefined)[],
) {
  const highestNut13Counter = new Map<string, number>();
  for (const proof of proofs) {
    if (proof.locator.kind !== "nut13") continue;
    highestNut13Counter.set(
      proof.proof.id,
      Math.max(highestNut13Counter.get(proof.proof.id) ?? -1, proof.locator.counter),
    );
  }
  return keysetIds.map((keysetId, index) => {
    const association = associations[index];
    const cursor = cursors[index];
    if (
      association === undefined ||
      cursor === undefined ||
      association.scopeId !== desired.scopeId ||
      association.normalizedMint !== desired.mintUrl ||
      association.unit !== desired.unit ||
      association.keysetId !== keysetId ||
      cursor.scopeId !== desired.scopeId ||
      cursor.keysetId !== keysetId ||
      association.recoveryComplete !== true ||
      cursor.next < 0 ||
      cursor.next > 2_147_483_648
    )
      throw new Error("browser V2 counter authority is missing");
    if ((highestNut13Counter.get(keysetId) ?? -1) >= cursor.next)
      throw new Error("browser V2 NUT-13 locator is ahead of its cursor");
    return Object.freeze({
      mintUrl: desired.mintUrl,
      unit: backupUnit(desired.unit),
      keysetId,
      nextCounter: cursor.next,
    });
  });
}

function backupUnit(value: string): "sat" | "msat" {
  if (value === "sat" || value === "msat") return value;
  throw new Error("browser V2 asset unit is invalid");
}
