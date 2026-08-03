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
import { locateSeedDerivedProofLineage } from "@bitcaster/client-sdk/durableSeedDerivedProofLineage";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import { withWalletProfileLock } from "./walletProfileLock";
import { commitBrowserCustodyProofImport } from "../stores/browser-custody-proof-import";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
  type BrowserCustodyProofAsset,
} from "../stores/durable-custody-db";
import { db, type BitcasterDB, type StoredProof } from "../stores/proof-db";

const SCOPE_LEASE_MS = 10 * 60 * 1_000;
const DERIVATION_COUNTER_MAX = 2_147_483_647;
type BrowserProofLocatorMap = ReadonlyMap<
  string,
  { readonly keysetId: string; readonly counter: number }
> | null;

export interface AdmitBrowserReceivedProofsInput {
  readonly seed: Uint8Array;
  readonly sourceOperationId: string;
  readonly mintUrl: string;
  readonly unit: "sat" | "msat";
  readonly wallet: CashuWallet;
  readonly proofs: readonly StoredProof[];
  /** Complete deterministic range. Defaults to the admitted proofs. */
  readonly derivationRangeProofs?: readonly Pick<StoredProof, "id" | "secret">[];
  readonly derivationAuthority: {
    readonly keysetId: string;
    readonly counterStart: number;
    readonly counterCount: number;
  } | null;
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
  const derivationLocators = deriveProofLocators(input);
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
            derivationLocators,
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
  readonly keysets: ReadonlyMap<
    string,
    DurableCustodyProofImportKeyset & { readonly asset: BrowserCustodyProofAsset }
  >;
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly proofSetFingerprint: string;
  readonly receivedAtMs: number;
  readonly derivationLocators: BrowserProofLocatorMap;
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
  const staged = page.map((proof) => ({
    proof: createBrowserCustodyProofRow({
      scopeId: scope.scopeId,
      normalizedMint: input.mintUrl,
      unit: input.unit,
      proof,
      asset: proofAsset(proof, pageInput.keysets),
      receivedAtMs: pageInput.receivedAtMs,
    }),
    expectedRevision: null,
    derivationLocator:
      pageInput.derivationLocators === null
        ? null
        : requiredDerivationLocator(pageInput.derivationLocators, proof.secret),
  }));
  const prepared = prepareDurableCustodyProofImport({
    scope,
    sourceOperationId,
    normalizedMint: input.mintUrl,
    unit: input.unit,
    inventoryAccountId: null,
    keysets: pageKeysetFacts(pageKeysetIds, pageInput.keysets),
    proofs: page,
    inventoryAuthorityFingerprint: deriveDurableCustodyArtifactFingerprint({
      schemaVersion: 1,
      proofs: staged.map(({ proof }) => ({
        proofId: proof.proofId,
        proofFingerprint: proof.proofFingerprint,
        assetKind: proof.assetKind,
        conditionId: proof.conditionId,
        outcomeCollection: proof.outcomeCollection,
        baseAsset: proof.baseAsset,
      })),
    }),
    ...(pageInput.pageCount === 1 ? {} : { batchAuthority: batchAuthority(pageInput) }),
  });
  return commitBrowserCustodyProofImport({
    scope,
    owner: pageInput.owner,
    prepared,
    proofs: staged,
    database: pageInput.database,
  });
}

function deriveProofLocators(input: AdmitBrowserReceivedProofsInput): BrowserProofLocatorMap {
  if (input.derivationAuthority === null) return null;
  const { keysetId, counterStart, counterCount } = input.derivationAuthority;
  const rangeProofs = input.derivationRangeProofs ?? input.proofs;
  if (
    typeof keysetId !== "string" ||
    keysetId.length === 0 ||
    keysetId.length > 128 ||
    !Number.isSafeInteger(counterStart) ||
    counterStart < 0 ||
    !Number.isSafeInteger(counterCount) ||
    counterCount < 1 ||
    counterStart + counterCount - 1 > DERIVATION_COUNTER_MAX ||
    counterCount !== rangeProofs.length ||
    rangeProofs.some((proof) => proof.id !== keysetId) ||
    input.proofs.some((proof) => proof.id !== keysetId)
  ) {
    throw new Error("Browser proof derivation keyset is invalid");
  }
  if (/^(?:01|02)[0-9a-f]{64}$/.test(keysetId)) {
    const locators = locateSeedDerivedProofLineage({
      seed: input.seed,
      keysetId,
      counterStart,
      counterCount,
      proofs: rangeProofs,
    });
    const locatorsBySecret = new Map(locators.map(({ secret, ...locator }) => [secret, locator]));
    if (input.proofs.some((proof) => !locatorsBySecret.has(proof.secret))) {
      throw new Error("Browser proof derivation locator is missing");
    }
    return locatorsBySecret;
  }
  if (keysetId.startsWith("01") || keysetId.startsWith("02")) {
    throw new Error("Browser proof derivation keyset is invalid");
  }
  return null;
}

