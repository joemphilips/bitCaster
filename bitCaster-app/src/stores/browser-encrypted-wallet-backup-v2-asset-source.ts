import {
  createEncryptedWalletBackupV2AssetIdentity,
  deserializeDurableCustodyProofArtifact,
  issueEncryptedWalletBackupV2TerminalSeal,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  verifyDurableWalletConditionalKeyset,
  type EncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2CounterHighWaterMark,
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2PreparedTransportBundle,
  type EncryptedWalletBackupV2ProofSetAsset,
  type EncryptedWalletBackupV2ProofSetProof,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2CommittedTerminalSealStore,
  type EncryptedWalletBackupV2RemoteTerminalSealReuseResult,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyProofId } from "@bitcaster/client-sdk/durableCustody";
import { decodeDurableWalletProofDerivationLocator } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import {
  requireBrowserProofBackupAuthorityForProof,
  requireBrowserProofBackupAuthorityRow,
  type BrowserProofBackupTerminalAuthority,
} from "./browser-proof-backup-authority";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
  type EncryptedWalletBackupV2DesiredAssetRow,
  type EncryptedWalletBackupV2TerminalCtfContext,
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
  /** Losing bodies are retained, but cannot enter a bundle until sealed. */
  readonly losingProofs: readonly BrowserEncryptedWalletBackupV2LosingProof[];
  readonly counterHighWaterMarks: readonly EncryptedWalletBackupV2CounterHighWaterMark[];
}

export interface BrowserEncryptedWalletBackupV2LosingProof {
  readonly proofId: string;
  readonly proof: EncryptedWalletBackupV2ProofSetProof;
  readonly origin: BrowserProofBackupTerminalAuthority;
}

/** One local custody read with separate backup coverage and available amount facts. */
export interface BrowserEncryptedWalletBackupV2LocalAssetRead {
  readonly desired: EncryptedWalletBackupV2DesiredAssetRow | null;
  readonly activeProofs: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[];
  readonly backupEligibleProofCount: number;
  readonly snapshot: BrowserEncryptedWalletBackupV2AssetSnapshot | null;
}

export type BrowserEncryptedWalletBackupV2LocalAssetReadFailure =
  | "invalid-action"
  | "missing-authority"
  | "proof-read"
  | "snapshot-read";

export class BrowserEncryptedWalletBackupV2LocalAssetReadError extends Error {
  constructor(
    readonly code: BrowserEncryptedWalletBackupV2LocalAssetReadFailure,
    message: string,
  ) {
    super(message);
    this.name = "BrowserEncryptedWalletBackupV2LocalAssetReadError";
  }
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

/**
 * Reads one bounded local asset state. Locator-bearing proofs define backup
 * coverage. Locked operation proofs without locators remain local-only.
 */
export async function readBrowserEncryptedWalletBackupV2LocalAssetRead(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
}): Promise<BrowserEncryptedWalletBackupV2LocalAssetRead> {
  const expected = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    asset: input.asset,
    custodyRevision: 0n,
    activeProofCount: 0,
  });
  let raw: Awaited<ReturnType<typeof readRawAssetSnapshot>>;
  try {
    raw = await readRawAssetSnapshot({
      database: input.database,
      scopeId: input.scopeId,
      localAssetKey: expected.localAssetKey,
      expectedAsset: input.asset,
      localRead: true,
    });
  } catch (error) {
    if (error instanceof BrowserEncryptedWalletBackupV2LocalAssetReadError) throw error;
    throw localReadError("proof-read", "browser V2 local custody proof read failed");
  }
  const desired = raw.rawDesired === undefined ? null : raw.desired;
  const backupEligibleProofCount = raw.proofRows.length;
  let snapshot: BrowserEncryptedWalletBackupV2AssetSnapshot | null = null;
  if (
    desired !== null &&
    desired.desiredAction === "replace" &&
    raw.activeProofRows.length > 0 &&
    backupEligibleProofCount === desired.activeProofCount
  ) {
    try {
      snapshot = materializeAssetSnapshot(raw);
    } catch {
      throw localReadError("snapshot-read", "browser V2 local custody snapshot read failed");
    }
  }
  return Object.freeze({
    desired,
    activeProofs: Object.freeze([...raw.activeProofRows]),
    backupEligibleProofCount,
    snapshot,
  });
}

