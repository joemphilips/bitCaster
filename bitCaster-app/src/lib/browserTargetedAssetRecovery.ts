import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  decodeAssetMonitoringAssetReference,
  decodeAssetMonitoringRecoveryHint,
  deriveDurableCustodyProofId,
  deriveDurableWalletProofSecret,
  deriveEncryptedWalletBackupV2AssetLocator,
  locateSeedDerivedProofLineage,
  prepareEncryptedWalletBackupV2RequestProof,
  recoverTargetedAsset,
  type AssetMonitoringAssetResponse,
  type EncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2KeyHandle,
  type EncryptedWalletBackupV2RemotePort,
  type TargetedAssetRecoveryInput,
  type TargetedAssetRecoveryAttemptKey,
  type TargetedAssetRecoveryCompletedOutcome,
  type TargetedAssetRecoveryMintRequest,
  type TargetedAssetRecoveryOutcome,
} from "@bitcaster/client-sdk";
import {
  isBlsKeyset,
  verifyProofsForReceive,
  type Proof,
  type Wallet as CashuWallet,
} from "@cashu/cashu-ts";
import {
  admitBrowserReceivedProofsWithHeldProfileLock,
  type AdmitBrowserReceivedProofsInput,
} from "./browserCustodyProofReceive";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import {
  readBrowserEncryptedWalletBackupV2LocalAvailableAmount,
  restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset,
  type BrowserEncryptedWalletBackupV2TargetedRestoreInput,
  type BrowserEncryptedWalletBackupV2FailureClass,
  type BrowserEncryptedWalletBackupV2RestoreStage,
} from "./browserEncryptedWalletBackupV2Restore";
import { BrowserTargetedAssetRecoveryAttemptStore } from "../stores/browser-targeted-asset-recovery-attempt-store";
import { readBrowserEncryptedWalletBackupV2ExactLocalProofRows } from "../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { withWalletProfileLock } from "./walletProfileLock";
import { normalizeUrl } from "./url";
import {
  restoreProofsAndAdvanceCounter,
  type BitcasterDB,
  type StoredProof,
} from "../stores/proof-db";

export interface BrowserTargetedAssetRecoveryInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly seed: Uint8Array;
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle;
  readonly enrollmentEpoch: number;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly requiredAmount: bigint;
  /** Loads the mint only after local custody is insufficient. */
  readonly loadWallet: () => Promise<CashuWallet>;
  /** Loads the exact engine fact only after authenticated backup absence. */
  readonly readExactMonitoringRecovery: () => Promise<BrowserTargetedAssetRecoveryMonitoring | null>;
  readonly remote: EncryptedWalletBackupV2RemotePort;
  readonly requestUrl: BrowserEncryptedWalletBackupV2TargetedRestoreInput["requestUrl"];
  readonly currentInventoryUrl: string;
  readonly nowUnixSeconds: () => number;
  readonly completedAtUnixMilliseconds: () => number;
  readonly runtime: EncryptedWalletBackupV2BundleRuntime;
  readonly signal: AbortSignal;
  readonly isCurrentProfile: () => boolean;
  readonly lockManager?: Pick<LockManager, "request">;
}

export interface BrowserTargetedAssetRecoveryMonitoring {
  readonly fact: AssetMonitoringAssetResponse;
}

type BrowserTargetedAssetRecoveryStage =
  | "current-inventory"
  | BrowserEncryptedWalletBackupV2RestoreStage
  | "monitoring"
  | "mint";

/** Runs one exact browser recovery. It does not discover monitoring assets or mint counters. */
export async function recoverBrowserTargetedAsset(
  input: BrowserTargetedAssetRecoveryInput,
): Promise<TargetedAssetRecoveryOutcome> {
  let reported = false;
  let failureReported = false;
  const report = (stage: BrowserTargetedAssetRecoveryStage): void => {
    if (reported) return;
    reported = true;
    console.warn(`targeted-recovery-stage=${stage}`);
  };
  const reportFailure = (failureClass: BrowserEncryptedWalletBackupV2FailureClass): void => {
    if (failureReported) return;
    failureReported = true;
    console.warn(`targeted-recovery-error=${failureClass}`);
  };
  try {
    requireCurrent(input);
    const scope = browserWalletScope(input.seed);
    if (scope.scopeId !== input.scopeId || scope.walletId !== input.keyHandle.walletId) {
      throw new Error("targeted asset recovery scope is foreign");
    }
    const recovery = await recoveryInput(input);
    return await targetedRecoveryLock(input.scopeId, recovery.assetLocator, input.lockManager, () =>
      recoverTargetedAsset(recovery, recoveryPorts(input, report, reportFailure)),
    );
  } catch {
    report("current-inventory");
    return { kind: "persistent-error" };
  }
}

