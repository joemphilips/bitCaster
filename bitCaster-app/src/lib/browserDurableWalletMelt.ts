import {
  Amount,
  type MeltPreview,
  type MeltQuoteBaseResponse,
  type MeltQuoteResponse,
  type OutputDataLike,
  type Proof,
  type SerializedBlindedSignature,
} from "@cashu/cashu-ts";
import {
  assertDurableCustodyMintOperationAuthority,
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  readDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
} from "@bitcaster/client-sdk/durableCustodyMintResult";
import {
  prepareDurableCustodyExactArtifact,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
} from "@bitcaster/client-sdk/durableCustody";
import {
  createDurableCustodyProofOperation,
  bindDurableCustodyProofOperation,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import {
  decodeDurableWalletOperation,
  hydrateDurableWalletProof,
  requireDurableWalletOperationFromCustody,
  serializeDurableWalletProof,
  toDurableCustodyProofOperationInput,
  type DurableWalletMeltOperation,
} from "@bitcaster/client-sdk/durableWalletOperation";
import {
  deserializeDurableCustodyOutput,
  serializeDurableCustodyOutput,
} from "@bitcaster/client-sdk/durableCustodyProofOperation";
import {
  decodeDurableCustodyProofMaterialRecord,
  deserializeDurableCustodyProofArtifact,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { browserCustodyOperationId, browserWalletScope } from "./browserCtfRangeOrderSource";
import { withWalletProfileLock } from "./walletProfileLock";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../stores/durable-custody-db";
import { db, type BitcasterDB, type StoredProof } from "../stores/proof-db";

const SCOPE_LEASE_MS = 10 * 60 * 1_000;
const RECOVERY_PAGE_LIMIT = 64;
const PRODUCT_MSAT_ERROR = "browser wallet melt requires msat";
const WALLET_MELT_OPERATION_PREFIX = "wallet-melt:";

export interface BrowserDurableWalletMeltWallet {
  prepareMelt(
    method: string,
    quote: MeltQuoteResponse,
    proofs: readonly Proof[],
  ): Promise<MeltPreview<MeltQuoteResponse>>;
  completeMelt(
    preview: MeltPreview<Pick<MeltQuoteResponse, "quote">>,
  ): Promise<{ quote: { quote: string; state: string }; change: Proof[] }>;
  checkMeltQuote(
    method: string,
    quote: string,
  ): Promise<
    Pick<MeltQuoteBaseResponse, "quote" | "state"> & {
      change?: SerializedBlindedSignature[];
    }
  >;
  createMeltChangeProofs(
    outputData: OutputDataLike[],
    changeSigs: SerializedBlindedSignature[],
  ): Proof[];
  getKeyset(keysetId?: string): {
    id: string;
    unit: string;
    keys: Readonly<Record<string, string>>;
    fee: number;
    expiry?: number;
    conditional?: unknown;
    verify(): boolean;
  };
}

export interface BrowserDurableWalletMeltContext {
  readonly seed: Uint8Array;
  readonly database?: BitcasterDB;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly injectFault?: "before-commit" | "after-commit";
  readonly injectFaultPhase?: "stage" | "apply";
  requireCapturedProfile(): void;
}

export interface BrowserDurableWalletMeltInput {
  readonly quote: MeltQuoteResponse;
  readonly mintUrl: string;
  readonly proofs: readonly Proof[];
  readonly wallet: BrowserDurableWalletMeltWallet;
  readonly context: BrowserDurableWalletMeltContext;
}

export interface BrowserDurableWalletMeltResult {
  readonly paid: boolean;
  readonly change: readonly Proof[];
}

export async function meltBrowserDurableWallet(
  input: BrowserDurableWalletMeltInput,
): Promise<BrowserDurableWalletMeltResult> {
  if (input.quote.unit !== "msat") throw new Error(PRODUCT_MSAT_ERROR);
  const scope = browserWalletScope(input.context.seed);
  const adapter = new BrowserDurableCustodyAdapter(input.context.database ?? db);
  const now = input.context.now ?? Date.now;
  const randomId = input.context.randomId ?? (() => crypto.randomUUID());
  return withWalletProfileLock(
    scope.scopeId,
    async () => {
      const owner = await claimOwner(adapter, scope, now, randomId);
      let actionFailed = false;
      try {
        return await runMeltWithOwner(input, scope, adapter, owner, now);
      } catch (error) {
        actionFailed = true;
        throw error;
      } finally {
        try {
          await adapter.releaseScope(scope, { ...owner, observedAtMs: now() });
        } catch (error) {
          if (!actionFailed) throw error;
        }
      }
    },
    input.context.lockManager,
  );
}

/** Resume one bounded page of persisted wallet melts after a reload. */
export async function recoverBrowserDurableWalletMeltsInPass(input: {
  readonly walletForMint: (
    mintUrl: string,
    unit: "msat",
  ) => Promise<BrowserDurableWalletMeltWallet>;
  readonly context: BrowserDurableWalletMeltContext;
  readonly cursor?: string | null;
}): Promise<{ pending: number; hasMore: boolean; nextCursor: string | null }> {
  const scope = browserWalletScope(input.context.seed);
  const adapter = new BrowserDurableCustodyAdapter(input.context.database ?? db);
  const now = input.context.now ?? Date.now;
  const randomId = input.context.randomId ?? (() => crypto.randomUUID());
  const page = await adapter.listRecoverablePage({
    scope,
    cursor: input.cursor ?? null,
    limit: RECOVERY_PAGE_LIMIT,
  });
  let pending = 0;
  await withWalletProfileLock(
    scope.scopeId,
    async () => {
      const owner = await claimOwner(adapter, scope, now, randomId);
      let actionFailed = false;
      try {
        for (const record of page.records) {
          try {
            if (!record.operation.retainedOperationKey.startsWith(WALLET_MELT_OPERATION_PREFIX)) {
              continue;
            }
            const snapshot = await adapter.readOperationSnapshot(
              scope,
              record.operation.operationId,
            );
            if (snapshot === null) throw new Error("browser wallet melt operation is missing");
            const operation = meltOperationFromSnapshot(snapshot.record, snapshot.artifacts);
            const wallet = await input.walletForMint(operation.mintUrl, "msat");
            input.context.requireCapturedProfile();
            await resumeRecoveredMeltWithSnapshot({
              input: {
                quote: persistedMeltQuote(operation),
                mintUrl: operation.mintUrl,
                proofs: [],
                wallet,
                context: input.context,
              },
              scope,
              adapter,
              owner,
              now,
              snapshot,
              operation,
            });
            input.context.requireCapturedProfile();
          } catch {
            pending += 1;
          }
        }
      } catch (error) {
        actionFailed = true;
        throw error;
      } finally {
        try {
          await adapter.releaseScope(scope, { ...owner, observedAtMs: now() });
        } catch (error) {
          if (!actionFailed) throw error;
        }
      }
    },
    input.context.lockManager,
  );
  return {
    pending,
    hasMore: page.nextCursor !== null,
    nextCursor: page.nextCursor,
  };
}

async function runMeltWithOwner(
  input: BrowserDurableWalletMeltInput,
  scope: ReturnType<typeof browserWalletScope>,
  adapter: BrowserDurableCustodyAdapter,
  owner: DurableCustodyOwnerAuthorization,
  now: () => number,
): Promise<BrowserDurableWalletMeltResult> {
  input.context.requireCapturedProfile();
  const operationKey = meltOperationKey(input.mintUrl, input.quote);
  let operationId = operationKey;
  let snapshot = await readMeltSnapshot(adapter, scope, operationId);
  if (snapshot?.record.operation.state === "aborted") {
    const nextAttempt = await selectMeltAttempt(adapter, scope, operationKey);
    operationId = nextAttempt.operationId;
    snapshot = nextAttempt.snapshot;
  }
  const wasPersistedBeforeCall = snapshot !== null;

  if (snapshot === null) {
    const canonicalProofs = await canonicalMeltProofs(adapter, scope, input);
    const preview = await input.wallet.prepareMelt("bolt11", input.quote, canonicalProofs);
    input.context.requireCapturedProfile();
    const operation = serializeMeltOperation(operationId, input.mintUrl, preview);
    const binding = createMeltBinding(scope, operation, input.wallet);
    const predecessors = await meltPredecessorRows(adapter, scope.scopeId, operation);
    await adapter.transact(
      {
        scope,
        owner: ownerAt(owner, now()),
        operationRows: [
          { operationId: binding.record.operation.operationId, expectedRevision: null },
        ],
      },
      (transaction) =>
        bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
      { predecessorProofs: { [binding.record.operation.operationId]: predecessors } },
    );
    snapshot = await readMeltSnapshot(adapter, scope, operationId);
    if (snapshot === null) throw new Error("browser wallet melt operation was not persisted");
  }

  const operation = meltOperationFromSnapshot(snapshot.record, snapshot.artifacts);
  const resume = wasPersistedBeforeCall ? resumeRecoveredMeltWithSnapshot : resumeMeltWithSnapshot;
  return resume({ input, scope, adapter, owner, now, snapshot, operation });
}

async function resumeMeltWithSnapshot(input: {
  input: BrowserDurableWalletMeltInput;
  scope: ReturnType<typeof browserWalletScope>;
  adapter: BrowserDurableCustodyAdapter;
  owner: DurableCustodyOwnerAuthorization;
  now: () => number;
  snapshot: Awaited<ReturnType<BrowserDurableCustodyAdapter["readOperationSnapshot"]>> & {};
  operation: DurableWalletMeltOperation;
}): Promise<BrowserDurableWalletMeltResult> {
  input.input.context.requireCapturedProfile();
  const { scope, adapter, owner, now, operation } = input;
  let snapshot = input.snapshot;
  const context = input.input.context;
  if (snapshot.record.operation.result.state === "applied") {
    const verified = readMeltResult(snapshot.record, snapshot.artifacts);
    return { paid: true, change: verified.proofs.map(({ proof }) => proof) };
  }
  if (snapshot.record.operation.result.state === "verified-staged") {
    const verified = readMeltResult(snapshot.record, snapshot.artifacts);
    await applyMeltResult({
      input: input.input,
      scope,
      adapter,
      owner,
      now,
      snapshot,
      operation,
      verified,
    });
    return { paid: true, change: verified.proofs.map(({ proof }) => proof) };
  }

  const response = await input.input.wallet.completeMelt(hydrateMeltPreview(operation));
  context.requireCapturedProfile();
  if (response.quote.quote !== operation.preview.quote.quote) {
    throw new Error("browser wallet melt response quote is foreign");
  }
  if (response.quote.state !== "PAID") {
    if (response.quote.state === "UNPAID") {
      await releaseUnpaidMelt({ scope, adapter, owner, now, record: snapshot.record });
      return { paid: false, change: [] };
    }
    throw new Error("browser wallet melt remains pending");
  }
  return stageAndApplyMeltChange({
    input: input.input,
    scope,
    adapter,
    owner,
    now,
    snapshot,
    operation,
    change: response.change ?? [],
  });
}

async function resumeRecoveredMeltWithSnapshot(input: {
  input: BrowserDurableWalletMeltInput;
  scope: ReturnType<typeof browserWalletScope>;
  adapter: BrowserDurableCustodyAdapter;
  owner: DurableCustodyOwnerAuthorization;
  now: () => number;
  snapshot: Awaited<ReturnType<BrowserDurableCustodyAdapter["readOperationSnapshot"]>> & {};
  operation: DurableWalletMeltOperation;
}): Promise<BrowserDurableWalletMeltResult> {
  input.input.context.requireCapturedProfile();
  const { scope, adapter, owner, now, operation } = input;
  let snapshot = input.snapshot;
  if (snapshot.record.operation.result.state === "applied") {
    const verified = readMeltResult(snapshot.record, snapshot.artifacts);
    return { paid: true, change: verified.proofs.map(({ proof }) => proof) };
  }
  if (snapshot.record.operation.result.state === "verified-staged") {
    const verified = readMeltResult(snapshot.record, snapshot.artifacts);
    await applyMeltResult({
      input: input.input,
      scope,
      adapter,
      owner,
      now,
      snapshot,
      operation,
      verified,
    });
    return { paid: true, change: verified.proofs.map(({ proof }) => proof) };
  }

  const preview = hydrateMeltPreview(operation);
  const status = await checkPersistedMeltQuote(input.input.wallet, operation.preview.quote.quote);
  if (status.state === "PAID") {
    const change = input.input.wallet.createMeltChangeProofs(
      preview.outputData,
      status.change ?? [],
    );
    return stageAndApplyMeltChange({
      input: input.input,
      scope,
      adapter,
      owner,
      now,
      snapshot,
      operation,
      change,
    });
  }
  if (status.state !== "UNPAID") {
    throw new Error("browser wallet melt remains pending");
  }

  let response: Awaited<ReturnType<BrowserDurableWalletMeltWallet["completeMelt"]>>;
  try {
    response = await input.input.wallet.completeMelt(preview);
    input.input.context.requireCapturedProfile();
  } catch (error) {
    const refreshed = await checkPersistedMeltQuote(
      input.input.wallet,
      operation.preview.quote.quote,
    );
    if (refreshed.state === "PAID") {
      const change = input.input.wallet.createMeltChangeProofs(
        preview.outputData,
        refreshed.change ?? [],
      );
      return stageAndApplyMeltChange({
        input: input.input,
        scope,
        adapter,
        owner,
        now,
        snapshot,
        operation,
        change,
      });
    }
    throw error;
  }
  if (response.quote.quote !== operation.preview.quote.quote) {
    throw new Error("browser wallet melt response quote is foreign");
  }
  if (response.quote.state === "PAID") {
    return stageAndApplyMeltChange({
      input: input.input,
      scope,
      adapter,
      owner,
      now,
      snapshot,
      operation,
      change: response.change ?? [],
    });
  }
  if (response.quote.state === "UNPAID") {
    await releaseUnpaidMelt({ scope, adapter, owner, now, record: snapshot.record });
    return { paid: false, change: [] };
  }
  throw new Error("browser wallet melt remains pending");
}

async function checkPersistedMeltQuote(
  wallet: BrowserDurableWalletMeltWallet,
  quote: string,
): Promise<
  Pick<MeltQuoteBaseResponse, "quote" | "state"> & {
    change?: SerializedBlindedSignature[];
  }
> {
  const status = await wallet.checkMeltQuote("bolt11", quote);
  if (status.quote !== quote) throw new Error("browser wallet melt status quote is foreign");
  return status;
}

async function stageAndApplyMeltChange(input: {
  input: BrowserDurableWalletMeltInput;
  scope: ReturnType<typeof browserWalletScope>;
  adapter: BrowserDurableCustodyAdapter;
  owner: DurableCustodyOwnerAuthorization;
  now: () => number;
  snapshot: Awaited<ReturnType<BrowserDurableCustodyAdapter["readOperationSnapshot"]>> & {};
  operation: DurableWalletMeltOperation;
  change: readonly Proof[];
}): Promise<BrowserDurableWalletMeltResult> {
  const prepared = prepareDurableCustodyVerifiedMintResult({
    record: input.snapshot.record,
    exactAuthority: exactAuthority(input.snapshot.record, input.snapshot.artifacts),
    result: { change: [...input.change] },
  });
  await stageMeltResult({
    input: input.input,
    scope: input.scope,
    adapter: input.adapter,
    owner: input.owner,
    now: input.now,
    snapshot: input.snapshot,
    prepared,
  });
  const stagedSnapshot = await readMeltSnapshot(
    input.adapter,
    input.scope,
    input.operation.operationId,
  );
  if (stagedSnapshot === null) throw new Error("browser wallet melt result staging was lost");
  const staged = readMeltResult(stagedSnapshot.record, stagedSnapshot.artifacts);
  await applyMeltResult({
    input: input.input,
    scope: input.scope,
    adapter: input.adapter,
    owner: input.owner,
    now: input.now,
    snapshot: stagedSnapshot,
    operation: input.operation,
    verified: staged,
  });
  return { paid: true, change: staged.proofs.map(({ proof }) => proof) };
}

async function canonicalMeltProofs(
  adapter: BrowserDurableCustodyAdapter,
  scope: ReturnType<typeof browserWalletScope>,
  input: BrowserDurableWalletMeltInput,
): Promise<Proof[]> {
  return Promise.all(
    input.proofs.map(async (candidate) => {
      const proofId = deriveDurableCustodyProofId({
        scopeId: scope.scopeId,
        normalizedMint: input.mintUrl,
        unit: "msat",
        keysetId: candidate.id,
        secret: candidate.secret,
      });
      const row = await adapter.readProof(scope.scopeId, proofId);
      if (
        row === null ||
        row.normalizedMint !== input.mintUrl ||
        row.unit !== "msat" ||
        row.assetKind !== "regular" ||
        row.conditionId !== null ||
        row.outcomeCollection !== null ||
        row.selectability !== "selectable" ||
        row.reservationOperationId !== null
      ) {
        throw new Error("browser wallet melt predecessor custody proof is foreign");
      }
      const { proof: material } = decodeDurableCustodyProofMaterialRecord(row);
      return deserializeDurableCustodyProofArtifact({ schemaVersion: 1, ...material });
    }),
  );
}

function serializeMeltOperation(
  operationId: string,
  mintUrl: string,
  preview: MeltPreview<MeltQuoteResponse>,
): DurableWalletMeltOperation {
  return decodeDurableWalletOperation({
    schemaVersion: 1,
    operationId,
    kind: "wallet-melt",
    mintUrl,
    unit: "msat",
    preview: {
      method: preview.method,
      inputs: preview.inputs.map(serializeDurableWalletProof),
      outputData: preview.outputData.map((output) => {
        const serialized = serializeDurableCustodyOutput(output);
        return { ...serialized, ephemeralE: serialized.ephemeralE ?? null };
      }),
      keysetId: preview.keysetId,
      quote: {
        quote: preview.quote.quote,
        amount: Amount.from(preview.quote.amount).toString(),
      },
      requestOptions: { preferAsync: false, extraPayload: {} },
    },
  }) as DurableWalletMeltOperation;
}

function hydrateMeltPreview(
  operation: DurableWalletMeltOperation,
): MeltPreview<Pick<MeltQuoteResponse, "quote">> {
  return {
    method: operation.preview.method,
    inputs: operation.preview.inputs.map(hydrateDurableWalletProof),
    outputData: operation.preview.outputData.map(({ ephemeralE, ...output }) =>
      deserializeDurableCustodyOutput({
        ...output,
        ...(ephemeralE === null ? {} : { ephemeralE }),
      }),
    ),
    keysetId: operation.preview.keysetId,
    quote: { quote: operation.preview.quote.quote },
  };
}

function createMeltBinding(
  scope: ReturnType<typeof browserWalletScope>,
  operation: DurableWalletMeltOperation,
  wallet: BrowserDurableWalletMeltWallet,
) {
  const custody = toDurableCustodyProofOperationInput(operation);
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation: custody,
    keysets: meltKeysets(custody, wallet),
  });
  return {
    record: createDurableCustodyProofOperation({
      scope,
      operation: custody,
      facts: authority.facts,
      inventoryAccountId: null,
      exactBoundary: {
        method: "POST",
        path: `/v1/melt/${operation.preview.method}`,
        idempotencyKey: operation.operationId,
        requestBody: authority.exactRequest,
        output: authority.exactOutput,
        privateMaterial: authority.exactAuthority,
      },
    }),
    artifacts: {
      requestBody: authority.exactRequest,
      output: authority.exactOutput,
      privateMaterial: authority.exactAuthority,
    },
  };
}