function requiredDerivationLocator(
  locators: ReadonlyMap<string, { readonly keysetId: string; readonly counter: number }>,
  secret: string,
): { readonly keysetId: string; readonly counter: number } {
  const locator = locators.get(secret);
  if (!locator) throw new Error("Browser proof derivation locator is missing");
  return locator;
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
): ReadonlyMap<
  string,
  DurableCustodyProofImportKeyset & { readonly asset: BrowserCustodyProofAsset }
> {
  const authorities = new Map<
    string,
    DurableCustodyProofImportKeyset & { readonly asset: BrowserCustodyProofAsset }
  >();
  for (const keysetId of new Set(proofs.map((proof) => proof.id))) {
    const keyset = wallet.getKeyset(keysetId);
    if (keyset.unit !== unit || !keyset.verify()) {
      throw new Error("Browser proof import keyset is not verified");
    }
    const expiry = keyset.expiry;
    const keysetExpiryMs = expiry === undefined ? null : expiry * 1_000;
    if (keysetExpiryMs !== null && !Number.isSafeInteger(keysetExpiryMs)) {
      throw new Error("Browser proof import keyset expiry is invalid");
    }
    authorities.set(keysetId, {
      keysetId,
      unit,
      curve: isBlsKeyset(keysetId) ? "bls12-381" : "secp256k1",
      publicKeys: Object.fromEntries(Object.entries(keyset.keys)),
      keysetExpiryMs,
      requireDleq: false,
      asset: verifiedKeysetAsset(keyset.conditional),
    });
  }
  return authorities;
}

function proofAsset(
  proof: StoredProof,
  keysets: ReadonlyMap<
    string,
    DurableCustodyProofImportKeyset & { readonly asset: BrowserCustodyProofAsset }
  >,
): BrowserCustodyProofAsset {
  const keyset = keysets.get(proof.id);
  if (!keyset) throw new Error("Browser proof import keyset authority is missing");
  const suppliedCondition = proof.conditionId ?? (proof as { condition_id?: unknown }).condition_id;
  const suppliedOutcome =
    proof.outcomeCollection ?? (proof as { outcome_collection?: unknown }).outcome_collection;
  if ((suppliedCondition === undefined) !== (suppliedOutcome === undefined)) {
    throw new Error("Browser conditional proof metadata is incomplete");
  }
  if (keyset.asset.kind === "regular") {
    if (suppliedCondition !== undefined)
      throw new Error("Browser proof metadata conflicts with keyset");
    return keyset.asset;
  }
  if (suppliedCondition === undefined) return keyset.asset;
  if (
    normalizeConditionId(suppliedCondition) !== keyset.asset.conditionId ||
    suppliedOutcome !== keyset.asset.outcomeCollection
  ) {
    throw new Error("Browser proof metadata conflicts with keyset");
  }
  return keyset.asset;
}

function pageKeysetFacts(
  keysetIds: ReadonlySet<string>,
  keysets: ReadonlyMap<
    string,
    DurableCustodyProofImportKeyset & { readonly asset: BrowserCustodyProofAsset }
  >,
): DurableCustodyProofImportKeyset[] {
  return [...keysetIds].map((keysetId) => {
    const authority = keysets.get(keysetId);
    if (!authority) throw new Error("Browser proof import keyset authority is missing");
    const { asset: _, ...facts } = authority;
    return facts;
  });
}

function verifiedKeysetAsset(
  conditional: { conditionId: string; outcomeCollection: string } | undefined,
): BrowserCustodyProofAsset {
  if (!conditional) return { kind: "regular" };
  return {
    kind: "conditional",
    conditionId: normalizeConditionId(conditional.conditionId),
    outcomeCollection: requiredOutcomeCollection(conditional.outcomeCollection),
  };
}

function normalizeConditionId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value))
    throw new Error("Browser condition id is invalid");
  return value.toLowerCase();
}

function requiredOutcomeCollection(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    throw new Error("Browser outcome collection is invalid");
  return value;
}

function ownerAt(
  owner: DurableCustodyOwnerAuthorization,
  observedAtMs: number,
): DurableCustodyOwnerAuthorization {
  return { ...owner, observedAtMs };
}
