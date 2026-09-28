import { MintOperationError, type CounterSource, type MintKeys, type Proof } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyOperationId,
  type DurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
} from "@bitcaster/client-sdk/durableCustody";
import {
  buildKeysetRedeemOperationId,
  classifyPreparedDurableCtfRedeemInputs,
  executePreparedDurableCtfRedeem,
  isLosingLegError,
  prepareDurableCtfRedeemOperation,
  readPreparedDurableCtfRedeemRequest,
  restorePreparedDurableCtfRedeemOutputs,
  type AuthenticatedCtfRedeemTerminalEvidence,
  type RedeemWallet,
  type RestoreOutputGroups,
} from "@bitcaster/client-sdk/ctfRedeem";
import {
  assertDurableCustodyMintOperationAuthority,
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
  type DurableCustodyMintKeysetAuthority,
} from "@bitcaster/client-sdk/durableCustodyMintResult";
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { locateSeedDerivedProofLineage } from "@bitcaster/client-sdk/durableSeedDerivedProofLineage";
import {
  decodeDurableSeedDerivedOutputPlan,
  DurableSeedDerivedOutputReservationError,
} from "@bitcaster/client-sdk/durableSeedDerivedOutputs";
import {
  createBrowserCustodyProofRow,
  type BrowserDurableCustodyAdapter,
} from "../stores/durable-custody-db";
import { storedProofFromCustodyRow, type BitcasterDB } from "../stores/proof-db";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import type { BrowserCtfRedeemLeg } from "./browserCtfRedeemSelection";
import { requireBrowserWalletNewWritePermission } from "./browserWalletNewWritePermission";
import { withWalletProfileLock } from "./walletProfileLock";
import { normalizeUrl } from "./url";

export type BrowserCtfClaimFailureCategory =
  | "profile-ownership"
  | "counter-readiness"
  | "keyset-authority"
  | "attestation-lookup"
  | "persisted-recovery"
  | "mint-refusal"
  | "unknown-mint-result"
  | "local-commit";

const BROWSER_CTF_CLAIM_FAILURE_MESSAGES: Record<BrowserCtfClaimFailureCategory, string> = {
  "profile-ownership": "Wallet profile or selected proof ownership changed.",
  "counter-readiness": "Wallet counter recovery is incomplete for the selected keyset.",
  "keyset-authority": "The selected keyset could not be verified.",
  "attestation-lookup": "The condition attestation could not be loaded.",
  "persisted-recovery": "A saved claim operation needs recovery before it can continue.",
  "mint-refusal": "The mint refused this claim.",
  "unknown-mint-result": "The mint result is not confirmed. Recover this claim before retrying.",
  "local-commit":
    "The claim result could not be saved to wallet storage. Recover this claim before retrying.",
};

/** Safe failure metadata for the app's Claim boundary. Never carries an SDK cause. */
export class BrowserCtfClaimBoundaryError extends Error {
  readonly category: BrowserCtfClaimFailureCategory;
  readonly operationRef?: string;

  constructor(category: BrowserCtfClaimFailureCategory, operationRef?: string) {
    super(BROWSER_CTF_CLAIM_FAILURE_MESSAGES[category]);
    this.name = "BrowserCtfClaimBoundaryError";
    this.category = category;
    this.operationRef = operationRef;
  }
}

export function browserCtfClaimBoundaryError(
  error: unknown,
  fallbackCategory: BrowserCtfClaimFailureCategory,
  operationRef?: string,
): BrowserCtfClaimBoundaryError {
  if (error instanceof BrowserCtfClaimBoundaryError) {
    return error.operationRef === undefined && operationRef !== undefined
      ? new BrowserCtfClaimBoundaryError(error.category, operationRef)
      : error;
  }
  if (error instanceof DurableSeedDerivedOutputReservationError) {
    const category: BrowserCtfClaimFailureCategory =
      error.category === "stale_profile" ? "profile-ownership" : "counter-readiness";
    return new BrowserCtfClaimBoundaryError(category, operationRef);
  }
  return new BrowserCtfClaimBoundaryError(fallbackCategory, operationRef);
}