function meltKeysets(
  operation: ReturnType<typeof toDurableCustodyProofOperationInput>,
  wallet: BrowserDurableWalletMeltWallet,
) {
  const ids = new Set([
    ...operation.inputs.map(({ id }) => id),
    ...Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  ]);
  return [...ids].map((id) => {
    if (!id) throw new Error("browser wallet melt keyset id is missing");
    const keyset = wallet.getKeyset(id);
    if (
      keyset.id !== id ||
      keyset.unit !== operation.metadata?.unit ||
      !keyset.verify() ||
      keyset.conditional
    ) {
      throw new Error("browser wallet melt keyset is invalid");
    }
    return {
      canonicalMintUrl: operation.mintUrl,
      id,
      unit: keyset.unit,
      keys: Object.fromEntries(Object.entries(keyset.keys)),
      inputFeePpk: keyset.fee,
      finalExpiry: keyset.expiry ?? null,
      identity: { kind: "regular" as const },
    };
  });
}

async function meltPredecessorRows(
  adapter: BrowserDurableCustodyAdapter,
  scopeId: string,
  operation: DurableWalletMeltOperation,
) {
  return Promise.all(
    operation.preview.inputs.map(async (proof) => {
      const proofId = deriveDurableCustodyProofId({
        scopeId,
        normalizedMint: operation.mintUrl,
        unit: operation.unit as "msat",
        keysetId: proof.id,
        secret: proof.secret,
      });
      const row = await adapter.readProof(scopeId, proofId);
      if (
        row === null ||
        row.selectability !== "selectable" ||
        row.reservationOperationId !== null
      ) {
        throw new Error("browser wallet melt predecessor custody proof is unavailable");
      }
      return row;
    }),
  );
}