/** Reads exact active rows for one V2 asset without broad mint scanning. */
export async function readBrowserEncryptedWalletBackupV2ExactLocalProofRows(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  /** SDK-verified CTF tuple for an initial keyset-free admission route. */
  readonly ctfRoute?: Extract<EncryptedWalletBackupV2ProofSetAsset, { readonly kind: "ctf" }>;
}): Promise<readonly ReturnType<typeof decodeBrowserCustodyProofRow>[]> {
  if (
    input.ctfRoute !== undefined &&
    (!input.asset.assetIdentity.startsWith("ctf:") ||
      createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: input.asset.mintUrl,
        unit: input.asset.unit,
        asset: input.ctfRoute,
      }).assetIdentity !== input.asset.assetIdentity)
  )
    throw new Error("browser V2 exact local proof CTF route is foreign");
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: input.scopeId,
    asset: input.asset,
    custodyRevision: 0n,
    activeProofCount: 0,
  });
  const raw = await input.database.encryptedWalletBackupV2DesiredAssets.get([
    input.scopeId,
    desired.localAssetKey,
  ]);
  const persisted = raw === undefined ? null : decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
  if (
    persisted !== null &&
    (persisted.scopeId !== input.scopeId ||
      persisted.localAssetKey !== desired.localAssetKey ||
      persisted.mintUrl !== desired.mintUrl ||
      persisted.unit !== desired.unit ||
      persisted.assetIdentity !== desired.assetIdentity)
  )
    throw new Error("browser V2 exact local proof asset is foreign");
  let route = desired.assetIdentity.startsWith("ctf:")
    ? await ctfContext(input.database, persisted ?? desired, true)
    : null;
  if (route === null && persisted === null && input.ctfRoute !== undefined) {
    route = {
      first: null,
      keysets: Object.freeze([]),
      terminalCtfContext: input.ctfRoute,
    };
  }
  if (desired.assetIdentity.startsWith("ctf:") && route === null)
    throw new Error("browser V2 exact local proof CTF context is missing");
  return activeRows(
    input.database,
    persisted ?? desired,
    route?.first ?? route?.terminalCtfContext ?? null,
    true,
  );
}

async function readRawAssetSnapshot(
  input: BrowserEncryptedWalletBackupV2AssetSourceInput & {
    readonly expectedAsset?: EncryptedWalletBackupV2AssetIdentity;
    readonly localRead?: boolean;
  },
) {
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
      if (rawDesired === undefined && input.expectedAsset === undefined) {
        throw new Error("browser V2 desired asset is absent");
      }
      const expectedAsset = input.expectedAsset;
      let desired: EncryptedWalletBackupV2DesiredAssetRow;
      if (rawDesired === undefined) {
        if (expectedAsset === undefined) throw new Error("browser V2 desired asset is absent");
        desired = createEncryptedWalletBackupV2DesiredAssetRow({
          scopeId: input.scopeId,
          asset: expectedAsset,
          custodyRevision: 0n,
          activeProofCount: 0,
        });
      } else {
        try {
          desired = decodeEncryptedWalletBackupV2DesiredAssetRow(rawDesired);
        } catch (error) {
          if (!input.localRead) throw error;
          throw localReadError("invalid-action", "browser V2 local custody asset is invalid");
        }
      }
      if (desired.scopeId !== input.scopeId || desired.localAssetKey !== input.localAssetKey) {
        if (!input.localRead) throw new Error("browser V2 desired asset is foreign");
        throw localReadError("invalid-action", "browser V2 local custody asset is invalid");
      }
      const context = desired.assetIdentity.startsWith("ctf:")
        ? await ctfContext(input.database, desired, rawDesired === undefined)
        : null;
      if (desired.assetIdentity.startsWith("ctf:") && context === null) {
        return {
          rawDesired,
          desired,
          activeProofRows: [],
          proofRows: [],
          authorities: [],
          context: null,
          keysetIds: [],
          associations: [],
          cursors: [],
        };
      }
      const activeProofRows = await activeRows(
        input.database,
        desired,
        context?.first ?? context?.terminalCtfContext ?? null,
      );
      const rawAuthorities = await input.database.custodyProofBackupAuthorities.bulkGet(
        activeProofRows.map((row) => [row.scopeId, row.proofId]),
      );
      const activeProofs = activeProofRows.map((proof, index) => {
        const rawAuthority = rawAuthorities[index];
        if (rawAuthority === undefined)
          throw localReadRefusal(
            input,
            "missing-authority",
            "browser V2 proof backup authority is missing",
          );
        let authority: ReturnType<typeof requireBrowserProofBackupAuthorityForProof>;
        try {
          authority = requireBrowserProofBackupAuthorityForProof(rawAuthority, proof);
        } catch (error) {
          if (!input.localRead) throw error;
          throw localReadError(
            "snapshot-read",
            "browser V2 local custody proof authority is invalid",
          );
        }
        if (
          authority.derivationLocator === null &&
          (proof.selectability !== "locked" || proof.reservationOperationId === null)
        ) {
          throw localReadRefusal(
            input,
            "snapshot-read",
            "browser V2 local custody proof is not retained",
          );
        }
        return { proof, authority };
      });
      const eligibleProofs = activeProofs.filter(
        ({ authority }) => authority.derivationLocator !== null,
      );
      const proofRows = eligibleProofs.map(({ proof }) => proof);
      const authorities = eligibleProofs.map(({ authority }) => authority);
      const keysetIds = [...new Set(proofRows.map(({ keysetId }) => keysetId))];
      const unit = backupUnit(desired.unit);
      const associations = await input.database.walletCounterAssociations.bulkGet(
        keysetIds.map((keysetId) => [input.scopeId, desired.mintUrl, unit, keysetId]),
      );
      const cursors = await input.database.walletCounterCursors.bulkGet(
        keysetIds.map((keysetId) => [input.scopeId, keysetId]),
      );
      return {
        rawDesired,
        desired,
        activeProofRows,
        proofRows,
        authorities,
        context,
        keysetIds,
        associations,
        cursors,
      };
    },
  );
}