/** Produces a stable version from recovery authority only, never from portfolio valuation fields. */
export function browserTargetedAssetRecoveryFactVersion(
  fact: Pick<AssetMonitoringAssetResponse, "asset" | "availableSubunits" | "recoveryHint">,
): string {
  const asset = decodeAssetMonitoringAssetReference(fact.asset);
  const availableSubunits = requireAmount(fact.availableSubunits);
  const recoveryHint =
    fact.recoveryHint === null
      ? null
      : canonicalRecoveryHint(decodeAssetMonitoringRecoveryHint(fact.recoveryHint));
  const bytes = new TextEncoder().encode(
    JSON.stringify({ asset, availableSubunits, recoveryHint }),
  );
  return `v1-${bytesToHex(sha256(bytes))}`;
}

async function recoveryInput(
  input: BrowserTargetedAssetRecoveryInput,
): Promise<TargetedAssetRecoveryInput> {
  return {
    scopeId: input.scopeId,
    assetLocator: await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle: input.keyHandle,
      ...input.asset,
    }),
    asset: input.asset,
  };
}

function recoveryPorts(
  input: BrowserTargetedAssetRecoveryInput,
  report: (stage: BrowserTargetedAssetRecoveryStage) => void,
  reportFailure: (failureClass: BrowserEncryptedWalletBackupV2FailureClass) => void,
) {
  const attempts = new BrowserTargetedAssetRecoveryAttemptStore({
    database: input.database,
    scopeId: input.scopeId,
    completedAtUnixMilliseconds: input.completedAtUnixMilliseconds,
  });
  const monitoring = lazyMonitoringRecovery(input, report);
  const wallet = lazyWallet(input);
  return {
    hasLocalCustody: async () => {
      try {
        const available = await readBrowserEncryptedWalletBackupV2LocalAvailableAmount(input);
        return available !== null && available >= input.requiredAmount;
      } catch {
        report("current-inventory");
        throw new Error("targeted asset recovery local custody failed");
      }
    },
    readAuthenticatedCurrentBackupInventory: (recovery: TargetedAssetRecoveryInput) =>
      readCurrentInventory(input, recovery, report),
    restoreAndAdmitBackup: async () => {
      let loadedWallet: CashuWallet;
      try {
        loadedWallet = await wallet();
      } catch {
        report("backup-verify");
        throw new Error("targeted asset recovery wallet load failed");
      }
      await restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
        ...input,
        wallet: loadedWallet,
        minimumAvailableAmount: input.requiredAmount,
        reportTargetedRecoveryStage: report,
        reportTargetedRecoveryFailureClass: reportFailure,
      });
      try {
        const available = await readBrowserEncryptedWalletBackupV2LocalAvailableAmount(input);
        if (available === null || available < input.requiredAmount) {
          report("backup-admit-postcheck");
          throw new Error("targeted asset recovery backup amount is incomplete");
        }
      } catch {
        report("backup-admit-postcheck");
        throw new Error("targeted asset recovery backup admission failed");
      }
    },
    readExactMonitoringFact: () => exactMonitoringFact(monitoring, report),
    readCompletedAttempt: async (key: TargetedAssetRecoveryAttemptKey) => {
      try {
        return await attempts.readCompletedAttempt(key);
      } catch {
        report("mint");
        throw new Error("targeted asset recovery attempt read failed");
      }
    },
    recordCompletedAttempt: async (
      key: TargetedAssetRecoveryAttemptKey,
      outcome: TargetedAssetRecoveryCompletedOutcome,
    ) => {
      try {
        await attempts.recordCompletedAttempt(key, outcome);
      } catch {
        report("mint");
        throw new Error("targeted asset recovery attempt write failed");
      }
    },
    recoverFromMint: ({
      recovery,
      attemptKey,
      requests,
    }: {
      recovery: TargetedAssetRecoveryInput;
      attemptKey: TargetedAssetRecoveryAttemptKey;
      requests: readonly TargetedAssetRecoveryMintRequest[];
    }) =>
      restoreExactMintRequests(input, wallet, monitoring, recovery, attemptKey, requests, report),
  };
}