async function applyMeltResult(input: {
  input: BrowserDurableWalletMeltInput;
  scope: ReturnType<typeof browserWalletScope>;
  adapter: BrowserDurableCustodyAdapter;
  owner: DurableCustodyOwnerAuthorization;
  now: () => number;
  snapshot: Awaited<ReturnType<BrowserDurableCustodyAdapter["readOperationSnapshot"]>> & {};
  operation: DurableWalletMeltOperation;
  verified: ReturnType<typeof prepareDurableCustodyVerifiedMintResult>;
}): Promise<void> {
  const successors = input.verified.proofs.map(({ proof }) => ({
    proof: createBrowserCustodyProofRow({
      scopeId: input.scope.scopeId,
      normalizedMint: input.operation.mintUrl,
      unit: "msat",
      proof,
      asset: { kind: "regular" },
      receivedAtMs: input.now(),
    }),
    expectedRevision: null,
    derivationLocator: null,
  }));
  const predecessors = await meltPredecessorRowsForRevision(
    input.adapter,
    input.scope.scopeId,
    input.operation,
    input.snapshot.record.operation.operationId,
  );
  const authorization = ownerAt(input.owner, input.now());
  await input.adapter.transact(
    {
      scope: input.scope,
      owner: authorization,
      operationRows: [
        {
          operationId: input.snapshot.record.operation.operationId,
          expectedRevision: input.snapshot.record.revision,
        },
      ],
    },
    (transaction) => {
      const record = input.snapshot.record;
      const staged = transaction.getOperation(record.operation.operationId);
      if (staged === null || staged.operation.result.exactResult === null) {
        throw new Error("browser wallet melt result is not staged");
      }
      transaction.applyVerifiedResult({
        operationId: staged.operation.operationId,
        expectedRevision: staged.revision,
        authorization,
        outputPlanFingerprint: staged.operation.outputPlan.outputPlanFingerprint,
        resultHandle: staged.operation.result.resultHandle!,
        resultFingerprint: staged.operation.result.resultFingerprint!,
        successorAdmission: {
          scopeId: input.scope.scopeId,
          operationId: staged.operation.operationId,
          admissionId: `wallet-melt:${staged.operation.result.resultFingerprint!}`,
          proofRows: successors.map(({ proof, expectedRevision }) => ({
            proofId: proof.proofId,
            expectedRevision,
            admittedRevision: proof.revision,
          })),
        },
      });
    },
    {
      successorProofs: { [input.snapshot.record.operation.operationId]: successors },
      predecessorProofs: {
        [input.snapshot.record.operation.operationId]: predecessors,
      },
      legacyProofCache: {
        spentSecrets: input.operation.preview.inputs.map(({ secret }) => secret),
        freshProofs: input.verified.proofs.map(({ proof }) =>
          toLegacyStoredProof(proof, input.operation.mintUrl),
        ),
      },
      ...(input.input.context.injectFault === undefined ||
      (input.input.context.injectFaultPhase !== undefined &&
        input.input.context.injectFaultPhase !== "apply")
        ? {}
        : { injectFault: input.input.context.injectFault }),
    },
  );
}