function localReadRefusal(
  input: { readonly localRead?: boolean },
  code: Exclude<BrowserEncryptedWalletBackupV2LocalAssetReadFailure, "proof-read">,
  message: string,
): Error {
  return input.localRead ? localReadError(code, message) : new Error(message);
}

function localReadError(
  code: BrowserEncryptedWalletBackupV2LocalAssetReadFailure,
  message: string,
): BrowserEncryptedWalletBackupV2LocalAssetReadError {
  return new BrowserEncryptedWalletBackupV2LocalAssetReadError(code, message);
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
  const asset = assetIdentity(
    desired,
    raw.proofRows,
    keysets,
    raw.context?.terminalCtfContext ?? null,
  );
  const proofs = raw.proofRows.map((row, index) =>
    proofSnapshot(row, raw.authorities[index], desired, asset.proofSetAsset, keysets),
  );
  const losingProofs = raw.proofRows.flatMap((row, index) => {
    if (row.selectability !== "verified-losing") return [];
    const authority = raw.authorities[index];
    if (authority === undefined || authority.terminalAuthority === null) {
      throw new Error("browser V2 losing proof origin is invalid");
    }
    return [
      Object.freeze({
        proofId: row.proofId,
        proof: proofs[index]!,
        origin: Object.freeze({ ...authority.terminalAuthority }),
      }),
    ];
  });
  return Object.freeze({
    desired,
    asset: asset.identity,
    proofs: Object.freeze(proofs),
    losingProofs: Object.freeze(losingProofs),
    counterHighWaterMarks: Object.freeze(
      counterMarks(
        desired,
        proofs,
        raw.proofRows,
        raw.keysetIds,
        raw.associations,
        raw.cursors,
        (raw.context?.keysets.length ?? 0) === 0,
      ),
    ),
  });
}

export async function prepareBrowserEncryptedWalletBackupV2AssetBundle(input: {
  readonly snapshot: BrowserEncryptedWalletBackupV2AssetSnapshot;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly seed: Uint8Array;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly bundleIdExists?: (bundleId: string) => boolean | Promise<boolean>;
  readonly terminalSealStore?: EncryptedWalletBackupV2CommittedTerminalSealStore;
  readonly remoteTerminalSealReuse?: EncryptedWalletBackupV2RemoteTerminalSealReuseResult;
}): Promise<EncryptedWalletBackupV2PreparedTransportBundle> {
  if (input.snapshot.desired.desiredAction !== "replace")
    throw new Error("browser V2 removal has no proof bundle");
  const proofs = await issueLocalTerminalSeals(input);
  const remoteAuthorities = input.remoteTerminalSealReuse?.authorities.filter((authority) =>
    input.snapshot.losingProofs.some(
      (losing) => losing.origin.kind === "remote-seal" && losing.proofId === authority.proofId,
    ),
  );
  return prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle: input.keyHandle,
    seed: input.seed,
    asset: input.snapshot.asset,
    proofs,
    custodyRevision: BigInt(input.snapshot.desired.custodyRevision),
    counterHighWaterMarks:
      input.snapshot.counterHighWaterMarks.length > 0
        ? input.snapshot.counterHighWaterMarks
        : (input.remoteTerminalSealReuse?.decrypted.counterHighWaterMarks ?? []),
    runtime: input.runtime,
    bundleIdExists: input.bundleIdExists,
    remoteTerminalSealReuses: remoteAuthorities,
    remoteTerminalSealReuseHeadEvidence: input.remoteTerminalSealReuse?.currentHeadEvidence,
  });
}

