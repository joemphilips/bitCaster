// @vitest-environment node
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2KeyHandle,
  prepareEncryptedWalletBackupV2ProofSetBundle,
} from "@bitcaster/client-sdk";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { EncryptedWalletBackupOwnerClient } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerClient";
import { encryptedWalletBackupOwnerServerRoute } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerDelegatedServerCodec";
import {
  collectEncryptedWalletBackupOwnerDescriptorPages,
  createEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import { encodeEncryptedWalletBackupOwnerHttpResponse } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHttpCodec";
import { digestEncryptedWalletBackupOwnerBundleSupersessionReceipt } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import {
  decodeEncryptedWalletBackupOwnerRequestProof,
  encryptedWalletBackupOwnerRequestDigest,
  verifyEncryptedWalletBackupOwnerRequest,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerRequestProof";
import {
  encodeEncryptedWalletBackupOwnerCurrentInventory,
  encodeEncryptedWalletBackupOwnerDescriptorPage,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerServiceCodec";
import { encodeEncryptedWalletBackupV2BundleObjectWire } from "@bitcaster/client-sdk/encryptedWalletBackupV2Bundle";
import { digestEncryptedWalletBackupV2BundleDescriptor } from "@bitcaster/client-sdk/encryptedWalletBackupV2Descriptor";
import {
  Amount,
  Keyset,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type Wallet,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { expect, vi } from "vitest";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../../stores/encrypted-wallet-backup-owner-db";
import { BitcasterDB } from "../../stores/proof-db";
import { retryBrowserEncryptedWalletBackupV2QuotaWrite } from "../browserEncryptedWalletBackupV2QuotaCleanup";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { ownerReachabilitySnapshot } from "./ownerReachabilityFixture";
import { ownerTargetedRangeFixture } from "./ownerTargetedRangeFixture";

const databases: BitcasterDB[] = [];
export async function disposeOwnerTargetedRecoveryFixtures() {
  for (const db of databases.splice(0)) {
    db.close();
    await Dexie.delete(db.name);
  }
}
export const publicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
export const privateKey = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0));
export const keysetId = deriveKeysetId({ "1": publicKey }, { unit: "msat", versionByte: 1 });
export const now = 1_800_000_000;
export const locks = {
  request: async (_name: string, _options: unknown, action: (lock: unknown) => unknown) =>
    action({}),
} as Pick<LockManager, "request">;

export async function ownerTargetedRecoveryFixture(
  range?: Awaited<ReturnType<typeof ownerTargetedRangeFixture>>,
) {
  const seed = range?.seed ?? webcrypto.getRandomValues(new Uint8Array(64));
  const runtime = {
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
    getRandomValues: (bytes: Uint8Array) => (
      bytes.set(webcrypto.getRandomValues(new Uint8Array(bytes.length))),
      bytes
    ),
  };
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: "backup.example",
    runtime,
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: deriveDurableCustodyWalletId(seed),
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  await database.open();
  const owner = {
    ownerScopeId: "ab".repeat(32),
    authorizationScheme: "test",
    ownerSubject: "owner",
    enrollmentEpoch: 1,
  };
  const ownerContext = {
    ownerScopeId: owner.ownerScopeId,
    enrollmentEpoch: owner.enrollmentEpoch,
    realm: keyHandle.realm,
    walletId: keyHandle.walletId,
  };
  const controller = new AbortController();
  let current = true;
  const isCurrentProfile = () => current && !controller.signal.aborted;
  const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database,
    scopeId,
    ...ownerContext,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    isCurrent: isCurrentProfile,
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "msat",
    asset: range?.asset ?? { kind: "ordinary" },
  });
  const output = OutputData.createSingleDeterministicData(1, seed, 0, keysetId);
  const point = pointFromHex(output.blindedMessage.B_);
  const signature = createBlindSignature(point, privateKey, keysetId);
  const dleq = createDLEQProof(point, privateKey);
  const proof =
    range?.proof ??
    output.toProof(
      {
        id: keysetId,
        amount: Amount.from(1),
        C_: signature.C_.toHex(true),
        dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
      },
      { id: keysetId, keys: { "1": publicKey } },
    );
  const locator = range?.locator ?? {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId,
    counter: 0,
  };
  const bundle = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed,
    asset,
    custodyRevision: 1n,
    counterHighWaterMarks: [
      {
        mintUrl: asset.mintUrl,
        unit: "msat",
        keysetId: proof.id,
        nextCounter: range?.nextCounter ?? 1,
      },
    ],
    proofs: [
      {
        mintUrl: asset.mintUrl,
        unit: "msat",
        asset: range?.asset ?? { kind: "ordinary" },
        locator,
        proof,
      },
    ],
    runtime,
  });
  const descriptor = bundle.descriptor;
  const local = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: asset.mintUrl,
    unit: "msat",
    proof,
    asset:
      range === undefined
        ? { kind: "regular" }
        : {
            kind: "conditional",
            conditionId: range.asset.conditionId,
            outcomeCollection: range.asset.outcomeLabel,
          },
    receivedAtMs: 1,
  });
  if (range !== undefined)
    await database.custodyConditionalKeysets.put({
      scopeId,
      schemaVersion: 1,
      normalizedMint: asset.mintUrl,
      unit: "msat",
      keysetId: proof.id,
      denominationPublicKeys: range.keys,
      inputFeePpk: range.inputFeePpk,
      conditionId: range.asset.conditionId,
      outcomeCollection: range.asset.outcomeLabel,
      outcomeCollectionId: range.asset.outcomeCollectionId,
      registeredAtUnixSeconds: range.asset.registeredAt,
      finalExpiryUnixSeconds: range.asset.finalExpiry,
      curve: "secp256k1",
    });
  await database.custodyProofs.put(local);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(local, 1, locator, "targeted-fixture"),
  );
  await database.proofs.put({
    ...proof,
    amount: Number(proof.amount.toString()),
    mintUrl: asset.mintUrl,
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 1,
    ...(range === undefined
      ? {}
      : {
          terminalCtfContext: {
            conditionId: range.asset.conditionId,
            outcomeLabel: range.asset.outcomeLabel,
            outcomeCollectionId: range.asset.outcomeCollectionId,
            registeredAt: range.asset.registeredAt,
            finalExpiry: range.asset.finalExpiry,
          },
        }),
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);
  const empty = createEncryptedWalletBackupOwnerCurrentHead({
    ...ownerContext,
    headVersion: 0,
    bundles: [],
  });
  await store.acceptCurrentHead({
    expectedHeadVersion: null,
    evidence: collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: empty, bundles: [] }),
      ownerContext,
    ),
  });
  const receipt = await ownerReachabilitySnapshot({
    ownerScopeId: owner.ownerScopeId,
    enrollmentEpoch: 1,
    descriptor,
    keyHandle,
  });
  await store.acceptCurrentHead({
    expectedHeadVersion: 0,
    evidence: receipt.collectedHeadEvidence,
  });
  await database.encryptedWalletBackupOwnerAssetReceipts.put({
    scopeId,
    ...ownerContext,
    localAssetKey: desired.localAssetKey,
    assetLocator: descriptor.assetLocator,
    custodyRevision: "1",
    bundleId: descriptor.bundleId,
    bundleDescriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(descriptor),
    canonicalSignedMutation: receipt.canonicalSignedMutation,
    canonicalSignedReceipt: receipt.canonicalSignedReceipt,
  });
  await database.encryptedWalletBackupOwnerDesiredAssets.put({
    scopeId,
    ...ownerContext,
    localAssetKey: desired.localAssetKey,
    assetLocator: descriptor.assetLocator,
    custodyRevision: "1",
    desiredAction: "replace",
    activeProofCount: 1,
    syncState: "acknowledged",
    lastObservedHeadVersion: 1,
    receiptDigest: digestEncryptedWalletBackupOwnerBundleSupersessionReceipt(receipt.receipt),
  });
  let writes = 0;
  await retryBrowserEncryptedWalletBackupV2QuotaWrite({
    database,
    scopeId,
    ownerScopeId: owner.ownerScopeId,
    ownerAuthorityStore: store,
    isCurrentProfile,
    lockManager: locks,
    loadCurrentOwnerReachabilityEvidence: async () => ({
      ...receipt,
      backupReceiptSnapshot: (await store.captureBackupReceiptForLocalAsset(
        desired.localAssetKey,
      ))!,
    }),
    write: async () => {
      if (++writes === 1) throw new DOMException("owned quota fault", "QuotaExceededError");
      return true;
    },
  });
  expect(await database.custodyProofs.count()).toBe(0);
  const calls: string[] = [];
  let fault: "none" | "unavailable" | "foreign-owner" | "head-change" | "abort" = "none";
  const head = receipt.collectedHeadEvidence.head;
  const inventory = {
    ...ownerContext,
    headVersion: head.headVersion,
    activeSetDigest: head.activeSetDigest,
    entries: [
      {
        assetLocator: descriptor.assetLocator,
        bundleId: descriptor.bundleId,
        descriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(descriptor),
        declaredAmount: descriptor.declaredAmount,
        custodyRevision: descriptor.custodyRevision,
      },
    ],
  };
  const client = new EncryptedWalletBackupOwnerClient({
    origin: "https://backup.example",
    keyHandle,
    pinnedReceiptKeys: [receipt.pinnedSigningKey],
    nowUnixSeconds: () => now,
    fetch: async (resource, init) => {
      const url = String(resource);
      const path = new URL(url).pathname;
      expect(path).toContain(`/owners/${owner.ownerScopeId}/`);
      const operation = path.endsWith("/current-inventory")
        ? "current-inventory"
        : path.endsWith("/head")
          ? "descriptor-page"
          : "object-get";
      calls.push(operation);
      if (fault === "unavailable") throw new TypeError("owned network fault");
      const route = encryptedWalletBackupOwnerServerRoute({
        operation,
        ...ownerContext,
        ...(operation === "descriptor-page"
          ? { afterBundleId: null }
          : operation === "object-get"
            ? { objectId: path.split("/").at(-1)! }
            : {}),
      } as Parameters<typeof encryptedWalletBackupOwnerServerRoute>[0]);
      const bytes = Uint8Array.from(
        Buffer.from(
          new Headers(init?.headers).get("authorization")!.slice("BackupV1 ".length),
          "base64url",
        ),
      );
      verifyEncryptedWalletBackupOwnerRequest({
        canonicalProof: bytes,
        route: route.context,
        expectedMethod: route.method,
        expectedUrl: url,
        payload: new Uint8Array(),
        serverNowUnixSeconds: now,
      });
      const proof = decodeEncryptedWalletBackupOwnerRequestProof(bytes);
      const body =
        operation === "current-inventory"
          ? encodeEncryptedWalletBackupOwnerCurrentInventory(inventory)
          : operation === "descriptor-page"
            ? encodeEncryptedWalletBackupOwnerDescriptorPage(
                enumerateEncryptedWalletBackupOwnerDescriptorPages({
                  head: fault === "head-change" ? { ...head, headVersion: 2 } : head,
                  bundles: [descriptor],
                })[0]!,
              )
            : encodeEncryptedWalletBackupV2BundleObjectWire(
                bundle.objects.find((o) => o.objectId === path.split("/").at(-1))!,
                descriptor,
              );
      const wire = encodeEncryptedWalletBackupOwnerHttpResponse({
        kind: operation === "object-get" ? "object" : operation,
        requestDigest: encryptedWalletBackupOwnerRequestDigest(proof),
        ...ownerContext,
        ...(fault === "foreign-owner" ? { ownerScopeId: "cd".repeat(32) } : {}),
        body,
      });
      if (fault === "abort") {
        current = false;
        controller.abort();
      }
      const response = new Response(wire as BodyInit, {
        status: 200,
        headers: { "content-type": "application/cbor", "cache-control": "no-store" },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    },
  });
  const keyset = new Keyset(
    proof.id,
    "msat",
    true,
    range?.inputFeePpk ?? 0,
    range?.asset.finalExpiry ?? 0,
    range === undefined
      ? undefined
      : {
          conditionId: range.asset.conditionId,
          outcomeCollection: range.asset.outcomeLabel,
          outcomeCollectionId: range.asset.outcomeCollectionId,
          registeredAt: range.asset.registeredAt,
        },
  );
  keyset.keys = range?.keys ?? { "1": publicKey };
  const wallet = {
    mint: { mintUrl: asset.mintUrl },
    getKeyset: () => keyset,
    keyChain: {
      loadConditionalKeyset: async (id: string) => {
        if (id !== proof.id) throw new Error("foreign conditional keyset");
        return keyset;
      },
    },
    checkProofsStates: async (proofs: readonly { secret: string }[]) =>
      proofs.map(({ secret }) => ({
        Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
        state: "UNSPENT",
        witness: null,
      })),
    restore: vi.fn(),
  } as unknown as Wallet;
  const input = {
    database,
    scopeId,
    seed,
    keyHandle,
    enrollmentEpoch: 1,
    owner,
    ownerContext,
    ownerClient: client,
    ownerStore: store,
    asset,
    requiredAmount: 1n,
    loadWallet: async () => wallet,
    readExactMonitoringRecovery: vi.fn(async () => null),
    runtime,
    signal: controller.signal,
    isCurrentProfile,
    lockManager: locks,
    completedAtUnixMilliseconds: () => now * 1000,
  };
  return {
    input,
    database,
    calls,
    local,
    proof,
    store,
    inventory,
    wallet,
    client,
    runtime,
    receipt,
    setFault: (value: typeof fault) => {
      fault = value;
    },
  };
}