function toLegacyStoredProof(proof: Proof, mintUrl: string): StoredProof {
  return {
    ...proof,
    mintUrl,
    baseAsset: "sat",
    unit: "msat",
  };
}

async function stageMeltResult(input: {
  input: BrowserDurableWalletMeltInput;
  scope: ReturnType<typeof browserWalletScope>;
  adapter: BrowserDurableCustodyAdapter;
  owner: DurableCustodyOwnerAuthorization;
  now: () => number;
  snapshot: Awaited<ReturnType<BrowserDurableCustodyAdapter["readOperationSnapshot"]>> & {};
  prepared: ReturnType<typeof prepareDurableCustodyVerifiedMintResult>;
}): Promise<void> {
  const authorization = ownerAt(input.owner, input.now());
  await input.adapter.transact(
    {
      scope: input.scope,
      owner: authorization,
      operationRows: [
        {
          operationId: input.snapshot.record.operation.operationId,
          expectedRevision: input.snapshot.record.revision,
        },
      ],
    },
    (transaction) =>
      stageDurableCustodyPreparedMintResult({
        transaction,
        record: input.snapshot.record,
        prepared: input.prepared,
        authorization,
      }),
    input.input.context.injectFault === undefined ||
      (input.input.context.injectFaultPhase !== undefined &&
        input.input.context.injectFaultPhase !== "stage")
      ? {}
      : { injectFault: input.input.context.injectFault },
  );
}

