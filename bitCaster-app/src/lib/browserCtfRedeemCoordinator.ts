import type { CounterSource, MintKeys, Proof } from "@cashu/cashu-ts";
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
import { decodeDurableSeedDerivedOutputPlan } from "@bitcaster/client-sdk/durableSeedDerivedOutputs";
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
  const authority = assertDurableCustodyMintOperationAuthority(
    record,
    requiredArtifact(
      snapshot.artifacts,
      record.operation.privateMaterial.exactPrivateMaterial.artifactId,
    ),
  );
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
    throw new Error("browser CTF redeem regular keyset authority is missing");
  }
  const keys = mintKeysFromAuthority(regularKeyset);
  readPreparedDurableCtfRedeemRequest({ operation, seed: input.seed, regularKeyset: keys });
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
      return {
        kind: "redeemed",
        proofs: await commitBrowserCanonicalCtfRedeemResult({ ...input, proofs }),
      };
    }
  } else {
    throw new Error("browser CTF redeem recovery state is invalid");
  }
  const submitted = await executePreparedDurableCtfRedeem({
    operation,
    seed: input.seed,
    regularKeyset: keys,
    wallet: input.wallet,
  });
  if (submitted.kind === "losing") return submitted;
  return {
    kind: "redeemed",
    proofs: await commitBrowserCanonicalCtfRedeemResult({
      ...input,
      proofs: submitted.proofs,
    }),
  };
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
  requireRedeemLegAuthority(input, scope.scopeId, normalizedMint);
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
        throw new Error("browser CTF redeem operation requires persisted recovery");
      }
      await requireBrowserWalletNewWritePermission({
        database: input.database,
        scopeId: scope.scopeId,
      });
      const prepared = await prepareDurableCtfRedeemOperation({
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
      const authority = prepareDurableCustodyMintOperationAuthority({
        operation: prepared.operation,
        keysets: [
          conditionalKeysetAuthority(normalizedMint, keyset),
          regularKeysetAuthority(normalizedMint, input.regularKeyset),
        ],
      });
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
        throw new Error("browser CTF redeem operation identity is invalid");
      }
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