async function issueLocalTerminalSeals(input: {
  readonly snapshot: BrowserEncryptedWalletBackupV2AssetSnapshot;
  readonly seed: Uint8Array;
  readonly terminalSealStore?: EncryptedWalletBackupV2CommittedTerminalSealStore;
  readonly remoteTerminalSealReuse?: EncryptedWalletBackupV2RemoteTerminalSealReuseResult;
}): Promise<readonly EncryptedWalletBackupV2ProofSetProof[]> {
  const losingByProof = new Map(
    input.snapshot.losingProofs.map((losing) => [losing.proof, losing] as const),
  );
  if (losingByProof.size !== input.snapshot.losingProofs.length)
    throw new Error("browser V2 losing proof binding is duplicated");
  if (
    input.snapshot.losingProofs.some(
      ({ proof, proofId }) =>
        !input.snapshot.proofs.some((candidate) => candidate === proof) ||
        deriveDurableCustodyProofId({
          scopeId: input.snapshot.desired.scopeId,
          normalizedMint: proof.mintUrl,
          unit: proof.unit,
          keysetId: proof.proof.id,
          secret: proof.proof.secret,
        }) !== proofId,
    )
  )
    throw new Error("browser V2 losing proof binding is invalid");
  if (input.snapshot.proofs.some(({ terminalSeal }) => terminalSeal !== undefined))
    throw new Error("browser V2 terminal seal must be issued from local custody");
  const remoteReuse = input.remoteTerminalSealReuse;
  const remoteByProofId = new Map(
    remoteReuse?.decrypted.proofs
      .filter(({ terminalSeal }) => terminalSeal !== undefined)
      .map((proof) => [proof.proofId, proof] as const) ?? [],
  );
  return Promise.all(
    input.snapshot.proofs.map(async (proof) => {
      const losing = losingByProof.get(proof);
      if (losing === undefined) return proof;
      if (losing.origin.kind === "remote-seal") {
        if (remoteReuse === undefined)
          throw new Error("browser V2 remote terminal seal requires remote reuse authority");
        const restored = remoteByProofId.get(
          deriveDurableCustodyProofId({
            scopeId: input.snapshot.desired.scopeId,
            normalizedMint: proof.mintUrl,
            unit: proof.unit,
            keysetId: proof.proof.id,
            secret: proof.proof.secret,
          }),
        );
        if (restored?.terminalSeal === undefined)
          throw new Error("browser V2 remote terminal seal is missing");
        return Object.freeze({ ...proof, terminalSeal: restored.terminalSeal });
      }
      if (input.terminalSealStore === undefined)
        throw new Error("browser V2 losing proof requires a terminal seal store");
      const terminalSeal = await issueEncryptedWalletBackupV2TerminalSeal({
        seed: input.seed,
        proof,
        operationId: losing.origin.operationId,
        store: input.terminalSealStore,
      });
      return Object.freeze({ ...proof, terminalSeal });
    }),
  );
}