async function meltPredecessorRowsForRevision(
  adapter: BrowserDurableCustodyAdapter,
  scopeId: string,
  operation: DurableWalletMeltOperation,
  operationId: string,
) {
  return Promise.all(
    operation.preview.inputs.map(async (proof) => {
      const proofId = deriveDurableCustodyProofId({
        scopeId,
        normalizedMint: operation.mintUrl,
        unit: "msat",
        keysetId: proof.id,
        secret: proof.secret,
      });
      const row = await adapter.readProof(scopeId, proofId);
      if (
        row === null ||
        row.selectability !== "locked" ||
        row.reservationOperationId !== operationId
      ) {
        throw new Error("browser wallet melt predecessor custody reservation is foreign");
      }
      return row;
    }),
  );
}

async function releaseUnpaidMelt(input: {
  scope: ReturnType<typeof browserWalletScope>;
  adapter: BrowserDurableCustodyAdapter;
  owner: DurableCustodyOwnerAuthorization;
  now: () => number;
  record: DurableCustodyRecord;
}): Promise<void> {
  const authorization = ownerAt(input.owner, input.now());
  await input.adapter.transact(
    {
      scope: input.scope,
      owner: authorization,
      operationRows: [
        {
          operationId: input.record.operation.operationId,
          expectedRevision: input.record.revision,
        },
      ],
    },
    (transaction) =>
      transaction.transitionOperation({
        operationId: input.record.operation.operationId,
        expectedRevision: input.record.revision,
        transition: {
          kind: "release-unspent-reservation",
          authorization,
          expectedRevision: input.record.revision,
        },
      }),
  );
}

