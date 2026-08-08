import { isBlsKeyset, type Proof, type Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyArtifactFingerprint,
  decodeCanonicalMintOrigin,
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
import {
  decodeDurableWalletProofDerivationLocator,
  type DurableWalletProofDerivationLocator,
} from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import { withWalletProfileLock } from "./walletProfileLock";
import { commitBrowserCustodyProofImport } from "../stores/browser-custody-proof-import";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
  type BrowserCustodyProofAsset,
} from "../stores/durable-custody-db";
import type { BrowserCustodyConditionalKeysetAuthority } from "../stores/durable-custody-types";
import { db, type BitcasterDB, type StoredProof } from "../stores/proof-db";

const SCOPE_LEASE_MS = 10 * 60 * 1_000;
type BrowserProofLocatorMap = ReadonlyMap<string, DurableWalletProofDerivationLocator> | null;

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
  /** Exact SDK-restored locators. This is mutually exclusive with a derived range. */
  readonly proofLocators?: ReadonlyMap<string, DurableWalletProofDerivationLocator>;
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
  const keysets = resolveImportKeysets(
    input.wallet,
    input.proofs,
    input.unit,
    decodeCanonicalMintOrigin(input.mintUrl),
  );
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
      let importFailure: unknown;
      try {
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
          const observedAtMs = now();
          await commitImportPage({
            input,
            database,
            scope,
            owner: ownerAt(owner, observedAtMs),
            keysets,
            pageIndex,
            pageCount,
            proofSetFingerprint,
            derivationLocators,
            receivedAtMs: observedAtMs,
          });
        }
      } catch (error) {
        importFailure = error;
        throw error;
      } finally {
        try {
          await adapter.releaseScope(scope, ownerAt(owner, now()));
        } catch (releaseError) {
          if (importFailure === undefined) throw releaseError;
        }
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
    DurableCustodyProofImportKeyset & {
      readonly asset: BrowserCustodyProofAsset;
      readonly conditionalKeyset: BrowserCustodyConditionalKeysetAuthority | undefined;
    }
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
    conditionalKeyset: pageInput.keysets.get(proof.id)?.conditionalKeyset,
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
  if (input.proofLocators !== undefined && input.derivationAuthority !== null) {
    throw new Error("Browser proof locator authorities conflict");
  }
  if (input.proofLocators !== undefined) {
    if (input.proofLocators.size !== input.proofs.length) {
      throw new Error("Browser proof derivation locator is incomplete");
    }
    const proofSecrets = new Set(input.proofs.map(({ secret }) => secret));
    for (const [secret, locator] of input.proofLocators) {
      if (!proofSecrets.has(secret)) throw new Error("Browser proof derivation locator is foreign");
      decodeDurableWalletProofDerivationLocator(locator);
    }
    return input.proofLocators;
  }
  if (input.derivationAuthority === null) return null;
  const { keysetId, counterStart, counterCount } = input.derivationAuthority;
  const rangeProofs = input.derivationRangeProofs ?? input.proofs;
  if (
    counterCount !== rangeProofs.length ||
    rangeProofs.some((proof) => proof.id !== keysetId) ||
    input.proofs.some((proof) => proof.id !== keysetId)
  ) {
    throw new Error("Browser proof derivation keyset is invalid");
  }
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

function requiredDerivationLocator(
  locators: ReadonlyMap<string, DurableWalletProofDerivationLocator>,
  secret: string,
): DurableWalletProofDerivationLocator {
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
  inputMint: string,
): ReadonlyMap<
  string,
  DurableCustodyProofImportKeyset & {
    readonly asset: BrowserCustodyProofAsset;
    readonly conditionalKeyset: BrowserCustodyConditionalKeysetAuthority | undefined;
  }
> {
  const authorities = new Map<
    string,
    DurableCustodyProofImportKeyset & {
      readonly asset: BrowserCustodyProofAsset;
      readonly conditionalKeyset: BrowserCustodyConditionalKeysetAuthority | undefined;
    }
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
      conditionalKeyset: conditionalKeysetAuthority(keyset, unit, inputMint),
    });
  }
  return authorities;
}

function proofAsset(
  proof: StoredProof,
  keysets: ReadonlyMap<
    string,
    DurableCustodyProofImportKeyset & {
      readonly asset: BrowserCustodyProofAsset;
      readonly conditionalKeyset: BrowserCustodyConditionalKeysetAuthority | undefined;
    }
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
    DurableCustodyProofImportKeyset & {
      readonly asset: BrowserCustodyProofAsset;
      readonly conditionalKeyset: BrowserCustodyConditionalKeysetAuthority | undefined;
    }
  >,
): DurableCustodyProofImportKeyset[] {
  return [...keysetIds].map((keysetId) => {
    const authority = keysets.get(keysetId);
    if (!authority) throw new Error("Browser proof import keyset authority is missing");
    const { asset: _, conditionalKeyset: __, ...facts } = authority;
    return facts;
  });
}

function conditionalKeysetAuthority(
  keyset: ReturnType<CashuWallet["getKeyset"]>,
  unit: "sat" | "msat",
  normalizedMint: string,
): BrowserCustodyConditionalKeysetAuthority | undefined {
  const conditional = keyset.conditional;
  if (!conditional) return undefined;
  if (conditional.registeredAt === undefined || keyset.id.startsWith("02")) {
    throw new Error("Browser conditional keyset authority is incomplete");
  }
  return {
    schemaVersion: 1,
    normalizedMint,
    unit,
    keysetId: keyset.id,
    denominationPublicKeys: Object.fromEntries(Object.entries(keyset.keys)),
    inputFeePpk: keyset.fee,
    conditionId: conditional.conditionId,
    outcomeCollection: conditional.outcomeCollection,
    outcomeCollectionId: conditional.outcomeCollectionId,
    registeredAtUnixSeconds: conditional.registeredAt,
    finalExpiryUnixSeconds: keyset.expiry === undefined ? null : keyset.expiry,
    curve: "secp256k1",
  };
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
