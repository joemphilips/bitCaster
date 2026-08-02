import { isBlsKeyset, type Proof, type Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyArtifactFingerprint,
  type DurableCustodyOwnerAuthorization,
} from "@bitcaster/client-sdk/durableCustody";
import {
  DURABLE_CUSTODY_PROOF_IMPORT_BATCH_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
  prepareDurableCustodyProofImport,
  type DurableCustodyProofImportKeyset,
} from "@bitcaster/client-sdk/durableCustodyProofImport";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import { withWalletProfileLock } from "./walletProfileLock";
import { commitBrowserCustodyProofImport } from "../stores/browser-custody-proof-import";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
  type BrowserCustodyProofAsset,
} from "../stores/durable-custody-db";
import { db, isCtfProof, type BitcasterDB, type StoredProof } from "../stores/proof-db";

const SCOPE_LEASE_MS = 10 * 60 * 1_000;

export interface AdmitBrowserReceivedProofsInput {
  readonly seed: Uint8Array;
  readonly sourceOperationId: string;
  readonly mintUrl: string;
  readonly unit: "sat" | "msat";
  readonly wallet: CashuWallet;
  readonly proofs: readonly StoredProof[];
  readonly database?: BitcasterDB;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

/** Admit one verified mint result into the canonical browser proof store. */
export async function admitBrowserReceivedProofs(
  input: AdmitBrowserReceivedProofsInput,
): Promise<void> {
  if (
    input.proofs.length === 0 ||
    input.proofs.length > DURABLE_CUSTODY_PROOF_IMPORT_BATCH_PROOF_LIMIT_MAX
  ) {
    throw new Error("Browser proof import count is invalid");
  }
  const database = input.database ?? db;
  const now = input.now ?? Date.now;
  const randomId = input.randomId ?? (() => crypto.randomUUID());
  const scope = browserWalletScope(input.seed);
  const keysets = resolveImportKeysets(input.wallet, input.proofs, input.unit);
  const proofSetFingerprint = deriveDurableCustodyArtifactFingerprint(
    input.proofs.map(serializeDurableCustodyProofArtifact),
  );
  const pageCount = Math.ceil(
    input.proofs.length / DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
  );

  await withWalletProfileLock(
    scope.scopeId,
    async () => {
      const adapter = new BrowserDurableCustodyAdapter(database);
      const claimedAtMs = now();
      const owner = await adapter.claimScope(scope, {
        incarnationId: `browser-receive:${randomId()}`,
        observedAtMs: claimedAtMs,
        leaseExpiresAtMs: claimedAtMs + SCOPE_LEASE_MS,
      });
      try {
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
          await commitImportPage({
            input,
            database,
            scope,
            owner: ownerAt(owner, now()),
            keysets,
            pageIndex,
            pageCount,
            proofSetFingerprint,
            receivedAtMs: now(),
          });
        }
      } finally {
        await adapter.releaseScope(scope, ownerAt(owner, now()));
      }
    },
    input.lockManager,
  );
}

interface CommitImportPageInput {
  readonly input: AdmitBrowserReceivedProofsInput;
  readonly database: BitcasterDB;
  readonly scope: ReturnType<typeof browserWalletScope>;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly keysets: readonly DurableCustodyProofImportKeyset[];
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly proofSetFingerprint: string;
  readonly receivedAtMs: number;
}

function commitImportPage(pageInput: CommitImportPageInput): Promise<void> {
  const { input, scope } = pageInput;
  const page = input.proofs.slice(
    pageInput.pageIndex * DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
    (pageInput.pageIndex + 1) * DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX,
  );
  const sourceOperationId =
    pageInput.pageIndex === 0
      ? input.sourceOperationId
      : `${input.sourceOperationId}:page:${pageInput.pageIndex}`;
  const pageKeysetIds = new Set(page.map((proof) => proof.id));
  const prepared = prepareDurableCustodyProofImport({
    scope,
    sourceOperationId,
    normalizedMint: input.mintUrl,
    unit: input.unit,
    inventoryAccountId: null,
    keysets: pageInput.keysets.filter((keyset) => pageKeysetIds.has(keyset.keysetId)),
    proofs: page,
    ...(pageInput.pageCount === 1 ? {} : { batchAuthority: batchAuthority(pageInput) }),
  });
  return commitBrowserCustodyProofImport({
    scope,
    owner: pageInput.owner,
    prepared,
    proofs: page.map((proof) =>
      createBrowserCustodyProofRow({
        scopeId: scope.scopeId,
        normalizedMint: input.mintUrl,
        unit: input.unit,
        proof,
        asset: proofAsset(proof),
        receivedAtMs: pageInput.receivedAtMs,
      }),
    ),
    database: pageInput.database,
  });
}

function batchAuthority(input: CommitImportPageInput) {
  return {
    rootSourceOperationId: input.input.sourceOperationId,
    proofSetFingerprint: input.proofSetFingerprint,
    proofCount: input.input.proofs.length,
    pageCount: input.pageCount,
    pageIndex: input.pageIndex,
  };
}

function resolveImportKeysets(
  wallet: CashuWallet,
  proofs: readonly Proof[],
  unit: "sat" | "msat",
): DurableCustodyProofImportKeyset[] {
  return [...new Set(proofs.map((proof) => proof.id))].map((keysetId) => {
    const keyset = wallet.getKeyset(keysetId);
    if (keyset.unit !== unit || !keyset.verify()) {
      throw new Error("Browser proof import keyset is not verified");
    }
    const expiry = keyset.expiry;
    const keysetExpiryMs = expiry === undefined ? null : expiry * 1_000;
    if (keysetExpiryMs !== null && !Number.isSafeInteger(keysetExpiryMs)) {
      throw new Error("Browser proof import keyset expiry is invalid");
    }
    return {
      keysetId,
      unit,
      curve: isBlsKeyset(keysetId) ? "bls12-381" : "secp256k1",
      publicKeys: Object.fromEntries(Object.entries(keyset.keys)),
      keysetExpiryMs,
      requireDleq: false,
    };
  });
}

function proofAsset(proof: StoredProof): BrowserCustodyProofAsset {
  if (!isCtfProof(proof)) return { kind: "regular" };
  if (!proof.conditionId || !proof.outcomeCollection) {
    throw new Error("Browser conditional proof metadata is incomplete");
  }
  return {
    kind: "conditional",
    conditionId: proof.conditionId,
    outcomeCollection: proof.outcomeCollection,
  };
}

function ownerAt(
  owner: DurableCustodyOwnerAuthorization,
  observedAtMs: number,
): DurableCustodyOwnerAuthorization {
  return { ...owner, observedAtMs };
}