async function readMeltSnapshot(
  adapter: BrowserDurableCustodyAdapter,
  scope: ReturnType<typeof browserWalletScope>,
  operationId: string,
) {
  return adapter.readOperationSnapshot(scope, browserCustodyOperationId(scope, operationId));
}

async function selectMeltAttempt(
  adapter: BrowserDurableCustodyAdapter,
  scope: ReturnType<typeof browserWalletScope>,
  operationKey: string,
): Promise<{
  operationId: string;
  snapshot: Awaited<ReturnType<BrowserDurableCustodyAdapter["readOperationSnapshot"]>>;
}> {
  for (let ordinal = 1; ; ordinal += 1) {
    const operationId = `${operationKey}:${ordinal}`;
    const snapshot = await readMeltSnapshot(adapter, scope, operationId);
    if (snapshot === null) return { operationId, snapshot: null };
    const operation = meltOperationFromSnapshot(snapshot.record, snapshot.artifacts);
    if (persistedMeltOperationKey(operation) !== operationKey) {
      throw new Error("browser wallet melt attempt authority is foreign");
    }
    if (
      snapshot.record.operation.state !== "aborted" &&
      snapshot.record.operation.result.state !== "applied"
    ) {
      return { operationId, snapshot };
    }
    if (
      snapshot.record.operation.state === "reconciled" &&
      snapshot.record.operation.result.state === "applied"
    ) {
      return { operationId, snapshot };
    }
  }
}

