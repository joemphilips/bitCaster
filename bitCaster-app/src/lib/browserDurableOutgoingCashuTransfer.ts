import { isBlsKeyset, type Proof, type ProofState, type SwapPreview } from "@cashu/cashu-ts";
import {
  acknowledgeDurableOutgoingCashuRecipient,
  admitDurableOutgoingCashuToken,
  createDurableOutgoingCashuTransfer,
  decodeDurableOutgoingCashuTransfer,
  durableOutgoingCashuStorageReservationBytes,
  runDurableOutgoingCashuTransfer,
  scheduleDurableOutgoingCashuRecoveryRetry,
  DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX,
  DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX,
  type DurableOutgoingCashuCoordinatorInput,
  type DurableOutgoingCashuDuePage,
  type DurableOutgoingCashuRecoveryCursor,
  type DurableOutgoingCashuTransfer,
  type DurableOutgoingCashuRecipientAcknowledgement,
} from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import {
  createDurableCustodyProofOperation,
  bindDurableCustodyProofOperation,
} from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import {
  assertDurableCustodyMintOperationAuthority,
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
} from "@bitcaster/client-sdk/durableCustodyMintResult";
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  type DurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
} from "@bitcaster/client-sdk/durableCustody";
import {
  hydrateDurableWalletProof,
  requireDurableWalletOperationFromCustody,
  toDurableCustodyProofOperationInput,
  type DurableWalletSendOperation,
} from "@bitcaster/client-sdk/durableWalletOperation";
import {
  deriveDurableWalletProofSecret,
  type DurableWalletProofDerivationLocator,
} from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { browserCustodyOperationId, browserWalletScope } from "./browserCtfRangeOrderSource";
import { withWalletProfileLock } from "./walletProfileLock";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
  type StagedBrowserCustodyProof,
} from "../stores/durable-custody-db";
import {
  db,
  type BitcasterDB,
  type BrowserOutgoingCashuTransferAdmissionRow,
  type BrowserOutgoingCashuTransferRow,
} from "../stores/proof-db";

const SCOPE_LEASE_MS = 10 * 60 * 1_000;
const CURSOR_HIGH = "\uffff";
const DUE_MINT_DISCOVERY_KEY_LIMIT = DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX;