export function createBrowserCtfClaimAttemptRef(): string {
  return globalThis.crypto.randomUUID();
}

/** Existing transport timeouts stay pending; they are not evidence of refusal. */
export function isBrowserCtfClaimPendingError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:timed? ?out|timeout|network error|failed to fetch|connection reset|temporarily unavailable)/i.test(
    message,
  );
}

export type BrowserCanonicalCtfRedeemRecoveryResult =
  | { readonly kind: "redeemed"; readonly proofs: readonly Proof[] }
  | { readonly kind: "losing"; readonly evidence: AuthenticatedCtfRedeemTerminalEvidence }
  | { readonly kind: "pending" }
  | { readonly kind: "already-completed" }
  | { readonly kind: "already-losing" };

export async function recoverBrowserCanonicalCtfRedeemOperation(input: {
  readonly seed: Uint8Array;
  readonly mintUrl: string;
  readonly conditionId: string;
  readonly outcomeCollection: string;
  readonly operationId: string;
  readonly wallet: RedeemWallet;
  readonly restoreOutputs: (
    mintUrl: string,
    outputs: Parameters<RestoreOutputGroups>[1],
    regularKeyset: MintKeys,
  ) => ReturnType<RestoreOutputGroups>;
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly observedAtMs: number;
}): Promise<BrowserCanonicalCtfRedeemRecoveryResult> {
  const scope = browserWalletScope(input.seed);
  const snapshot = await input.adapter.readOperationSnapshot(scope, input.operationId);
  if (snapshot === null) throw new Error("browser CTF redeem operation is missing");
  const record = snapshot.record;
  let authority: ReturnType<typeof assertDurableCustodyMintOperationAuthority>;
  try {
    authority = assertDurableCustodyMintOperationAuthority(
      record,
      requiredArtifact(
        snapshot.artifacts,
        record.operation.privateMaterial.exactPrivateMaterial.artifactId,
      ),
    );
  } catch {
    throw new BrowserCtfClaimBoundaryError("keyset-authority", input.operationId);
  }
  const operation = authority.operation;
  const metadata = operation.metadata;
  if (
    record.operation.semanticKind !== "ctf-redeem" ||
    operation.kind !== "ctf-redeem" ||
    operation.mintUrl !== normalizeUrl(input.mintUrl) ||
    metadata?.conditionId !== input.conditionId ||
    metadata.outcomeCollection !== input.outcomeCollection
  ) {
    throw new Error("browser CTF redeem recovery asset authority is foreign");
  }
  const regularKeyset = authority.keysets.find(
    (keyset) => keyset.identity.kind === "regular" && keyset.id === metadata.regularKeysetId,
  );
  if (regularKeyset === undefined) {
    throw new BrowserCtfClaimBoundaryError("keyset-authority", input.operationId);
  }
  const keys = mintKeysFromAuthority(regularKeyset);
  try {
    readPreparedDurableCtfRedeemRequest({ operation, seed: input.seed, regularKeyset: keys });
  } catch {
    throw new BrowserCtfClaimBoundaryError("keyset-authority", input.operationId);
  }
  if (record.operation.result.state === "applied") return { kind: "already-completed" };
  if (record.operation.terminalMintRejection !== null) return { kind: "already-losing" };
  if (record.operation.result.state !== "none") {
    throw new Error("browser CTF redeem staged result requires recovery");
  }
  if (record.operation.state === "dispatch-intent") {
    await markBrowserCanonicalCtfRedeemTransportAttempted(input);
  } else if (record.operation.state === "transport-attempted") {
    const state = await classifyPreparedDurableCtfRedeemInputs({ operation, wallet: input.wallet });
    if (state === "pending") return { kind: "pending" };
    if (state === "spent") {
      const proofs = await restorePreparedDurableCtfRedeemOutputs({
        operation,
        seed: input.seed,
        regularKeyset: keys,
        restoreOutputGroups: (mintUrl, outputs) => input.restoreOutputs(mintUrl, outputs, keys),
      });
      let committed: readonly Proof[];
      try {
        committed = await commitBrowserCanonicalCtfRedeemResult({ ...input, proofs });
      } catch {
        throw new BrowserCtfClaimBoundaryError("local-commit", input.operationId);
      }
      return {
        kind: "redeemed",
        proofs: committed,
      };
    }
  } else {
    throw new Error("browser CTF redeem recovery state is invalid");
  }
  const submitted = await executePreparedDurableCtfRedeem({
    operation,
    seed: input.seed,
    regularKeyset: keys,
    wallet: walletWithClaimMintClassification(input.wallet, input.operationId),
  });
  if (submitted.kind === "losing") return submitted;
  let committed: readonly Proof[];
  try {
    committed = await commitBrowserCanonicalCtfRedeemResult({
      ...input,
      proofs: submitted.proofs,
    });
  } catch {
    throw new BrowserCtfClaimBoundaryError("local-commit", input.operationId);
  }
  return {
    kind: "redeemed",
    proofs: committed,
  };
}

