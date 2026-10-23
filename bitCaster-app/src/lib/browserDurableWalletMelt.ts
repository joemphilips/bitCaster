import Dexie from "dexie";
import {
  createSpeculativeCounterTranscript,
  type SpeculativeCounterTranscript,
} from "@bitcaster/client-sdk/speculativeCounterTranscript";
import {
  BrowserWalletCounterDexieStore,
  BrowserWalletCounterSnapshotConflictError,
} from "../stores/browser-wallet-counter-db";
import { createUncachedWalletForSeedUnit } from "../stores/wallet";
import {
  Amount,
  type MeltPreview,
  type OperationCounters,
  type MeltQuoteBaseResponse,
  type MeltQuoteResponse,
  type OutputDataLike,
  type Proof,
  type SerializedBlindedSignature,
} from "@cashu/cashu-ts";
import { runDurableWalletMeltOperation } from "@bitcaster/client-sdk/durableWalletMelt";
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
  requireDurableWalletOperationFromCustody,
  serializeDurableWalletMeltOperation,
  serializeDurableWalletProof,
  toDurableCustodyProofOperationInput,
  type DurableWalletMeltOperation,
} from "@bitcaster/client-sdk/durableWalletOperation";
import {
  decodeDurableCustodyProofMaterialRecord,
  deserializeDurableCustodyProofArtifact,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { browserCustodyOperationId, browserWalletScope } from "./browserCtfRangeOrderSource";
import { requireBrowserWalletNewWritePermission } from "./browserWalletNewWritePermission";
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

type BrowserMeltOperationSnapshot = NonNullable<
  Awaited<ReturnType<BrowserDurableCustodyAdapter["readOperationSnapshot"]>>
>;

interface BrowserMeltProtocolInput {
  readonly input: BrowserDurableWalletMeltInput;
  readonly scope: ReturnType<typeof browserWalletScope>;
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly now: () => number;
  readonly snapshot: BrowserMeltOperationSnapshot;
  readonly operation: DurableWalletMeltOperation;
}

export interface BrowserDurableWalletMeltWallet {
  prepareMelt(
    method: string,
    quote: MeltQuoteResponse,
    proofs: Proof[],
    config?: { keysetId: string; onCountersReserved: (range: OperationCounters) => void },
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
  readonly observePrepared?: (operation: DurableWalletMeltOperation) => Promise<void>;
  readonly injectPreparationFault?: (
    phase: "counter-written" | "journal-bound" | "after-commit",
  ) => void;
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
  input = {
    ...input,
    context: Object.create(input.context, { seed: { value: input.context.seed.slice() } }),
  };
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
            await runMeltProtocolWithSnapshot(
              {
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
              },
              "recover",
            );
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
  let recover = snapshot !== null;

  if (snapshot === null) {
    const database = input.context.database ?? db;
    await requireBrowserWalletNewWritePermission({ database, scopeId: scope.scopeId });
    const canonicalProofs = await canonicalMeltProofs(adapter, scope, input);
    const selected = input.wallet.getKeyset();
    const hasChange =
      canonicalProofs.reduce((sum, proof) => sum + Amount.from(proof.amount).toBigInt(), 0n) >
      Amount.from(input.quote.amount).toBigInt();
    const pinned = {
      id: selected.id,
      unit: selected.unit,
      fee: selected.fee,
      expiry: selected.expiry,
      conditional: selected.conditional,
      keys: { ...selected.keys },
    };
    if (
      hasChange &&
      (!/^01[0-9a-f]{64}$/.test(pinned.id) ||
        pinned.unit !== "msat" ||
        pinned.conditional !== undefined ||
        !selected.verify())
    )
      throw new Error("browser wallet melt output keyset is invalid");
    const counters = new BrowserWalletCounterDexieStore({
      database,
      scopeId: scope.scopeId,
      isCurrentProfile: () => {
        input.context.requireCapturedProfile();
        return true;
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const transcript = hasChange
        ? createSpeculativeCounterTranscript([
            await counters.readSnapshotInContext(
              { mintUrl: input.mintUrl, unit: "msat" },
              pinned.id,
            ),
          ])
        : null;
      const wallet =
        transcript === null
          ? input.wallet
          : await createUncachedWalletForSeedUnit({
              mintUrl: input.mintUrl,
              unit: "msat",
              seed: input.context.seed,
              scopeId: scope.scopeId,
              database,
              requireCapturedProfile: input.context.requireCapturedProfile,
              counterSource: transcript.counterSource,
            });
      if (transcript !== null) {
        const keyset = wallet.getKeyset(pinned.id);
        if (
          keyset.id !== pinned.id ||
          keyset.unit !== pinned.unit ||
          keyset.fee !== pinned.fee ||
          keyset.expiry !== pinned.expiry ||
          keyset.conditional !== undefined ||
          !keyset.verify() ||
          JSON.stringify(Object.entries(keyset.keys).sort()) !==
            JSON.stringify(Object.entries(pinned.keys).sort())
        )
          throw new Error("browser wallet melt pinned keyset changed");
      }
      let callbacks = 0;
      let reserved: OperationCounters | undefined;
      const preview = await wallet.prepareMelt("bolt11", input.quote, canonicalProofs, {
        keysetId: pinned.id,
        onCountersReserved: (range) => {
          callbacks += 1;
          reserved = range;
        },
      });
      const allocations = transcript?.allocations() ?? [];
      const allocation = allocations[0];
      if (
        transcript === null
          ? callbacks !== 0 || preview.outputData.length !== 0
          : callbacks !== 1 ||
            allocations.length !== 1 ||
            !allocation ||
            !reserved ||
            allocation.keysetId !== pinned.id ||
            reserved.keysetId !== pinned.id ||
            reserved.start !== allocation.start ||
            reserved.count !== allocation.count ||
            reserved.next !== allocation.start + allocation.count ||
            allocation.count !== preview.outputData.length ||
            preview.outputData.length === 0 ||
            preview.outputData.some(
              (output) =>
                output.blindedMessage.id !== pinned.id ||
                Amount.from(output.blindedMessage.amount).toBigInt() !== 0n,
            )
      )
        throw new Error("browser wallet melt change counter transcript conflicts");
      input.context.requireCapturedProfile();
      const operation = serializeDurableWalletMeltOperation({
        operationId,
        mintUrl: input.mintUrl,
        unit: "msat",
        preview,
      });
      const binding = createMeltBinding(scope, operation, wallet);
      await input.context.observePrepared?.(structuredClone(operation));
      input.context.requireCapturedProfile();
      try {
        const selected = await persistMeltPreparation({
          input,
          scope,
          adapter,
          owner,
          now,
          operation,
          binding,
          counters,
          transcript,
          canonicalProofs,
        });
        input.context.injectPreparationFault?.("after-commit");
        snapshot = selected.snapshot;
        recover = selected.recovered;
        break;
      } catch (error) {
        input.context.requireCapturedProfile();
        const saved = await readMeltSnapshot(adapter, scope, operationId);
        if (saved !== null) {
          assertSavedMeltSelection(saved, operation);
          snapshot = saved;
          recover = true;
          break;
        }
        if (!(error instanceof BrowserWalletCounterSnapshotConflictError) || attempt === 2)
          throw error;
      }
    }
  }
  if (snapshot === null) throw new Error("browser wallet melt operation was not persisted");

  const operation = meltOperationFromSnapshot(snapshot.record, snapshot.artifacts);
  return runMeltProtocolWithSnapshot(
    { input, scope, adapter, owner, now, snapshot, operation },
    recover ? "recover" : "execute",
  );
}

function assertSavedMeltSelection(
  snapshot: BrowserMeltOperationSnapshot,
  expected: DurableWalletMeltOperation,
): void {
  const saved = meltOperationFromSnapshot(snapshot.record, snapshot.artifacts);
  if (
    saved.operationId !== expected.operationId ||
    saved.mintUrl !== expected.mintUrl ||
    JSON.stringify(saved.preview.quote) !== JSON.stringify(expected.preview.quote) ||
    JSON.stringify(saved.preview.inputs) !== JSON.stringify(expected.preview.inputs) ||
    snapshot.record.operation.state === "aborted"
  )
    throw new Error("browser wallet melt saved preparation conflicts");
}

async function persistMeltPreparation(input: {
  input: BrowserDurableWalletMeltInput;
  scope: ReturnType<typeof browserWalletScope>;
  adapter: BrowserDurableCustodyAdapter;
  owner: DurableCustodyOwnerAuthorization;
  now: () => number;
  operation: DurableWalletMeltOperation;
  binding: ReturnType<typeof createMeltBinding>;
  counters: BrowserWalletCounterDexieStore;
  transcript: SpeculativeCounterTranscript | null;
  canonicalProofs: readonly Proof[];
}): Promise<{ snapshot: BrowserMeltOperationSnapshot; recovered: boolean }> {
  const database = input.input.context.database ?? db;
  const context = input.input.context;
  return database.transaction(
    "rw",
    [
      database.custodyScopes,
      database.custodyOperations,
      database.custodyArtifacts,
      database.custodyProofs,
      database.custodyReservations,
      database.custodyActiveWork,
      database.custodyProofBackupAuthorities,
      database.custodyConditionalKeysets,
      database.encryptedWalletBackupV2DesiredAssets,
      database.walletCounterAssociations,
      database.walletCounterCursors,
      database.encryptedWalletBackupOwnerAcceptedHeads,
      database.encryptedWalletBackupV2AcceptedHeads,
    ],
    async () => {
      context.requireCapturedProfile();
      await requireBrowserWalletNewWritePermission({ database, scopeId: input.scope.scopeId });
      const saved = await readMeltSnapshot(input.adapter, input.scope, input.operation.operationId);
      if (saved !== null) {
        assertSavedMeltSelection(saved, input.operation);
        context.requireCapturedProfile();
        return { snapshot: saved, recovered: true };
      }
      const canonical = await canonicalMeltProofs(input.adapter, input.scope, {
        ...input.input,
        proofs: input.canonicalProofs,
      });
      if (
        JSON.stringify(canonical.map(serializeDurableWalletProof)) !==
        JSON.stringify(input.operation.preview.inputs)
      )
        throw new Error("browser wallet melt source material changed");
      const predecessors = await meltPredecessorRows(
        input.adapter,
        input.scope.scopeId,
        input.operation,
      );
      if (input.transcript !== null) {
        const changes = input.transcript.changes();
        if (changes.length !== 1) throw new Error("browser wallet melt counter plan conflicts");
        await input.counters.compareAndAdvanceInCurrentTransaction(
          Dexie.currentTransaction!,
          { mintUrl: input.input.mintUrl, unit: "msat" },
          changes[0]!,
        );
        context.injectPreparationFault?.("counter-written");
      }
      await input.adapter.transactInCurrentTransaction(
        Dexie.currentTransaction!,
        {
          scope: input.scope,
          owner: ownerAt(input.owner, input.now()),
          operationRows: [
            { operationId: input.binding.record.operation.operationId, expectedRevision: null },
          ],
        },
        (transaction) =>
          bindDurableCustodyProofOperation(
            transaction,
            input.binding.record,
            input.binding.artifacts,
          ),
        { predecessorProofs: { [input.binding.record.operation.operationId]: predecessors } },
      );
      context.injectPreparationFault?.("journal-bound");
      await requireBrowserWalletNewWritePermission({ database, scopeId: input.scope.scopeId });
      context.requireCapturedProfile();
      const snapshot = await readMeltSnapshot(
        input.adapter,
        input.scope,
        input.operation.operationId,
      );
      if (snapshot === null) throw new Error("browser wallet melt operation was not persisted");
      context.requireCapturedProfile();
      return { snapshot, recovered: false };
    },
  );
}

async function runMeltProtocolWithSnapshot(
  input: BrowserMeltProtocolInput,
  mode: "execute" | "recover",
): Promise<BrowserDurableWalletMeltResult> {
  input.input.context.requireCapturedProfile();
  const { scope, adapter, owner, now, operation } = input;
  const snapshot = input.snapshot;
  const requireOwnedOperation = async () => {
    input.input.context.requireCapturedProfile();
    await adapter.transact(
      {
        scope,
        owner: ownerAt(owner, now()),
        operationRows: [
          {
            operationId: snapshot.record.operation.operationId,
            expectedRevision: snapshot.record.revision,
          },
        ],
      },
      () => undefined,
    );
    input.input.context.requireCapturedProfile();
  };
  const result = await runDurableWalletMeltOperation({
    mode,
    operation,
    resultState: snapshot.record.operation.result.state,
    transport: {
      completeMelt: async (preview) => {
        await requireOwnedOperation();
        const response = await input.input.wallet.completeMelt(preview);
        input.input.context.requireCapturedProfile();
        return response;
      },
      checkMeltQuote: async (method, quote) => {
        await requireOwnedOperation();
        return input.input.wallet.checkMeltQuote(method, quote);
      },
      createMeltChangeProofs: (outputData, signatures) =>
        input.input.wallet.createMeltChangeProofs(outputData, signatures),
    },
    store: {
      readAppliedResult: async () =>
        readMeltResult(snapshot.record, snapshot.artifacts).proofs.map(({ proof }) => proof),
      applyStagedResult: async () => {
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
        return verified.proofs.map(({ proof }) => proof);
      },
      stageAndApplyPaidChange: (change) =>
        stageAndApplyMeltChange({
          input: input.input,
          scope,
          adapter,
          owner,
          now,
          snapshot,
          operation,
          change,
        }).then(({ change: proofs }) => proofs),
      releaseUnpaidReservation: () =>
        releaseUnpaidMelt({ scope, adapter, owner, now, record: snapshot.record }),
    },
  });
  return { paid: result.state === "paid", change: result.proofs };
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