async function readCurrentInventory(
  input: BrowserTargetedAssetRecoveryInput,
  recovery: TargetedAssetRecoveryInput,
  report: (stage: BrowserTargetedAssetRecoveryStage) => void,
) {
  try {
    requireCurrent(input);
    const issuedAtUnixSeconds = input.nowUnixSeconds();
    const requestProof = await prepareEncryptedWalletBackupV2RequestProof({
      keyHandle: input.keyHandle,
      enrollmentEpoch: input.enrollmentEpoch,
      method: "GET",
      url: input.currentInventoryUrl,
      issuedAtUnixSeconds,
      expiresAtUnixSeconds: issuedAtUnixSeconds + 60,
      payload: new Uint8Array(),
      signal: input.signal,
      runtime: input.runtime,
    });
    requireCurrent(input);
    const inventory = await input.remote.readCurrentInventory({
      requestProof,
      signal: input.signal,
    });
    requireCurrent(input);
    const exact = inventory.entries.find(
      ({ assetLocator }) => assetLocator === recovery.assetLocator,
    );
    return {
      kind: "available" as const,
      headVersion: inventory.headVersion,
      exactEntry: exact !== undefined && exact.declaredAmount >= input.requiredAmount ? true : null,
    };
  } catch {
    report("current-inventory");
    throw new Error("targeted asset recovery inventory failed");
  }
}

function lazyMonitoringRecovery(
  input: BrowserTargetedAssetRecoveryInput,
  report: (stage: BrowserTargetedAssetRecoveryStage) => void,
) {
  let pending: Promise<BrowserTargetedAssetRecoveryMonitoring | null> | undefined;
  return async (): Promise<BrowserTargetedAssetRecoveryMonitoring | null> => {
    try {
      if (pending === undefined) pending = input.readExactMonitoringRecovery();
      const monitoring = await pending;
      requireCurrent(input);
      if (monitoring === null) return null;
      if (BigInt(requireAmount(monitoring.fact.availableSubunits)) < input.requiredAmount)
        return null;
      return monitoring;
    } catch {
      report("monitoring");
      throw new Error("targeted asset recovery monitoring failed");
    }
  };
}

function lazyWallet(input: BrowserTargetedAssetRecoveryInput) {
  let pending: Promise<CashuWallet> | undefined;
  return async (): Promise<CashuWallet> => {
    if (pending === undefined) {
      requireCurrent(input);
      pending = input.loadWallet();
    }
    const wallet = await pending;
    requireCurrent(input);
    return wallet;
  };
}

async function exactMonitoringFact(
  readMonitoring: () => Promise<BrowserTargetedAssetRecoveryMonitoring | null>,
  report: (stage: BrowserTargetedAssetRecoveryStage) => void,
) {
  try {
    const monitoring = await readMonitoring();
    if (monitoring === null) return null;
    return {
      asset: decodeAssetMonitoringAssetReference(monitoring.fact.asset),
      factVersion: browserTargetedAssetRecoveryFactVersion(monitoring.fact),
      availableSubunits: monitoring.fact.availableSubunits,
      recoveryHint: monitoring.fact.recoveryHint,
    };
  } catch {
    report("monitoring");
    throw new Error("targeted asset recovery monitoring failed");
  }
}