async function activeRows(
  database: BitcasterDB,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  ctf:
    | ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow>
    | EncryptedWalletBackupV2TerminalCtfContext
    | null,
  includePendingRemoval = false,
) {
  const selector =
    ctf === null
      ? "[scopeId+normalizedMint+unit+assetKind+selectability]"
      : "[scopeId+normalizedMint+unit+conditionId+outcomeCollection+selectability]";
  const values =
    ctf === null
      ? [desired.scopeId, desired.mintUrl, desired.unit, "regular"]
      : [
          desired.scopeId,
          desired.mintUrl,
          desired.unit,
          ctf.conditionId,
          "outcomeCollection" in ctf ? ctf.outcomeCollection : ctf.outcomeLabel,
        ];
  const states = includePendingRemoval
    ? (["selectable", "locked", "verified-losing", "pending-removal"] as const)
    : (["selectable", "locked", "verified-losing"] as const);
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

async function ctfContext(
  database: BitcasterDB,
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  allowAbsent = false,
) {
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
  if (first === undefined && allowAbsent && desired.terminalCtfContext === null) return null;
  if (first === undefined) {
    if (desired.terminalCtfContext === null)
      throw new Error("browser V2 conditional keyset context is invalid");
    return {
      first: null,
      keysets: Object.freeze([]),
      terminalCtfContext: desired.terminalCtfContext,
    };
  }
  if (keysets.some((row) => row.outcomeCollection !== first.outcomeCollection))
    throw new Error("browser V2 conditional keyset context is invalid");
  if (
    desired.terminalCtfContext !== null &&
    (desired.terminalCtfContext.conditionId !== first.conditionId ||
      desired.terminalCtfContext.outcomeLabel !== first.outcomeCollection ||
      desired.terminalCtfContext.outcomeCollectionId !== first.outcomeCollectionId ||
      desired.terminalCtfContext.registeredAt !== first.registeredAtUnixSeconds ||
      desired.terminalCtfContext.finalExpiry !== first.finalExpiryUnixSeconds)
  )
    throw new Error("browser V2 conditional keyset context conflicts");
  return {
    first,
    keysets: Object.freeze(keysets),
    terminalCtfContext: desired.terminalCtfContext,
  };
}

function assetIdentity(
  desired: EncryptedWalletBackupV2DesiredAssetRow,
  rows: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[],
  keysets: ReadonlyMap<string, ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow>>,
  terminalCtfContext: EncryptedWalletBackupV2TerminalCtfContext | null,
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
  const keyset = first === undefined ? undefined : keysets.get(first.keysetId);
  if (keyset === undefined && terminalCtfContext === null)
    throw new Error("browser V2 conditional keyset is missing");
  if (keyset !== undefined) keysets.forEach((value) => verifyCtfKeyset(value));
  const asset: EncryptedWalletBackupV2ProofSetAsset =
    keyset === undefined
      ? { kind: "ctf", ...terminalCtfContext! }
      : {
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
  if (asset.kind === "ctf") {
    const keyset = keysets.get(row.keysetId);
    if (keyset === undefined) {
      if (
        row.selectability !== "verified-losing" ||
        row.conditionId !== asset.conditionId ||
        row.outcomeCollection !== asset.outcomeLabel
      )
        throw new Error("browser V2 conditional keyset is missing");
    } else requireCtfKeyset(row, asset, keysets);
  }
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
  verifyDurableWalletConditionalKeyset({
    mint: keyset.normalizedMint,
    unit: keyset.unit,
    outcomeLabel: keyset.outcomeCollection,
    registeredAtUnixSeconds: keyset.registeredAtUnixSeconds,
    mintKeys: {
      id: keyset.keysetId,
      unit: keyset.unit,
      keys: keyset.denominationPublicKeys,
      input_fee_ppk: keyset.inputFeePpk,
      ...(keyset.finalExpiryUnixSeconds === null
        ? {}
        : { final_expiry: keyset.finalExpiryUnixSeconds }),
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
  rows: readonly ReturnType<typeof decodeBrowserCustodyProofRow>[],
  keysetIds: readonly string[],
  associations: readonly (import("./proof-db").BrowserWalletCounterAssociationRow | undefined)[],
  cursors: readonly (import("./proof-db").BrowserWalletCounterCursorRow | undefined)[],
  allowKeysetFreeSealed: boolean,
) {
  const highestNut13Counter = new Map<string, number>();
  for (const proof of proofs) {
    if (proof.locator.kind !== "nut13") continue;
    highestNut13Counter.set(
      proof.proof.id,
      Math.max(highestNut13Counter.get(proof.proof.id) ?? -1, proof.locator.counter),
    );
  }
  const sealedOnly =
    rows.length > 0 && rows.every(({ selectability }) => selectability === "verified-losing");
  if (
    allowKeysetFreeSealed &&
    sealedOnly &&
    keysetIds.some((keysetId, index) => {
      const association = associations[index];
      const cursor = cursors[index];
      return (
        association === undefined ||
        cursor === undefined ||
        association.scopeId !== desired.scopeId ||
        association.normalizedMint !== desired.mintUrl ||
        association.unit !== desired.unit ||
        association.keysetId !== keysetId ||
        cursor.scopeId !== desired.scopeId ||
        cursor.keysetId !== keysetId
      );
    })
  )
    return [];
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