function meltOperationFromSnapshot(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
): DurableWalletMeltOperation {
  const operation = walletOperationFromSnapshot(record, artifacts);
  if (
    operation.kind !== "wallet-melt" ||
    operation.operationId !== record.operation.retainedOperationKey ||
    operation.unit !== "msat" ||
    !isMeltAttemptKey(record.operation.retainedOperationKey, persistedMeltOperationKey(operation))
  ) {
    throw new Error("browser wallet melt authority is foreign");
  }
  return operation;
}

function isMeltAttemptKey(retainedOperationKey: string, operationKey: string): boolean {
  if (retainedOperationKey === operationKey) return true;
  const suffix = retainedOperationKey.slice(operationKey.length + 1);
  return retainedOperationKey.startsWith(`${operationKey}:`) && /^[1-9][0-9]*$/.test(suffix);
}

function walletOperationFromSnapshot(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
) {
  return requireDurableWalletOperationFromCustody(
    assertDurableCustodyMintOperationAuthority(record, exactAuthority(record, artifacts)).operation,
  );
}

function readMeltResult(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
) {
  const exactResult = record.operation.result.exactResult;
  if (exactResult === null) throw new Error("browser wallet melt result is missing");
  return readDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: exactAuthority(record, artifacts),
    exactResult: requiredArtifact(artifacts, exactResult.artifactId),
  });
}