async function restoreExactMintRequests(
  input: BrowserTargetedAssetRecoveryInput,
  readWallet: () => Promise<CashuWallet>,
  readMonitoring: () => Promise<BrowserTargetedAssetRecoveryMonitoring | null>,
  recovery: TargetedAssetRecoveryInput,
  attemptKey: TargetedAssetRecoveryAttemptKey,
  requests: readonly TargetedAssetRecoveryMintRequest[],
  report: (stage: BrowserTargetedAssetRecoveryStage) => void,
): Promise<"restored" | "unavailable"> {
  try {
    const monitoring = await readMonitoring();
    if (monitoring === null) throw new Error("targeted asset recovery monitoring is unavailable");
    const wallet = await readWallet();
    requireMintAuthority(input, wallet, requests);
    const existingProofIds = new Set(
      (
        await readBrowserEncryptedWalletBackupV2ExactLocalProofRows({
          database: input.database,
          scopeId: input.scopeId,
          asset: input.asset,
        })
      ).map(({ proofId }) => proofId),
    );
    const ranges: { request: TargetedAssetRecoveryMintRequest; proofs: Proof[] }[] = [];
    for (const request of requests) {
      requireCurrent(input);
      const response = await wallet.restore(request.counterStart, request.counterCount, {
        keysetId: request.keysetId,
      });
      requireCurrent(input);
      requireExactRestoreProofs(input.seed, response.proofs, request);
      verifyExactMintProofs(input, wallet, response.proofs);
      ranges.push({ request, proofs: response.proofs });
    }
    const allProofs = ranges.flatMap(({ proofs }) => proofs);
    const groups =
      allProofs.length === 0
        ? { unspent: [], pending: [], spent: [] }
        : await wallet.groupProofsByState(allProofs);
    requireCurrent(input);
    const unspentSecrets = requireExactProofStateGroups(allProofs, groups);
    for (const { request, proofs } of ranges) {
      const fresh = proofs.filter((proof) => {
        if (!unspentSecrets.has(proof.secret)) return false;
        const proofId = exactProofId(input, proof);
        if (existingProofIds.has(proofId)) return false;
        existingProofIds.add(proofId);
        return true;
      });
      await admitExactMintProofs(input, wallet, recovery, attemptKey, request, fresh);
    }
    const available = await readBrowserEncryptedWalletBackupV2LocalAvailableAmount(input);
    requireCurrent(input);
    return available !== null && available >= input.requiredAmount ? "restored" : "unavailable";
  } catch {
    report("mint");
    throw new Error("targeted asset recovery mint failed");
  }
}

function exactProofId(input: BrowserTargetedAssetRecoveryInput, proof: Proof): string {
  return deriveDurableCustodyProofId({
    scopeId: input.scopeId,
    normalizedMint: input.asset.mintUrl,
    unit: input.asset.unit,
    keysetId: proof.id,
    secret: proof.secret,
  });
}

function requireExactProofStateGroups(
  expected: readonly Proof[],
  groups: { readonly unspent: Proof[]; readonly pending: Proof[]; readonly spent: Proof[] },
): ReadonlySet<string> {
  const expectedSecrets = new Set(expected.map(({ secret }) => secret));
  if (expectedSecrets.size !== expected.length)
    throw new Error("targeted asset recovery mint result is duplicated");
  const classified = [...groups.unspent, ...groups.pending, ...groups.spent];
  const classifiedSecrets = new Set(classified.map(({ secret }) => secret));
  if (
    classified.length !== expected.length ||
    classifiedSecrets.size !== expectedSecrets.size ||
    [...classifiedSecrets].some((secret) => !expectedSecrets.has(secret))
  ) {
    throw new Error("targeted asset recovery proof states are invalid");
  }
  return new Set(groups.unspent.map(({ secret }) => secret));
}

function verifyExactMintProofs(
  input: BrowserTargetedAssetRecoveryInput,
  wallet: CashuWallet,
  proofs: readonly Proof[],
): void {
  for (const proof of proofs) requireProofAsset(input.asset, wallet, proof);
  verifyProofsForReceive([...proofs], (keysetId) => wallet.getKeyset(keysetId), {
    requireDleq: true,
  });
}