function walletWithClaimMintClassification(
  wallet: RedeemWallet,
  operationRef: string,
): RedeemWallet {
  return new Proxy(wallet, {
    get(target, property) {
      if (property === "redeemOutcomeProofs") {
        return async (...args: Parameters<RedeemWallet["redeemOutcomeProofs"]>) => {
          try {
            return await target.redeemOutcomeProofs(...args);
          } catch (error) {
            if (isLosingLegError(error) || isBrowserCtfClaimPendingError(error)) throw error;
            if (error instanceof MintOperationError) {
              throw new BrowserCtfClaimBoundaryError("mint-refusal", operationRef);
            }
            throw new BrowserCtfClaimBoundaryError("unknown-mint-result", operationRef);
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function markBrowserCanonicalCtfRedeemTransportAttempted(input: {
  readonly seed: Uint8Array;
  readonly operationId: string;
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly owner: DurableCustodyOwnerAuthorization;
}): Promise<void> {
  const scope = browserWalletScope(input.seed);
  const record = await input.adapter.readOperation(scope, input.operationId);
  if (record?.operation.semanticKind !== "ctf-redeem") {
    throw new Error("browser CTF redeem operation authority is missing");
  }
  if (
    record.operation.state !== "dispatch-intent" &&
    record.operation.state !== "transport-attempted"
  ) {
    throw new Error("browser CTF redeem transport state is invalid");
  }
  await input.adapter.transact(
    {
      scope,
      owner: input.owner,
      operationRows: [{ operationId: input.operationId, expectedRevision: record.revision }],
    },
    (transaction) => {
      if (record.operation.state === "transport-attempted") return;
      transaction.transitionOperation({
        operationId: input.operationId,
        expectedRevision: record.revision,
        transition: {
          kind: "mark-transport-attempted",
          authorization: input.owner,
          expectedRevision: record.revision,
        },
      });
    },
  );
}

export interface BrowserCanonicalCtfRedeemBindingInput {
  readonly seed: Uint8Array;
  readonly mintUrl: string;
  readonly conditionId: string;
  readonly outcomeCollection: string;
  readonly oracleWitness: string;
  readonly leg: BrowserCtfRedeemLeg;
  readonly regularKeyset: MintKeys;
  readonly counterSource: CounterSource;
  readonly database: BitcasterDB;
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly lockManager?: Pick<LockManager, "request">;
}

export async function bindBrowserCanonicalCtfRedeemLeg(
  input: BrowserCanonicalCtfRedeemBindingInput,
): Promise<DurableCustodyRecord> {
  const scope = browserWalletScope(input.seed);
  const normalizedMint = normalizeUrl(input.mintUrl);
  const keyset = input.leg.keyset;
  try {
    requireRedeemLegAuthority(input, scope.scopeId, normalizedMint);
  } catch {
    throw new BrowserCtfClaimBoundaryError("keyset-authority");
  }
  const proofs = input.leg.rows.map(storedProofFromCustodyRow);
  const operationId = buildKeysetRedeemOperationId({
    mintUrl: normalizedMint,
    unit: "msat",
    conditionId: input.conditionId,
    keysetId: keyset.keysetId,
    proofs,
  });
  const custodyOperationId = deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey: operationId,
    binding: { kind: "wallet", activityId: operationId, stage: "ctf-redeem" },
  });
  return withWalletProfileLock(
    scope.scopeId,
    async () => {
      if ((await input.adapter.readOperation(scope, custodyOperationId)) !== null) {
        throw new BrowserCtfClaimBoundaryError("persisted-recovery", custodyOperationId);
      }
      await requireBrowserWalletNewWritePermission({
        database: input.database,
        scopeId: scope.scopeId,
      });
      for (const row of input.leg.rows) {
        let persisted: Awaited<ReturnType<BrowserDurableCustodyAdapter["readProof"]>>;
        try {
          persisted = await input.adapter.readProof(scope.scopeId, row.proofId);
        } catch {
          throw new BrowserCtfClaimBoundaryError("profile-ownership");
        }
        if (
          persisted === null ||
          persisted.revision !== row.revision ||
          persisted.proofFingerprint !== row.proofFingerprint ||
          persisted.selectability !== "selectable" ||
          persisted.reservationOperationId !== null
        ) {
          throw new BrowserCtfClaimBoundaryError("profile-ownership");
        }
      }
      let prepared: Awaited<ReturnType<typeof prepareDurableCtfRedeemOperation>>;
      try {
        prepared = await prepareDurableCtfRedeemOperation({
          operationId,
          mintUrl: normalizedMint,
          conditionId: input.conditionId,
          outcomeCollection: input.outcomeCollection,
          inputKeyset: {
            id: keyset.keysetId,
            unit: keyset.unit,
            input_fee_ppk: keyset.inputFeePpk,
          },
          regularKeyset: input.regularKeyset,
          inputs: proofs,
          oracleWitness: input.oracleWitness,
          seed: input.seed,
          counterSource: input.counterSource,
        });
      } catch (error) {
        throw browserCtfClaimBoundaryError(error, "keyset-authority");
      }
      let authority: ReturnType<typeof prepareDurableCustodyMintOperationAuthority>;
      try {
        authority = prepareDurableCustodyMintOperationAuthority({
          operation: prepared.operation,
          keysets: [
            conditionalKeysetAuthority(normalizedMint, keyset),
            regularKeysetAuthority(normalizedMint, input.regularKeyset),
          ],
        });
      } catch {
        throw new BrowserCtfClaimBoundaryError("keyset-authority");
      }
      const record = createDurableCustodyProofOperation({
        scope,
        operation: prepared.operation,
        facts: authority.facts,
        inventoryAccountId: null,
        exactBoundary: {
          method: "POST",
          path: "/v1/redeem_outcome",
          idempotencyKey: operationId,
          requestBody: authority.exactRequest,
          output: authority.exactOutput,
          privateMaterial: authority.exactAuthority,
        },
      });
      if (record.operation.operationId !== custodyOperationId) {
        throw new BrowserCtfClaimBoundaryError("keyset-authority");
      }
      try {
        await input.adapter.transact(
          {
            scope,
            owner: input.owner,
            operationRows: [{ operationId: custodyOperationId, expectedRevision: null }],
          },
          (transaction) =>
            bindDurableCustodyProofOperation(transaction, record, {
              requestBody: authority.exactRequest,
              output: authority.exactOutput,
              privateMaterial: authority.exactAuthority,
            }),
          {
            predecessorProofs: { [custodyOperationId]: input.leg.rows },
            requirePersistedPredecessors: true,
          },
        );
      } catch {
        throw new BrowserCtfClaimBoundaryError("persisted-recovery");
      }
      return record;
    },
    input.lockManager,
  );
}

function requireRedeemLegAuthority(
  input: BrowserCanonicalCtfRedeemBindingInput,
  scopeId: string,
  normalizedMint: string,
): void {
  const keyset = input.leg.keyset;
  if (
    input.leg.rows.length === 0 ||
    keyset.scopeId !== scopeId ||
    keyset.normalizedMint !== normalizedMint ||
    keyset.unit !== "msat" ||
    keyset.conditionId !== input.conditionId ||
    keyset.outcomeCollection !== input.outcomeCollection ||
    keyset.outcomeCollectionId !==
      deriveRootCtfOutcomeCollectionId({
        conditionId: input.conditionId,
        outcomeCollection: input.outcomeCollection,
      }) ||
    input.leg.rows.some(
      (row) =>
        row.scopeId !== scopeId ||
        row.normalizedMint !== normalizedMint ||
        row.unit !== "msat" ||
        row.conditionId !== input.conditionId ||
        row.outcomeCollection !== input.outcomeCollection ||
        row.keysetId !== keyset.keysetId,
    )
  ) {
    throw new Error("browser CTF redeem leg asset authority is invalid");
  }
}

function conditionalKeysetAuthority(
  mintUrl: string,
  keyset: BrowserCtfRedeemLeg["keyset"],
): DurableCustodyMintKeysetAuthority {
  return {
    canonicalMintUrl: mintUrl,
    id: keyset.keysetId,
    unit: keyset.unit,
    keys: keyset.denominationPublicKeys,
    inputFeePpk: keyset.inputFeePpk,
    finalExpiry: keyset.finalExpiryUnixSeconds,
    identity: {
      kind: "conditional",
      conditionId: keyset.conditionId,
      outcomeCollection: keyset.outcomeCollection,
      outcomeCollectionId: keyset.outcomeCollectionId,
    },
  };
}

function regularKeysetAuthority(
  mintUrl: string,
  keyset: MintKeys,
): DurableCustodyMintKeysetAuthority {
  return {
    canonicalMintUrl: mintUrl,
    id: keyset.id,
    unit: keyset.unit,
    keys: keyset.keys,
    inputFeePpk: keyset.input_fee_ppk ?? 0,
    finalExpiry: keyset.final_expiry ?? null,
    identity: { kind: "regular" },
  };
}

export async function commitBrowserCanonicalCtfRedeemResult(input: {
  readonly seed: Uint8Array;
  readonly operationId: string;
  readonly proofs: readonly Proof[];
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly observedAtMs: number;
}): Promise<readonly Proof[]> {
  const scope = browserWalletScope(input.seed);
  const snapshot = await input.adapter.readOperationSnapshot(scope, input.operationId);
  if (snapshot === null || snapshot.record.operation.result.state !== "none") {
    throw new Error("browser CTF redeem operation is not awaiting a mint result");
  }
  const record = snapshot.record;
  if (record.operation.state !== "transport-attempted") {
    throw new Error("browser CTF redeem transport attempt is not recorded");
  }
  const authority = assertDurableCustodyMintOperationAuthority(
    record,
    requiredArtifact(
      snapshot.artifacts,
      record.operation.privateMaterial.exactPrivateMaterial.artifactId,
    ),
  );
  if (authority.operation.kind !== "ctf-redeem") {
    throw new Error("browser CTF redeem operation authority is foreign");
  }
  const regularKeysetId = authority.operation.metadata?.regularKeysetId;
  const regularKeyset = authority.keysets.find(
    (keyset) => keyset.identity.kind === "regular" && keyset.id === regularKeysetId,
  );
  if (regularKeyset === undefined) {
    throw new Error("browser CTF redeem regular keyset authority is missing");
  }
  readPreparedDurableCtfRedeemRequest({
    operation: authority.operation,
    seed: input.seed,
    regularKeyset: mintKeysFromAuthority(regularKeyset),
  });
  const plan = decodeDurableSeedDerivedOutputPlan(authority.operation.metadata?.seedOutputPlan);
  const prepared = prepareDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: requiredArtifact(
      snapshot.artifacts,
      record.operation.privateMaterial.exactPrivateMaterial.artifactId,
    ),
    result: { regular: input.proofs },
  });
  const locators = new Map(
    locateSeedDerivedProofLineage({
      seed: input.seed,
      keysetId: plan.keysetId,
      counterStart: plan.counterStart,
      counterCount: plan.counterCount,
      proofs: prepared.proofs.map(({ proof }) => proof),
    }).map(({ secret, ...locator }) => [secret, locator]),
  );
  const successors = prepared.proofs.map(({ proof }) => {
    const derivationLocator = locators.get(proof.secret);
    if (derivationLocator === undefined) {
      throw new Error("browser CTF redeem successor derivation is missing");
    }
    return {
      proof: createBrowserCustodyProofRow({
        scopeId: scope.scopeId,
        normalizedMint: authority.operation.mintUrl,
        unit: "msat",
        proof,
        asset: { kind: "regular" as const },
        receivedAtMs: input.observedAtMs,
      }),
      expectedRevision: null,
      derivationLocator,
    };
  });
  const authorization = { ...input.owner, observedAtMs: input.observedAtMs };
  await input.adapter.transactAtomic(
    {
      scope,
      owner: authorization,
      operationRows: [{ operationId: input.operationId, expectedRevision: record.revision }],
    },
    (transaction) => {
      stageDurableCustodyPreparedMintResult({ transaction, record, prepared, authorization });
      const staged = transaction.getOperation(input.operationId);
      if (
        !staged ||
        staged.operation.result.resultHandle === null ||
        staged.operation.result.resultFingerprint === null
      ) {
        throw new Error("browser CTF redeem result staging failed");
      }
      transaction.applyVerifiedResult({
        operationId: input.operationId,
        expectedRevision: staged.revision,
        authorization,
        outputPlanFingerprint: staged.operation.outputPlan.outputPlanFingerprint,
        resultHandle: staged.operation.result.resultHandle,
        resultFingerprint: staged.operation.result.resultFingerprint,
        successorAdmission: {
          scopeId: scope.scopeId,
          operationId: input.operationId,
          admissionId: `ctf-redeem:${prepared.resultFingerprint}`,
          proofRows: successors.map(({ proof, expectedRevision }) => ({
            proofId: proof.proofId,
            expectedRevision,
            admittedRevision: proof.revision,
          })),
        },
      });
    },
    {
      successorProofs: { [input.operationId]: successors },
      legacyProofCache: {
        spentSecrets: authority.operation.inputs.map(({ secret }) => secret),
        freshProofs: successors.map(({ proof }) => storedProofFromCustodyRow(proof)),
      },
    },
  );
  return prepared.proofs.map(({ proof }) => proof);
}

function mintKeysFromAuthority(keyset: DurableCustodyMintKeysetAuthority): MintKeys {
  return {
    id: keyset.id,
    unit: keyset.unit,
    keys: keyset.keys,
    input_fee_ppk: keyset.inputFeePpk,
    ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
  };
}

function requiredArtifact(
  artifacts: readonly {
    reference: { artifactId: string };
    artifact: DurableCustodyExactArtifact;
  }[],
  artifactId: string,
): DurableCustodyExactArtifact {
  const artifact = artifacts.find(({ reference }) => reference.artifactId === artifactId)?.artifact;
  if (artifact === undefined) throw new Error("browser CTF redeem artifact is missing");
  return artifact;
}