export interface BrowserDurableOutgoingCashuWallet {
  completeSwap(preview: SwapPreview): Promise<{ readonly keep: Proof[]; readonly send: Proof[] }>;
  checkProofsStates(proofs: Array<Pick<Proof, "id" | "secret">>): Promise<readonly ProofState[]>;
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

export interface BrowserDurableOutgoingCashuContext {
  readonly seed: Uint8Array;
  readonly database?: BitcasterDB;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly injectFault?: "before-commit" | "after-commit";
  requireCapturedProfile(): void;
}

export interface ExecuteBrowserDurableOutgoingCashuTransferInput {
  readonly transfer: Omit<DurableOutgoingCashuCoordinatorInput["transfer"], "walletScopeId">;
  /** Reuse one exact durable-recipient product while the wallet lock is held. */
  readonly reuseRecipientBinding?: boolean;
  /** This callback may select a plan once. Recovery never calls it. */
  readonly prepareWalletSendOperation: () => Promise<DurableWalletSendOperation>;
  /** Exact locators align with `preview.keepOutputs`; recovery never recalculates them. */
  readonly keepProofDerivationLocators: readonly (DurableWalletProofDerivationLocator | null)[];
  readonly wallet: BrowserDurableOutgoingCashuWallet;
  readonly restoreExactOutputs: DurableOutgoingCashuCoordinatorInput["restoreExactOutputs"];
  readonly context: BrowserDurableOutgoingCashuContext;
}

/** Persist exact authority before mint I/O. Token presentation remains a caller action. */
export async function executeBrowserDurableOutgoingCashuTransfer(
  input: ExecuteBrowserDurableOutgoingCashuTransferInput,
): Promise<DurableOutgoingCashuTransfer> {
  const scope = browserWalletScope(input.context.seed);
  const adapter = new BrowserDurableCustodyAdapter(input.context.database ?? db);
  return withBrowserOutgoingScope(input.context, scope.scopeId, async (owner) => {
    input.context.requireCapturedProfile();
    const existing = await findReusableRecipientTransfer(input, scope.scopeId);
    if (existing !== null) {
      return runBrowserOutgoingCoordinator({
        context: input.context,
        adapter,
        owner,
        wallet: input.wallet,
        restoreExactOutputs: input.restoreExactOutputs,
        transfer: existing,
        mode: "recover",
      });
    }
    const operation = await input.prepareWalletSendOperation();
    const transfer = await prepareBrowserOutgoingTransfer({ input, adapter, owner, operation });
    input.context.requireCapturedProfile();
    const persisted = await runBrowserOutgoingCoordinator({
      context: input.context,
      adapter,
      owner,
      wallet: input.wallet,
      restoreExactOutputs: input.restoreExactOutputs,
      transfer,
      mode: "execute",
    });
    input.context.requireCapturedProfile();
    return persisted;
  });
}

async function findReusableRecipientTransfer(
  input: ExecuteBrowserDurableOutgoingCashuTransferInput,
  scopeId: string,
): Promise<DurableOutgoingCashuTransfer | null> {
  if (!input.reuseRecipientBinding) return null;
  if (input.transfer.deliveryIntent.policy !== "durable-recipient-ack") {
    throw new Error("browser outgoing recipient reuse requires a durable-recipient intent");
  }
  const rows = await (input.context.database ?? db).outgoingCashuTransfers
    .where("[scopeId+recipientBinding+transferId]")
    .between(
      [scopeId, input.transfer.deliveryIntent.opaqueProductBinding, ""],
      [scopeId, input.transfer.deliveryIntent.opaqueProductBinding, CURSOR_HIGH],
      true,
      true,
    )
    .limit(2)
    .toArray();
  if (rows.length > 1) throw new Error("browser outgoing recipient binding is ambiguous");
  return rows.length === 0 ? null : decodeOutgoingRow(scopeId, rows[0]!);
}

/** Recover one exact durable transfer. This function never selects proofs or presents a token. */
export async function recoverBrowserDurableOutgoingCashuTransfer(input: {
  readonly transferId: string;
  readonly wallet: BrowserDurableOutgoingCashuWallet;
  readonly restoreExactOutputs: DurableOutgoingCashuCoordinatorInput["restoreExactOutputs"];
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<DurableOutgoingCashuTransfer | null> {
  const scope = browserWalletScope(input.context.seed);
  const database = input.context.database ?? db;
  input.context.requireCapturedProfile();
  const row = await database.outgoingCashuTransfers.get([scope.scopeId, input.transferId]);
  if (!row) return null;
  const transfer = decodeOutgoingRow(scope.scopeId, row);
  const adapter = new BrowserDurableCustodyAdapter(database);
  const recovered = await withBrowserOutgoingScope(input.context, scope.scopeId, (owner) => {
    input.context.requireCapturedProfile();
    return runBrowserOutgoingCoordinator({
      context: input.context,
      adapter,
      owner,
      wallet: input.wallet,
      restoreExactOutputs: input.restoreExactOutputs,
      transfer,
      mode: "recover",
    });
  });
  input.context.requireCapturedProfile();
  return recovered;
}

/** Find at most one durable-recipient transfer for one exact product binding. */
export async function findBrowserDurableOutgoingCashuTransferByRecipientBinding(input: {
  readonly productBindingSha256: string;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<DurableOutgoingCashuTransfer | null> {
  if (!/^[0-9a-f]{64}$/.test(input.productBindingSha256)) {
    throw new Error("browser outgoing recipient binding is invalid");
  }
  const scope = browserWalletScope(input.context.seed);
  input.context.requireCapturedProfile();
  const rows = await (input.context.database ?? db).outgoingCashuTransfers
    .where("[scopeId+recipientBinding+transferId]")
    .between(
      [scope.scopeId, input.productBindingSha256, ""],
      [scope.scopeId, input.productBindingSha256, CURSOR_HIGH],
      true,
      true,
    )
    .limit(2)
    .toArray();
  if (rows.length > 1) {
    throw new Error("browser outgoing recipient binding is ambiguous");
  }
  return rows.length === 0 ? null : decodeOutgoingRow(scope.scopeId, rows[0]!);
}

/** Persist one verified recipient receipt with profile fencing and revision CAS. */
export async function acknowledgeBrowserDurableOutgoingCashuRecipient(input: {
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly receipt: DurableOutgoingCashuRecipientAcknowledgement;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<DurableOutgoingCashuTransfer> {
  const scope = browserWalletScope(input.context.seed);
  const database = input.context.database ?? db;
  return withWalletProfileLock(
    scope.scopeId,
    () =>
      database.transaction("rw", database.outgoingCashuTransfers, async () => {
        input.context.requireCapturedProfile();
        const row = await database.outgoingCashuTransfers.get([
          scope.scopeId,
          input.transfer.transferId,
        ]);
        if (!row) throw new Error("browser outgoing recipient transfer is missing");
        const current = decodeOutgoingRow(scope.scopeId, row);
        assertOutgoingRevision(current, input.transfer);
        const acknowledged = await acknowledgeDurableOutgoingCashuRecipient({
          transfer: current,
          receiptAdapter: {
            readAndPersistReceipt: async ({ transfer }) =>
              decodeDurableOutgoingCashuTransfer({
                ...transfer,
                deliveryState: "recipient-acknowledged",
                recipientReceipt: input.receipt,
                revision: transfer.revision + 1,
              }),
          },
        });
        input.context.requireCapturedProfile();
        await database.outgoingCashuTransfers.put(
          outgoingRow(scope.scopeId, acknowledged, row.admissionState),
        );
        return acknowledged;
      }),
    input.context.lockManager,
  );
}

/** Read one stable local-only due page. There is no global pending-transfer count. */
export async function listBrowserDurableOutgoingCashuDue(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly dueBeforeMs: number;
  readonly cursor: DurableOutgoingCashuRecoveryCursor | null;
  readonly limit: number;
  readonly maximumBytes: number;
  readonly database?: BitcasterDB;
}): Promise<DurableOutgoingCashuDuePage> {
  if (input.limit < 1 || input.limit > DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX) {
    throw new Error("browser outgoing recovery limit is invalid");
  }
  if (input.maximumBytes < 1 || input.maximumBytes > DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX) {
    throw new Error("browser outgoing recovery byte limit is invalid");
  }
  const lower = input.cursor
    ? [input.scopeId, input.mintUrl, "pending", input.cursor.dueAtMs, input.cursor.transferId]
    : [input.scopeId, input.mintUrl, "pending"];
  const collection = (input.database ?? db).outgoingCashuTransfers
    .where("[scopeId+mintUrl+mintRecoveryState+dueAtMs+transferId]")
    .between(
      lower,
      [input.scopeId, input.mintUrl, "pending", input.dueBeforeMs, CURSOR_HIGH],
      !input.cursor,
      true,
    );
  const rows: BrowserOutgoingCashuTransferRow[] = [];
  let storedBytes = 0;
  let hasMore = false;
  await collection
    .until((row) => {
      const bytes = outgoingRecoveryRowBytes(row);
      if (bytes > input.maximumBytes && rows.length === 0) {
        throw new Error("browser outgoing recovery record exceeds its byte limit");
      }
      if (rows.length === input.limit || storedBytes + bytes > input.maximumBytes) {
        hasMore = true;
        return true;
      }
      rows.push(row);
      storedBytes += bytes;
      return false;
    })
    .each(() => undefined);
  return duePage(input, rows, storedBytes, hasMore);
}

/** Discover only mints with due work in one wallet scope. This reads index keys, not transfer rows. */
export async function listBrowserDurableOutgoingCashuDueMints(input: {
  readonly scopeId: string;
  readonly dueBeforeMs: number;
  readonly database?: BitcasterDB;
}): Promise<{ readonly mints: readonly string[]; readonly hasMore: boolean }> {
  const mints = new Set<string>();
  let keyCount = 0;
  let hasMore = false;
  await (input.database ?? db).outgoingCashuTransfers
    .where("[scopeId+mintRecoveryState+dueAtMs+mintUrl+transferId]")
    .between(
      [input.scopeId, "pending", 0, "", ""],
      [input.scopeId, "pending", input.dueBeforeMs, CURSOR_HIGH, CURSOR_HIGH],
      true,
      true,
    )
    .limit(DUE_MINT_DISCOVERY_KEY_LIMIT + 1)
    .eachKey((key) => {
      keyCount += 1;
      if (keyCount > DUE_MINT_DISCOVERY_KEY_LIMIT) {
        hasMore = true;
        return;
      }
      if (Array.isArray(key) && typeof key[3] === "string") mints.add(key[3]);
    });
  return { mints: [...mints], hasMore };
}

/** Recover one bounded mint page. Callers choose when startup or visibility recovery runs. */
export async function recoverBrowserDurableOutgoingCashuDuePage(input: {
  readonly mintUrl: string;
  readonly dueBeforeMs: number;
  readonly cursor: DurableOutgoingCashuRecoveryCursor | null;
  readonly walletForMint: (
    mintUrl: string,
    unit: string,
  ) => Promise<BrowserDurableOutgoingCashuWallet>;
  readonly restoreExactOutputs: DurableOutgoingCashuCoordinatorInput["restoreExactOutputs"];
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<DurableOutgoingCashuDuePage & { readonly failed: number }> {
  const scope = browserWalletScope(input.context.seed);
  const page = await listBrowserDurableOutgoingCashuDue({
    scopeId: scope.scopeId,
    mintUrl: input.mintUrl,
    dueBeforeMs: input.dueBeforeMs,
    cursor: input.cursor,
    limit: DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX,
    maximumBytes: DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX,
    database: input.context.database,
  });
  const wallets = new Map<string, Promise<BrowserDurableOutgoingCashuWallet>>();
  let failed = 0;
  for (const transfer of page.transfers) {
    try {
      const key = `${transfer.mintUrl}\u0000${transfer.unit}`;
      let wallet = wallets.get(key);
      if (wallet === undefined) {
        input.context.requireCapturedProfile();
        wallet = input.walletForMint(transfer.mintUrl, transfer.unit);
        wallets.set(key, wallet);
      }
      await recoverBrowserDurableOutgoingCashuTransfer({
        transferId: transfer.transferId,
        wallet: await wallet,
        restoreExactOutputs: input.restoreExactOutputs,
        context: input.context,
      });
    } catch {
      failed += 1;
      await persistBrowserOutgoingRetry(input.context, transfer);
    }
  }
  return { ...page, failed };
}

async function persistBrowserOutgoingRetry(
  context: BrowserDurableOutgoingCashuContext,
  transfer: DurableOutgoingCashuTransfer,
): Promise<"retried" | "concurrent"> {
  const scope = browserWalletScope(context.seed);
  const next = scheduleDurableOutgoingCashuRecoveryRetry({
    transfer,
    nowMs: (context.now ?? Date.now)(),
  });
  const database = context.database ?? db;
  return withWalletProfileLock(
    scope.scopeId,
    () =>
      database.transaction("rw", database.outgoingCashuTransfers, async () => {
        context.requireCapturedProfile();
        const existing = await database.outgoingCashuTransfers.get([
          scope.scopeId,
          transfer.transferId,
        ]);
        if (!existing) throw new Error("browser outgoing retry transfer is missing");
        const current = decodeOutgoingRow(scope.scopeId, existing);
        if (current.revision > transfer.revision) return "concurrent";
        if (current.revision < transfer.revision) {
          throw new Error("browser outgoing retry transfer revision is stale");
        }
        if (
          deriveDurableCustodyArtifactFingerprint(current) !==
          deriveDurableCustodyArtifactFingerprint(transfer)
        ) {
          throw new Error("browser outgoing retry transfer revision conflicts");
        }
        await database.outgoingCashuTransfers.put(
          outgoingRow(scope.scopeId, next, existing.admissionState),
        );
        return "retried";
      }),
    context.lockManager,
  );
}

async function prepareBrowserOutgoingTransfer(input: {
  readonly input: ExecuteBrowserDurableOutgoingCashuTransferInput;
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly operation: DurableWalletSendOperation;
}): Promise<DurableOutgoingCashuTransfer> {
  const { input: request, adapter, owner, operation } = input;
  const scope = browserWalletScope(request.context.seed);
  const transfer = createDurableOutgoingCashuTransfer({
    ...request.transfer,
    walletScopeId: scope.scopeId,
    walletSendOperation: operation,
    keepProofDerivationLocators: request.keepProofDerivationLocators,
  });
  verifyOutgoingKeepOutputLocators(request.context.seed, transfer);
  const binding = outgoingBinding(scope, operation, request.wallet);
  const predecessors = await outgoingPredecessorRows(adapter, scope.scopeId, operation);
  await adapter.transactAtomic(
    {
      scope,
      owner,
      operationRows: [
        { operationId: binding.record.operation.operationId, expectedRevision: null },
      ],
    },
    (transaction) =>
      bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
    {
      predecessorProofs: { [binding.record.operation.operationId]: predecessors },
      outgoingTransfer: outgoingRow(scope.scopeId, transfer, "reserved"),
      outgoingAdmission: outgoingAdmission(scope.scopeId, transfer),
    },
  );
  return transfer;
}

async function outgoingPredecessorRows(
  adapter: BrowserDurableCustodyAdapter,
  scopeId: string,
  operation: DurableWalletSendOperation,
) {
  return Promise.all(
    operation.preview.inputs.map(async (proof) => {
      const proofId = deriveDurableCustodyProofId({
        scopeId,
        normalizedMint: operation.mintUrl,
        unit: operation.unit,
        keysetId: proof.id,
        secret: proof.secret,
      });
      const row = await adapter.readProof(scopeId, proofId);
      if (row === null) throw new Error("browser outgoing predecessor proof is missing");
      return row;
    }),
  );
}

async function runBrowserOutgoingCoordinator(input: {
  readonly context: BrowserDurableOutgoingCashuContext;
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly wallet: BrowserDurableOutgoingCashuWallet;
  readonly restoreExactOutputs: DurableOutgoingCashuCoordinatorInput["restoreExactOutputs"];
  readonly transfer: DurableOutgoingCashuTransfer;
  readonly mode: "execute" | "recover";
}): Promise<DurableOutgoingCashuTransfer> {
  const request = transferRequest(input.transfer);
  return runDurableOutgoingCashuTransfer({
    mode: input.mode,
    transfer: request,
    wallet: input.wallet,
    restoreExactOutputs: input.restoreExactOutputs,
    preMint: {
      prepare: async () => input.transfer,
      recover: async () => loadExactOutgoingTransfer(input.context, input.transfer),
    },
    postMint: {
      persistMinted: async (minted) => persistBrowserOutgoingMintResult(input, minted),
    },
    walletOperationStore: {
      loadOperation: async (operationId) => loadExactOutgoingOperation(input, operationId),
      persistCompletedResult: async () => {
        throw new Error("browser outgoing coordinator post-mint boundary was bypassed");
      },
    },
  });
}

async function persistBrowserOutgoingMintResult(
  runtime: Parameters<typeof runBrowserOutgoingCoordinator>[0],
  minted: {
    readonly transfer: DurableOutgoingCashuTransfer;
    readonly keepProofs: readonly unknown[];
    readonly sendProofs: readonly unknown[];
    readonly encodedToken: string;
  },
): Promise<DurableOutgoingCashuTransfer> {
  const scope = browserWalletScope(runtime.context.seed);
  const custodyOperationId = browserCustodyOperationId(
    scope,
    minted.transfer.walletSendOperation.operationId,
  );
  const snapshot = await runtime.adapter.readOperationSnapshot(scope, custodyOperationId);
  if (!snapshot) throw new Error("browser outgoing custody operation is missing");
  const exact = exactOutgoingOperation(snapshot.record, snapshot.artifacts);
  const keep = verifyOutgoingKeepProofs(runtime.context.seed, minted.transfer, minted.keepProofs);
  const send = minted.sendProofs.map(hydrateOutgoingProof);
  const prepared = prepareDurableCustodyVerifiedMintResult({
    record: snapshot.record,
    exactAuthority: exact,
    result: { keep, send },
  });
  const successors = outgoingSuccessors(
    scope.scopeId,
    minted.transfer,
    prepared.proofs,
    runtime.context.now ?? Date.now,
  );
  const revisions = await outgoingCustodyRevisions(
    runtime.adapter,
    scope,
    minted.transfer,
    keep,
    send,
  );
  const admitted = admitDurableOutgoingCashuToken({
    transfer: minted.transfer,
    keepProofs: minted.keepProofs,
    sendProofs: minted.sendProofs,
    encodedToken: minted.encodedToken,
    custodyRevisions: revisions,
    dueAtMs: minted.transfer.recovery.dueAtMs,
  });
  return commitOutgoingMintAdmission({ runtime, scope, snapshot, prepared, successors, admitted });
}

async function commitOutgoingMintAdmission(input: {
  readonly runtime: Parameters<typeof runBrowserOutgoingCoordinator>[0];
  readonly scope: ReturnType<typeof browserWalletScope>;
  readonly snapshot: NonNullable<
    Awaited<ReturnType<BrowserDurableCustodyAdapter["readOperationSnapshot"]>>
  >;
  readonly prepared: ReturnType<typeof prepareDurableCustodyVerifiedMintResult>;
  readonly successors: readonly StagedBrowserCustodyProof[];
  readonly admitted: DurableOutgoingCashuTransfer;
}): Promise<DurableOutgoingCashuTransfer> {
  await input.runtime.adapter.transactAtomic(
    selection(input.scope, input.runtime.owner, input.snapshot.record),
    (transaction) =>
      applyOutgoingMintResult(
        transaction,
        input.snapshot.record,
        input.prepared,
        input.runtime.owner,
      ),
    {
      successorProofs: { [input.snapshot.record.operation.operationId]: input.successors },
      outgoingTransfer: outgoingRow(input.scope.scopeId, input.admitted, "consumed"),
      outgoingAdmission: null,
      ...(input.runtime.context.injectFault === undefined
        ? {}
        : { injectFault: input.runtime.context.injectFault }),
    },
  );
  return input.admitted;
}

function verifyOutgoingKeepProofs(
  seed: Uint8Array,
  transfer: DurableOutgoingCashuTransfer,
  values: readonly unknown[],
): Proof[] {
  const keep = values.map(hydrateOutgoingProof);
  for (const [index, proof] of keep.entries()) {
    const locator = transfer.keepProofDerivationLocators[index];
    if (locator === null) continue;
    if (locator === undefined) throw new Error("browser outgoing keep proof locator is missing");
    const expected = deriveDurableWalletProofSecret({
      seed,
      locator,
      proofKeysetId: proof.id,
      proofAmount: proof.amount.toString(),
    });
    if (expected !== proof.secret) {
      throw new Error("browser outgoing keep proof locator conflicts with minted proof");
    }
  }
  return keep;
}

function verifyOutgoingKeepOutputLocators(
  seed: Uint8Array,
  transfer: DurableOutgoingCashuTransfer,
): void {
  for (const [index, output] of transfer.walletSendOperation.preview.keepOutputs.entries()) {
    const locator = transfer.keepProofDerivationLocators[index];
    if (locator === null) continue;
    if (locator === undefined) throw new Error("browser outgoing keep proof locator is missing");
    const expected = deriveDurableWalletProofSecret({
      seed,
      locator,
      proofKeysetId: output.blindedMessage.id,
      proofAmount: output.blindedMessage.amount,
    });
    if (expected !== output.secret) {
      throw new Error("browser outgoing keep proof locator conflicts with planned output");
    }
  }
}

function applyOutgoingMintResult(
  transaction: Parameters<BrowserDurableCustodyAdapter["transact"]>[1] extends (
    transaction: infer T,
  ) => unknown
    ? T
    : never,
  record: DurableCustodyRecord,
  prepared: ReturnType<typeof prepareDurableCustodyVerifiedMintResult>,
  authorization: DurableCustodyOwnerAuthorization,
): void {
  stageDurableCustodyPreparedMintResult({ transaction, record, prepared, authorization });
  const staged = transaction.getOperation(record.operation.operationId);
  if (!staged || staged.operation.result.exactResult === null) {
    throw new Error("browser outgoing custody result staging failed");
  }
  transaction.applyVerifiedResult({
    operationId: staged.operation.operationId,
    expectedRevision: staged.revision,
    authorization,
    outputPlanFingerprint: staged.operation.outputPlan.outputPlanFingerprint,
    resultHandle: staged.operation.result.resultHandle!,
    resultFingerprint: staged.operation.result.resultFingerprint!,
    successorAdmission: {
      scopeId: staged.scope.scopeId,
      operationId: staged.operation.operationId,
      admissionId: `wallet-send:${staged.operation.result.resultFingerprint!}`,
      proofRows: prepared.proofs.map(({ material }) => ({
        proofId: material.proofId,
        expectedRevision: null,
        admittedRevision: 0,
      })),
    },
  });
}

function outgoingBinding(
  scope: ReturnType<typeof browserWalletScope>,
  operation: DurableWalletSendOperation,
  wallet: BrowserDurableOutgoingCashuWallet,
) {
  const custodyOperation = toDurableCustodyProofOperationInput(operation);
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation: custodyOperation,
    keysets: outgoingKeysets(custodyOperation, wallet),
  });
  return {
    record: createDurableCustodyProofOperation({
      scope,
      operation: custodyOperation,
      facts: authority.facts,
      inventoryAccountId: null,
      exactBoundary: {
        method: "POST",
        path: "/v1/swap",
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

function outgoingKeysets(
  operation: ReturnType<typeof toDurableCustodyProofOperationInput>,
  wallet: BrowserDurableOutgoingCashuWallet,
) {
  const ids = new Set([
    ...operation.inputs.map(({ id }) => id),
    ...Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  ]);
  return [...ids].map((id) => {
    if (!id || isBlsKeyset(id))
      throw new Error("browser outgoing transfer supports only V2 keysets");
    const keyset = wallet.getKeyset(id);
    if (
      keyset.id !== id ||
      keyset.unit !== operation.metadata?.unit ||
      !keyset.verify() ||
      keyset.conditional
    ) {
      throw new Error("browser outgoing transfer keyset is invalid");
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

function outgoingSuccessors(
  scopeId: string,
  transfer: DurableOutgoingCashuTransfer,
  proofs: ReturnType<typeof prepareDurableCustodyVerifiedMintResult>["proofs"],
  now: () => number,
): StagedBrowserCustodyProof[] {
  const observedAtMs = now();
  let keepIndex = 0;
  return proofs.map(({ group, proof }) => ({
    proof: {
      ...createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: transfer.mintUrl,
        unit: transfer.unit as "sat" | "msat",
        proof,
        asset: { kind: "regular" },
        receivedAtMs: observedAtMs,
      }),
      selectability: group === "send" ? "spent" : "selectable",
    },
    expectedRevision: null,
    derivationLocator:
      group === "keep" ? (transfer.keepProofDerivationLocators[keepIndex++] ?? null) : null,
  }));
}

async function outgoingCustodyRevisions(
  adapter: BrowserDurableCustodyAdapter,
  scope: ReturnType<typeof browserWalletScope>,
  transfer: DurableOutgoingCashuTransfer,
  keep: readonly Proof[],
  send: readonly Proof[],
) {
  const input = await Promise.all(
    transfer.walletSendOperation.preview.inputs.map(async (proof) => {
      const proofId = deriveDurableCustodyProofId({
        scopeId: scope.scopeId,
        normalizedMint: transfer.mintUrl,
        unit: transfer.unit,
        keysetId: proof.id,
        secret: proof.secret,
      });
      const row = await adapter.readProof(scope.scopeId, proofId);
      if (
        row === null ||
        row.selectability !== "locked" ||
        row.reservationOperationId !==
          browserCustodyOperationId(scope, transfer.walletSendOperation.operationId)
      ) {
        throw new Error("browser outgoing predecessor custody revision is foreign");
      }
      return { proofIdentity: proofIdentity(proof), revision: row.revision + 1 };
    }),
  );
  return [...input, ...keep, ...send].map((entry) =>
    "proofIdentity" in entry ? entry : { proofIdentity: proofIdentity(entry), revision: 0 },
  );
}

async function loadExactOutgoingTransfer(
  context: BrowserDurableOutgoingCashuContext,
  expected: DurableOutgoingCashuTransfer,
): Promise<DurableOutgoingCashuTransfer> {
  const scope = browserWalletScope(context.seed);
  const row = await (context.database ?? db).outgoingCashuTransfers.get([
    scope.scopeId,
    expected.transferId,
  ]);
  const transfer = row ? decodeOutgoingRow(scope.scopeId, row) : null;
  if (!transfer || transfer.walletScopeId !== expected.walletScopeId) {
    throw new Error("browser outgoing transfer is missing or foreign");
  }
  return transfer;
}

async function loadExactOutgoingOperation(
  runtime: Parameters<typeof runBrowserOutgoingCoordinator>[0],
  operationId: string,
) {
  const scope = browserWalletScope(runtime.context.seed);
  const snapshot = await runtime.adapter.readOperationSnapshot(
    scope,
    browserCustodyOperationId(scope, operationId),
  );
  if (!snapshot) return null;
  const authority = assertDurableCustodyMintOperationAuthority(
    snapshot.record,
    exactOutgoingOperation(snapshot.record, snapshot.artifacts),
  );
  const operation = requireDurableWalletOperationFromCustody(authority.operation);
  if (operation.kind !== "wallet-send" || operation.operationId !== operationId) {
    throw new Error("browser outgoing operation is foreign");
  }
  const transfer = await loadExactOutgoingTransfer(runtime.context, runtime.transfer);
  if (transfer.deliveryState === "delivery-pending") {
    return { operation, state: "completed" as const, result: null };
  }
  return { operation, state: "prepared" as const, result: null };
}

function exactOutgoingOperation(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
) {
  const id = record.operation.privateMaterial.exactPrivateMaterial.artifactId;
  const artifact = artifacts.find(({ reference }) => reference.artifactId === id)?.artifact;
  if (!artifact || typeof artifact.artifact !== "object" || artifact.artifact === null) {
    throw new Error("browser outgoing operation authority is missing");
  }
  return artifact as DurableCustodyExactArtifact;
}

function selection(
  scope: ReturnType<typeof browserWalletScope>,
  owner: DurableCustodyOwnerAuthorization,
  record: DurableCustodyRecord,
) {
  return {
    scope,
    owner,
    operationRows: [
      { operationId: record.operation.operationId, expectedRevision: record.revision },
    ],
  };
}

function outgoingRow(
  scopeId: string,
  transfer: DurableOutgoingCashuTransfer,
  admissionState: BrowserOutgoingCashuTransferRow["admissionState"] = "consumed",
): BrowserOutgoingCashuTransferRow {
  return {
    scopeId,
    mintUrl: transfer.mintUrl,
    mintRecoveryState: mintRecoveryState(transfer),
    localAuthorityState: localAuthorityState(transfer),
    dueAtMs: transfer.recovery.dueAtMs,
    transferId: transfer.transferId,
    recipientBinding: recipientBinding(transfer),
    admissionState,
    transfer,
  };
}

function outgoingAdmission(
  scopeId: string,
  transfer: DurableOutgoingCashuTransfer,
): BrowserOutgoingCashuTransferAdmissionRow {
  const reservedBytes = durableOutgoingCashuStorageReservationBytes(transfer);
  const padding = new Uint8Array(reservedBytes);
  for (let offset = 0; offset < padding.byteLength; offset += 65_536) {
    crypto.getRandomValues(padding.subarray(offset, Math.min(offset + 65_536, padding.byteLength)));
  }
  return { scopeId, transferId: transfer.transferId, reservedBytes, padding };
}

function transferRequest(
  transfer: DurableOutgoingCashuTransfer,
): DurableOutgoingCashuCoordinatorInput["transfer"] {
  return {
    transferId: transfer.transferId,
    walletScopeId: transfer.walletScopeId,
    mintUrl: transfer.mintUrl,
    unit: transfer.unit,
    requestedAmount: transfer.requestedAmount,
    deliveryIntent: transfer.deliveryIntent,
  };
}

function decodeOutgoingRow(
  scopeId: string,
  row: BrowserOutgoingCashuTransferRow,
): DurableOutgoingCashuTransfer {
  const transfer = decodeDurableOutgoingCashuTransfer(row.transfer);
  if (
    row.scopeId !== scopeId ||
    row.transferId !== transfer.transferId ||
    row.mintUrl !== transfer.mintUrl ||
    row.mintRecoveryState !== mintRecoveryState(transfer) ||
    row.localAuthorityState !== localAuthorityState(transfer) ||
    row.dueAtMs !== transfer.recovery.dueAtMs ||
    row.recipientBinding !== recipientBinding(transfer) ||
    (row.admissionState !== "reserved" && row.admissionState !== "consumed") ||
    transfer.walletScopeId !== scopeId
  ) {
    throw new Error("browser outgoing transfer row is foreign");
  }
  return transfer;
}

function recipientBinding(transfer: DurableOutgoingCashuTransfer): string | null {
  return transfer.deliveryIntent.policy === "durable-recipient-ack"
    ? transfer.deliveryIntent.opaqueProductBinding
    : null;
}

function assertOutgoingRevision(
  current: DurableOutgoingCashuTransfer,
  expected: DurableOutgoingCashuTransfer,
): void {
  if (current.revision !== expected.revision) {
    throw new Error("browser outgoing recipient transfer revision is stale");
  }
  if (
    deriveDurableCustodyArtifactFingerprint(current) !==
    deriveDurableCustodyArtifactFingerprint(expected)
  ) {
    throw new Error("browser outgoing recipient transfer revision conflicts");
  }
}

function duePage(
  input: Parameters<typeof listBrowserDurableOutgoingCashuDue>[0],
  rows: readonly BrowserOutgoingCashuTransferRow[],
  storedBytes: number,
  hasMore: boolean,
): DurableOutgoingCashuDuePage {
  const transfers = rows.map((row) => decodeOutgoingRow(input.scopeId, row));
  const last = transfers.at(-1);
  const nextCursor =
    hasMore && last ? { dueAtMs: last.recovery.dueAtMs, transferId: last.transferId } : null;
  return { storedBytes, transfers, nextCursor };
}

function outgoingRecoveryRowBytes(row: BrowserOutgoingCashuTransferRow): number {
  return new TextEncoder().encode(
    JSON.stringify({
      scopeId: row.scopeId,
      mintUrl: row.mintUrl,
      mintRecoveryState: row.mintRecoveryState,
      localAuthorityState: row.localAuthorityState,
      dueAtMs: row.dueAtMs,
      transferId: row.transferId,
      admissionState: row.admissionState,
      transfer: row.transfer,
    }),
  ).byteLength;
}

function mintRecoveryState(transfer: DurableOutgoingCashuTransfer): "pending" | "complete" {
  switch (transfer.deliveryState) {
    case "prepared":
      return "pending";
    case "delivery-pending":
    case "recipient-acknowledged":
    case "bearer-spent":
    case "bearer-partial":
    case "reclaim-prepared":
    case "reclaimed":
      return "complete";
  }
}

function localAuthorityState(transfer: DurableOutgoingCashuTransfer): "nonterminal" | "terminal" {
  switch (transfer.deliveryState) {
    case "prepared":
    case "delivery-pending":
    case "bearer-partial":
    case "reclaim-prepared":
      return "nonterminal";
    case "recipient-acknowledged":
    case "bearer-spent":
    case "reclaimed":
      return "terminal";
  }
}

function proofIdentity(proof: { id: string; secret: string; C: string }): string {
  return deriveDurableCustodyArtifactFingerprint({
    id: proof.id,
    secret: proof.secret,
    C: proof.C,
  });
}

function hydrateOutgoingProof(value: unknown): Proof {
  return hydrateDurableWalletProof(value as Parameters<typeof hydrateDurableWalletProof>[0]);
}

async function withBrowserOutgoingScope<T>(
  context: BrowserDurableOutgoingCashuContext,
  scopeId: string,
  action: (owner: DurableCustodyOwnerAuthorization) => Promise<T>,
): Promise<T> {
  const adapter = new BrowserDurableCustodyAdapter(context.database ?? db);
  const now = context.now ?? Date.now;
  const randomId = context.randomId ?? (() => crypto.randomUUID());
  return withWalletProfileLock(
    scopeId,
    async () => {
      const scope = browserWalletScope(context.seed);
      const observedAtMs = now();
      const owner = await adapter.claimScope(scope, {
        incarnationId: `browser-outgoing:${randomId()}`,
        observedAtMs,
        leaseExpiresAtMs: observedAtMs + SCOPE_LEASE_MS,
      });
      let actionFailed = false;
      try {
        return await action({ ...owner, observedAtMs: now() });
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
    context.lockManager,
  );
}