async function admitExactMintProofs(
  input: BrowserTargetedAssetRecoveryInput,
  wallet: CashuWallet,
  recovery: TargetedAssetRecoveryInput,
  attemptKey: TargetedAssetRecoveryAttemptKey,
  request: TargetedAssetRecoveryMintRequest,
  unspent: readonly Proof[],
): Promise<void> {
  const stored = storedProofs(input, wallet, unspent);
  const locators = new Map(
    locateSeedDerivedProofLineage({
      seed: input.seed,
      keysetId: request.keysetId,
      counterStart: request.counterStart,
      counterCount: request.counterCount,
      proofs: deterministicRangeProofs(input.seed, request),
    })
      .filter(({ secret }) => unspent.some((proof) => proof.secret === secret))
      .map(({ secret, ...locator }) => [secret, locator]),
  );
  await withWalletProfileLock(
    input.scopeId,
    () => commitExactMintProofs(input, wallet, recovery, attemptKey, request, stored, locators),
    input.lockManager,
  );
}

async function commitExactMintProofs(
  input: BrowserTargetedAssetRecoveryInput,
  wallet: CashuWallet,
  recovery: TargetedAssetRecoveryInput,
  attemptKey: TargetedAssetRecoveryAttemptKey,
  request: TargetedAssetRecoveryMintRequest,
  stored: readonly StoredProof[],
  locators: NonNullable<AdmitBrowserReceivedProofsInput["proofLocators"]>,
): Promise<void> {
  await input.database.transaction("rw", input.database.tables, async () => {
    requireCurrent(input);
    if (stored.length !== 0) {
      await admitBrowserReceivedProofsWithHeldProfileLock({
        seed: input.seed,
        sourceOperationId: mintRecoverySourceOperationId(recovery, attemptKey, request),
        mintUrl: input.asset.mintUrl,
        unit: requiredUnit(input.asset.unit),
        wallet,
        proofs: stored,
        derivationAuthority: null,
        proofLocators: locators,
        database: input.database,
      });
    }
    await restoreProofsAndAdvanceCounter(
      {
        proofs: [...stored],
        scopeId: input.scopeId,
        mintUrl: input.asset.mintUrl,
        unit: input.asset.unit,
        keysetId: request.keysetId,
        restoredNext: request.counterStart + request.counterCount,
        isCurrentProfile: input.isCurrentProfile,
      },
      input.database,
    );
    requireCurrent(input);
  });
}

function mintRecoverySourceOperationId(
  recovery: TargetedAssetRecoveryInput,
  attemptKey: TargetedAssetRecoveryAttemptKey,
  request: TargetedAssetRecoveryMintRequest,
): string {
  const authority = new TextEncoder().encode(
    JSON.stringify([
      recovery.scopeId,
      recovery.assetLocator,
      attemptKey.monitoringFactVersion,
      attemptKey.backupHeadVersion,
      request.keysetId,
      request.counterStart,
      request.counterCount,
    ]),
  );
  return `targeted-recovery:${bytesToHex(sha256(authority))}`;
}

function storedProofs(
  input: BrowserTargetedAssetRecoveryInput,
  wallet: CashuWallet,
  proofs: readonly Proof[],
): StoredProof[] {
  const unit = requiredUnit(input.asset.unit);
  return proofs.map((proof) => {
    const conditional = wallet.getKeyset(proof.id).conditional;
    return {
      ...proof,
      ...(conditional === undefined
        ? {}
        : {
            conditionId: conditional.conditionId,
            outcomeCollection: conditional.outcomeCollection,
            marketId: `${conditional.conditionId}-${conditional.outcomeCollection}`,
          }),
      mintUrl: input.asset.mintUrl,
      unit,
    };
  });
}

function deterministicRangeProofs(
  seed: Uint8Array,
  request: TargetedAssetRecoveryMintRequest,
): readonly Pick<Proof, "id" | "secret">[] {
  if (!Number.isSafeInteger(request.counterStart + request.counterCount)) {
    throw new Error("targeted asset recovery counter range is invalid");
  }
  return Array.from({ length: request.counterCount }, (_, offset) => ({
    id: request.keysetId,
    secret: deriveDurableWalletProofSecret({
      seed,
      locator: {
        schemaVersion: 1,
        kind: "nut13",
        keysetId: request.keysetId,
        counter: request.counterStart + offset,
      },
      proofKeysetId: request.keysetId,
      proofAmount: 1,
    }),
  }));
}