function exactAuthority(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
) {
  return requiredArtifact(
    artifacts,
    record.operation.privateMaterial.exactPrivateMaterial.artifactId,
  );
}

function requiredArtifact(
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
  artifactId: string,
) {
  const artifact = artifacts.find(({ reference }) => reference.artifactId === artifactId)?.artifact;
  if (artifact === undefined) throw new Error("browser wallet melt authority artifact is missing");
  return artifact as ReturnType<typeof prepareDurableCustodyExactArtifact>;
}

function meltOperationKey(mintUrl: string, quote: MeltQuoteResponse): string {
  return `wallet-melt:${deriveDurableCustodyArtifactFingerprint({
    mintUrl,
    unit: "msat",
    quote: { quote: quote.quote, amount: Amount.from(quote.amount).toString() },
  })}`;
}

function persistedMeltOperationKey(operation: DurableWalletMeltOperation): string {
  return `wallet-melt:${deriveDurableCustodyArtifactFingerprint({
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    quote: operation.preview.quote,
  })}`;
}

function persistedMeltQuote(operation: DurableWalletMeltOperation): MeltQuoteResponse {
  return {
    quote: operation.preview.quote.quote,
    amount: Amount.from(operation.preview.quote.amount),
    unit: "msat",
    state: "UNPAID",
    expiry: Number.MAX_SAFE_INTEGER,
    request: "persisted-wallet-melt",
    fee_reserve: Amount.from(0),
    payment_preimage: null,
  };
}

async function claimOwner(
  adapter: BrowserDurableCustodyAdapter,
  scope: ReturnType<typeof browserWalletScope>,
  now: () => number,
  randomId: () => string,
): Promise<DurableCustodyOwnerAuthorization> {
  const observedAtMs = now();
  return adapter.claimScope(scope, {
    incarnationId: `browser-wallet-melt:${randomId()}`,
    observedAtMs,
    leaseExpiresAtMs: observedAtMs + SCOPE_LEASE_MS,
  });
}

function ownerAt(owner: DurableCustodyOwnerAuthorization, observedAtMs: number) {
  return { ...owner, observedAtMs };
}
