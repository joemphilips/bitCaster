import { Amount, deriveKeysetId } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2KeyHandle,
  deriveDurableCustodyScopeId,
} from "@bitcaster/client-sdk";
import { deriveEncryptedWalletBackupOwnerScope } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerScope";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../src/stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { createBrowserProofBackupAuthorityRow } from "../../src/stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../../src/stores/durable-custody-db";
import { BitcasterDB } from "../../src/stores/proof-db";
import { captureBrowserEncryptedWalletBackupOwnerSession } from "../../src/lib/browserEncryptedWalletBackupOwnerSession";
import { browserWalletDatabaseName } from "../../src/lib/browserWalletProfile";
import { createBrowserEncryptedWalletBackupV2RuntimeDriver } from "../../src/lib/encryptedWalletBackupDriver";
import { EncryptedWalletBackupOwnerClient } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerClient";

declare global {
  interface Window {
    runOwnerCutoverPhase: (phase: "first" | "restart") => Promise<void>;
    ownerCutoverResult: string | null;
    ownerCutoverFailure: string | null;
    ownerCutoverRetryScheduled: boolean;
  }
}

const realm = "backup.example";
const signedOrigin = "https://backup.example";
const ownerSubject = "restart-harness-owner";
const seed = new Uint8Array(64).fill(7);
const publicGenerator = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

window.ownerCutoverResult = null;
window.ownerCutoverFailure = null;
window.ownerCutoverRetryScheduled = false;

window.runOwnerCutoverPhase = async (phase) => {
  const pin = new URL(location.href).searchParams.get("receiptKey");
  if (pin === null || !/^[0-9a-f]{64}$/.test(pin)) throw new Error("receipt test key is absent");
  const runtime = {
    subtle: window.crypto.subtle,
    getRandomValues<T extends ArrayBufferView>(target: T): T {
      return window.crypto.getRandomValues(target);
    },
  };
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm, runtime });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: keyHandle.walletId,
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  await database.open();
  if (phase === "first") await seedOrdinaryBackup(database, scopeId, keyHandle);
  const ownerSession = captureBrowserEncryptedWalletBackupOwnerSession({
    isCurrentProfile: () => true,
    selectedOwnerScope: null,
    readAuthenticatedOwner: () => null,
    readSignerRevision: () => 1,
    subscribeSignerRevision: () => () => undefined,
  });
  const ownerClient = new EncryptedWalletBackupOwnerClient({
    origin: signedOrigin,
    keyHandle,
    pinnedReceiptKeys: [{ keyId: "cc".repeat(16), publicKey: pin }],
    fetch: async (input, init) => {
      const url = String(input);
      if (!url.startsWith(signedOrigin)) throw new Error("owner test URL is outside signed origin");
      const response = await window.fetch(
        `${location.origin}${url.slice(signedOrigin.length)}`,
        init,
      );
      Object.defineProperty(response, "url", { value: url });
      return response;
    },
    nowUnixSeconds: () => Math.floor(Date.now() / 1_000),
  });
  let retryResolve!: () => void;
  const retryScheduled = new Promise<void>((resolve) => (retryResolve = resolve));
  const driver = createBrowserEncryptedWalletBackupV2RuntimeDriver({
    configuration: {
      realm,
      signedOrigin,
      transportOrigin: signedOrigin,
      pinnedReceiptKeys: [{ keyId: "cc".repeat(16), publicKey: pin }],
    },
    database,
    scopeId,
    seed,
    ownerSession,
    ownerClient,
    runtime,
    signal: new AbortController().signal,
    isCurrentProfile: () => true,
    leadership: { hold: async (_name, signal, becomeLeader) => !signal.aborted && becomeLeader() },
    scheduleRetry: (task, delayMilliseconds) => {
      if (phase === "first") {
        window.ownerCutoverRetryScheduled = true;
        retryResolve();
        return () => undefined;
      }
      const timer = window.setTimeout(task, delayMilliseconds);
      return () => window.clearTimeout(timer);
    },
    reportError: (error) => {
      window.ownerCutoverFailure = error instanceof Error ? error.message : "unknown driver error";
      retryResolve();
    },
  });
  driver.start();

  if (phase === "first") {
    await retryScheduled;
    if (window.ownerCutoverFailure !== null) throw new Error(window.ownerCutoverFailure);
    const prepared = await database.encryptedWalletBackupOwnerPreparedMutations.toArray();
    if (prepared.length !== 1) throw new Error("first page did not persist one prepared mutation");
    driver.stop();
    ownerSession.dispose();
    database.close();
    window.ownerCutoverResult = "prepared-after-lost-response";
    return;
  }

  await waitUntilAcknowledged(database, scopeId, ownerSubject);
  driver.stop();
  ownerSession.dispose();
  database.close();
  window.ownerCutoverResult = "replayed-and-acknowledged";
};

async function seedOrdinaryBackup(
  database: BitcasterDB,
  scopeId: string,
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
): Promise<void> {
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "msat",
    asset: { kind: "ordinary" },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  const keysetId = deriveKeysetId({ 1: publicGenerator }, { unit: "msat", versionByte: 1 });
  const derivationLocator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId,
    counter: 0,
  };
  const secret = deriveDurableWalletProofSecret({
    seed,
    locator: derivationLocator,
    proofKeysetId: keysetId,
    proofAmount: 1,
  });
  const proof = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: asset.mintUrl,
    unit: asset.unit,
    proof: { id: keysetId, amount: Amount.from(1), secret, C: publicGenerator },
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);
  await database.custodyProofs.put(proof);
  await database.proofs.put({
    id: keysetId,
    amount: 1,
    secret,
    C: publicGenerator,
    mintUrl: asset.mintUrl,
  });
  await database.custodyProofBackupAuthorities.put({
    schemaVersion: 4,
    scopeId,
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: 0,
    proofState: "selectable",
    terminalOperationId: null,
    terminalAuthority: null,
    recordCreatedAtUnixSeconds: 1,
    recordUpdatedAtUnixSeconds: 1,
    derivationLocator,
    updatedAtMs: 1,
    admissionOperationId: null,
    backupState: "remote-backed",
    backupRecordId: proof.proofId,
    backupRecordCommitment: "aa".repeat(32),
  });
  await database.walletCounterAssociations.put({
    scopeId,
    normalizedMint: asset.mintUrl,
    unit: asset.unit,
    keysetId,
    recoveryComplete: true,
  });
  await database.walletCounterCursors.put({
    scopeId,
    keysetId,
    next: 1,
  });
}

async function waitUntilAcknowledged(
  database: BitcasterDB,
  scopeId: string,
  ownerSubject: string,
): Promise<void> {
  const owner = deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: "test",
    ownerSubject,
  });
  const desired = await database.encryptedWalletBackupV2DesiredAssets.toCollection().first();
  if (desired === undefined) throw new Error("restart page desired asset is absent");
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const row = await database.encryptedWalletBackupOwnerDesiredAssets.get([
      scopeId,
      owner.ownerScopeId,
      desired.localAssetKey,
    ]);
    if (row?.syncState === "acknowledged" && row.custodyRevision === "1") return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
  }
  throw new Error("restarted driver did not acknowledge the exact desired revision");
}