function requireExactRestoreProofs(
  seed: Uint8Array,
  proofs: readonly Proof[],
  request: TargetedAssetRecoveryMintRequest,
): void {
  const expected = new Set(deterministicRangeProofs(seed, request).map(({ secret }) => secret));
  if (
    proofs.length > request.counterCount ||
    proofs.some((proof) => proof.id !== request.keysetId || !expected.has(proof.secret))
  ) {
    throw new Error("targeted asset recovery mint result is foreign");
  }
  const bySecret = new Map(proofs.map((proof) => [proof.secret, proof]));
  if (bySecret.size !== proofs.length)
    throw new Error("targeted asset recovery mint result is duplicated");
}

function requireProofAsset(
  asset: EncryptedWalletBackupV2AssetIdentity,
  wallet: CashuWallet,
  proof: Proof,
): void {
  if (isBlsKeyset(proof.id)) {
    throw new Error("targeted asset recovery BLS keyset is unsupported");
  }
  const keyset = wallet.getKeyset(proof.id);
  if (keyset.unit !== asset.unit || !keyset.verify()) {
    throw new Error("targeted asset recovery mint keyset is invalid");
  }
  if (asset.assetIdentity === "cashu:ordinary") {
    if (keyset.conditional !== undefined)
      throw new Error("targeted asset recovery mint asset is foreign");
    return;
  }
  const [, conditionId, outcomeCollectionId] = asset.assetIdentity.split(":");
  if (
    keyset.conditional?.conditionId !== conditionId ||
    keyset.conditional.outcomeCollectionId !== outcomeCollectionId
  ) {
    throw new Error("targeted asset recovery mint asset is foreign");
  }
}

function requireMintAuthority(
  input: BrowserTargetedAssetRecoveryInput,
  wallet: CashuWallet,
  requests: readonly TargetedAssetRecoveryMintRequest[],
): void {
  if (normalizeUrl(wallet.mint.mintUrl) !== normalizeUrl(input.asset.mintUrl)) {
    throw new Error("targeted asset recovery mint is foreign");
  }
  for (const keysetId of new Set(requests.map(({ keysetId }) => keysetId))) {
    if (isBlsKeyset(keysetId)) {
      throw new Error("targeted asset recovery BLS keyset is unsupported");
    }
    const keyset = wallet.getKeyset(keysetId);
    if (!keyset.hasKeys || keyset.unit !== input.asset.unit || !keyset.verify()) {
      throw new Error("targeted asset recovery mint keyset is invalid");
    }
  }
}

function targetedRecoveryLock(
  scopeId: string,
  assetLocator: string,
  lockManager: BrowserTargetedAssetRecoveryInput["lockManager"],
  action: () => Promise<TargetedAssetRecoveryOutcome>,
): Promise<TargetedAssetRecoveryOutcome> {
  const manager = lockManager ?? globalThis.navigator?.locks;
  if (!manager) throw new Error("this browser cannot safely lock targeted recovery");
  return manager.request(
    `bitcaster:targeted-asset-recovery:${scopeId}:${assetLocator}`,
    { mode: "exclusive" },
    () => action(),
  ) as unknown as Promise<TargetedAssetRecoveryOutcome>;
}

function canonicalRecoveryHint(value: ReturnType<typeof decodeAssetMonitoringRecoveryHint>) {
  return {
    keysetIds: [...value.keysetIds].sort(),
    counterIntervals: [...value.counterIntervals].sort(
      (left, right) => left.start - right.start || left.count - right.count,
    ),
  };
}

function requiredUnit(value: string): "sat" | "msat" {
  if (value !== "sat" && value !== "msat")
    throw new Error("targeted asset recovery unit is invalid");
  return value;
}

function requireAmount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("targeted asset recovery amount is invalid");
  }
  return value as number;
}

function requireCurrent(input: BrowserTargetedAssetRecoveryInput): void {
  if (!input.isCurrentProfile() || input.signal.aborted) {
    throw new Error("targeted asset recovery profile is stale");
  }
}
