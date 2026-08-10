import {
  isBlsKeyset,
  type OperationCounters,
  type Proof,
  type ProofState,
  type SwapPreview,
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
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { createDurableCustodyProofOperation } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import {
  deserializeDurableCustodyOutput,
  type DurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableCustodyProofOperation";
import {
  deserializeDurableCustodyProofArtifact,
  decodeDurableCustodyProofMaterialRecord,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { locateSeedDerivedProofLineage } from "@bitcaster/client-sdk/durableSeedDerivedProofLineage";
import {
  requireDurableWalletOperationFromCustody,
  runDurableWalletReceiveOperation,
  serializeDurableWalletReceiveOperation,
  toDurableCustodyProofOperationInput,
  type DurableWalletReceiveOperation,
} from "@bitcaster/client-sdk/durableWalletOperation";
import { bindDurableCustodyProofOperation } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { withWalletProfileLock } from "./walletProfileLock";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
  decodeBrowserCustodyProofRow,
} from "../stores/durable-custody-db";
import { db, type BitcasterDB, type StoredProof } from "../stores/proof-db";

const SCOPE_LEASE_MS = 10 * 60 * 1_000;
const RECOVERY_PAGE_LIMIT = 64;
const PROOF_ID_MIN = "";
const PROOF_ID_MAX = "\uffff";

export interface BrowserDurableWalletReceiveWallet {
  prepareSwapToReceive(
    token: string,
    options?: { onCountersReserved?: (counters: OperationCounters) => void },
    outputConfig?: unknown,
  ): Promise<SwapPreview>;
  completeSwap(preview: SwapPreview): Promise<{ readonly keep: Proof[]; readonly send: Proof[] }>;
  checkProofsStates(proofs: Array<Pick<Proof, "id" | "secret">>): Promise<readonly ProofState[]>;
  mint: {
    restore(input: {
      outputs: Array<{ amount: import("@cashu/cashu-ts").Amount; id: string; B_: string }>;
    }): Promise<{
      outputs: Array<{ amount: import("@cashu/cashu-ts").Amount; id: string; B_: string }>;
      signatures: Array<unknown>;
    }>;
  };
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

export interface BrowserDurableWalletReceiveContext {
  readonly seed: Uint8Array;
  readonly database?: BitcasterDB;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly injectFault?: "before-commit" | "after-commit";
  requireCapturedProfile(): void;
}

export interface BrowserDurableWalletReceiveInput {
  readonly token: string;
  readonly mintUrl: string;
  readonly unit: "sat" | "msat";
  readonly wallet: BrowserDurableWalletReceiveWallet;
  readonly context: BrowserDurableWalletReceiveContext;
}

interface BrowserReceiveRuntime {
  readonly scope: DurableCustodyScope;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly custodyOperationId: string;
  readonly wallet: BrowserDurableWalletReceiveWallet;
  readonly context: BrowserDurableWalletReceiveContext;
  readonly adapter: BrowserDurableCustodyAdapter;
}

/** Persist and execute one ordinary bearer-token receive through custody authority. */
export async function receiveBrowserDurableWalletToken(
  input: BrowserDurableWalletReceiveInput,
): Promise<readonly Proof[]> {
  const { context, wallet } = input;
  const scope = browserWalletScope(context.seed);
  const adapter = new BrowserDurableCustodyAdapter(context.database ?? db);
  const now = context.now ?? Date.now;
  const randomId = context.randomId ?? (() => crypto.randomUUID());
  return withWalletProfileLock(
    scope.scopeId,
    async () => {
      const owner = await claimOwner(adapter, scope, now, randomId);
      return withReceiveScope(adapter, scope, owner, now, async () => {
        const operation = await prepareReceiveOperation(input, randomId);
        const binding = createReceiveBinding(scope, operation, wallet);
        await bindReceiveOperation(adapter, scope, ownerAt(owner, now()), binding);
        context.requireCapturedProfile();
        const result = await runReceive("execute", operation.operationId, {
          scope,
          owner,
          custodyOperationId: binding.record.operation.operationId,
          wallet,
          context,
          adapter,
        });
        context.requireCapturedProfile();
        if (result.state === "nonterminal")
          throw new Error("wallet receive did not reach a terminal state");
        return result.proofs;
      });
    },
    context.lockManager,
  );
}

async function prepareReceiveOperation(
  input: BrowserDurableWalletReceiveInput,
  randomId: () => string,
): Promise<DurableWalletReceiveOperation> {
  input.context.requireCapturedProfile();
  let range: OperationCounters | undefined;
  const preview = await input.wallet.prepareSwapToReceive(
    input.token,
    { onCountersReserved: (reserved) => (range = reserved) },
    { type: "deterministic", counter: 0 },
  );
  if (range === undefined) {
    throw new Error("browser wallet receive did not reserve a deterministic output range");
  }
  input.context.requireCapturedProfile();
  return serializeDurableWalletReceiveOperation({
    operationId: `wallet-receive:${randomId()}`,
    mintUrl: input.mintUrl,
    unit: input.unit,
    preview,
    derivationRange: {
      keysetId: range.keysetId,
      counterStart: range.start,
      counterCount: range.count,
    },
  });
}

/** Replay persisted ordinary receives. This never prepares a second output plan. */
export async function recoverBrowserDurableWalletReceives(input: {
  readonly walletForMint: (
    mintUrl: string,
    unit: "sat" | "msat",
  ) => Promise<BrowserDurableWalletReceiveWallet>;
  readonly context: BrowserDurableWalletReceiveContext;
  readonly afterOperationId?: string | null;
}): Promise<{
  pending: number;
  repaired: readonly StoredProof[];
  lastAttemptedOperationId: string | null;
}> {
  const { context } = input;
  const scope = browserWalletScope(context.seed);
  const adapter = new BrowserDurableCustodyAdapter(context.database ?? db);
  const now = context.now ?? Date.now;
  const randomId = context.randomId ?? (() => crypto.randomUUID());
  const record = await nextWalletReceiveRecord(
    adapter,
    scope,
    context,
    input.afterOperationId ?? null,
  );
  if (record === null) return { pending: 0, repaired: [], lastAttemptedOperationId: null };
  const repaired = await withWalletProfileLock(
    scope.scopeId,
    async () => {
      const owner = await claimOwner(adapter, scope, now, randomId);
      return withReceiveScope(adapter, scope, owner, now, async () => {
        try {
          return (await recoverReceiveRecord(input, adapter, scope, owner, record)) ?? [];
        } catch {
          return [];
        }
      });
    },
    context.lockManager,
  );
  const remaining = await nextWalletReceiveRecord(
    adapter,
    scope,
    context,
    record.operation.operationId,
  );
  return {
    pending: remaining === null ? 0 : 1,
    repaired,
    lastAttemptedOperationId: record.operation.operationId,
  };
}

async function nextWalletReceiveRecord(
  adapter: BrowserDurableCustodyAdapter,
  scope: DurableCustodyScope,
  context: BrowserDurableWalletReceiveContext,
  afterOperationId: string | null,
): Promise<DurableCustodyRecord | null> {
  let first: DurableCustodyRecord | null = null;
  let afterSeen = afterOperationId === null;
  let cursor: string | null = null;
  do {
    context.requireCapturedProfile();
    const page = await adapter.listRecoverablePage({
      scope,
      cursor,
      limit: RECOVERY_PAGE_LIMIT,
    });
    for (const record of page.records) {
      if (!isWalletReceiveRecord(record)) continue;
      first ??= record;
      if (afterSeen) return record;
      if (record.operation.operationId === afterOperationId) afterSeen = true;
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return first;
}

async function recoverReceiveRecord(
  input: Parameters<typeof recoverBrowserDurableWalletReceives>[0],
  adapter: BrowserDurableCustodyAdapter,
  scope: DurableCustodyScope,
  owner: DurableCustodyOwnerAuthorization,
  record: DurableCustodyRecord,
): Promise<StoredProof[] | null> {
  const snapshot = await adapter.readOperationSnapshot(scope, record.operation.operationId);
  if (snapshot === null) throw new Error("browser wallet receive operation is missing");
  const operation = receiveOperationFromSnapshot(snapshot.record, snapshot.artifacts);
  const wallet = await input.walletForMint(operation.mintUrl, operation.unit as "sat" | "msat");
  input.context.requireCapturedProfile();
  const result = await runReceive("recover", operation.operationId, {
    scope,
    owner,
    custodyOperationId: record.operation.operationId,
    wallet,
    context: input.context,
    adapter,
  });
  input.context.requireCapturedProfile();
  return result.state === "nonterminal"
    ? null
    : toLegacyProofs(result.proofs, operation.mintUrl, operation.unit);
}

/** Read one stable page of current canonical proofs for legacy-cache repair. */
export async function readBrowserCurrentCustodyProofPage(input: {
  readonly context: BrowserDurableWalletReceiveContext;
  readonly selectability: "selectable" | "locked";
  readonly cursor: string | null;
}): Promise<{ proofs: readonly StoredProof[]; nextCursor: string | null }> {
  const scope = browserWalletScope(input.context.seed);
  const database = input.context.database ?? db;
  const rows = await database.custodyProofs
    .where("[scopeId+selectability+proofId]")
    .between(
      [scope.scopeId, input.selectability, input.cursor ?? PROOF_ID_MIN],
      [scope.scopeId, input.selectability, PROOF_ID_MAX],
      input.cursor === null,
      true,
    )
    .limit(RECOVERY_PAGE_LIMIT)
    .toArray();
  input.context.requireCapturedProfile();
  const decoded = rows.map(decodeBrowserCustodyProofRow);
  const proofs = decoded.map(toLegacyProofRow);
  const nextCursor = rows.length < RECOVERY_PAGE_LIMIT ? null : decoded.at(-1)!.proofId;
  return { proofs, nextCursor };
}

function createReceiveBinding(
  scope: DurableCustodyScope,
  operation: DurableWalletReceiveOperation,
  wallet: BrowserDurableWalletReceiveWallet,
) {
  const custodyOperation = toDurableCustodyProofOperationInput(operation);
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation: custodyOperation,
    keysets: receiveKeysets(custodyOperation, wallet),
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

async function bindReceiveOperation(
  adapter: BrowserDurableCustodyAdapter,
  scope: DurableCustodyScope,
  owner: DurableCustodyOwnerAuthorization,
  binding: ReturnType<typeof createReceiveBinding>,
): Promise<void> {
  await adapter.transact(
    {
      scope,
      owner,
      operationRows: [
        { operationId: binding.record.operation.operationId, expectedRevision: null },
      ],
    },
    (transaction) =>
      bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
  );
}

async function runReceive(
  mode: "execute" | "recover",
  operationId: string,
  runtime: BrowserReceiveRuntime,
) {
  return runDurableWalletReceiveOperation({
    mode,
    operationId,
    wallet: runtime.wallet,
    store: receiveOperationStore(runtime),
    restoreExactOutputs: (restore) => restoreExactReceiveOutputs(runtime.wallet, restore),
  });
}

function receiveOperationStore(runtime: BrowserReceiveRuntime) {
  return {
    loadOperation: (operationId: string) => loadReceiveOperation(runtime, operationId),
    persistCompletedResult: (input: {
      operation: DurableWalletReceiveOperation;
      result: Readonly<Record<string, readonly Proof[]>>;
    }) => persistReceiveResult(runtime, input.operation, input.result),
  };
}

async function loadReceiveOperation(runtime: BrowserReceiveRuntime, requestedOperationId: string) {
  runtime.context.requireCapturedProfile();
  const snapshot = await runtime.adapter.readOperationSnapshot(
    runtime.scope,
    runtime.custodyOperationId,
  );
  runtime.context.requireCapturedProfile();
  if (snapshot === null) return null;
  const operation = receiveOperationFromSnapshot(snapshot.record, snapshot.artifacts);
  if (operation.operationId !== requestedOperationId) {
    throw new Error("browser wallet receive operation identity is foreign");
  }
  if (snapshot.record.operation.result.state === "none") {
    return { operation, state: "prepared" as const, result: null };
  }
  const proofs =
    snapshot.record.operation.result.state === "applied"
      ? verifiedReceiveProofs(snapshot.record, snapshot.artifacts)
      : await applyStagedReceive({
          ...runtime,
          record: snapshot.record,
          operation,
          artifacts: snapshot.artifacts,
        });
  return { operation, state: "completed" as const, result: { receive: proofs } };
}

async function persistReceiveResult(
  runtime: BrowserReceiveRuntime,
  operation: DurableWalletReceiveOperation,
  result: Readonly<Record<string, readonly Proof[]>>,
) {
  runtime.context.requireCapturedProfile();
  const snapshot = await runtime.adapter.readOperationSnapshot(
    runtime.scope,
    runtime.custodyOperationId,
  );
  if (snapshot === null) throw new Error("browser wallet receive operation is missing");
  const prepared = prepareDurableCustodyVerifiedMintResult({
    record: snapshot.record,
    exactAuthority: exactAuthority(snapshot.record, snapshot.artifacts),
    result,
  });
  if (snapshot.record.operation.result.state === "none") {
    await stageReceiveResult(runtime, snapshot.record, prepared);
  }
  const staged = await runtime.adapter.readOperation(runtime.scope, runtime.custodyOperationId);
  if (staged === null) throw new Error("browser wallet receive staged operation is missing");
  if (staged.operation.result.state !== "applied") {
    await applyStagedReceive({ ...runtime, record: staged, operation });
  }
  return "completed" as const;
}

async function stageReceiveResult(
  runtime: BrowserReceiveRuntime,
  record: DurableCustodyRecord,
  prepared: ReturnType<typeof prepareDurableCustodyVerifiedMintResult>,
): Promise<void> {
  const authorization = ownerAt(runtime.owner, (runtime.context.now ?? Date.now)());
  await runtime.adapter.transact(selection(runtime.scope, authorization, record), (transaction) =>
    stageDurableCustodyPreparedMintResult({
      transaction,
      record,
      prepared,
      authorization,
    }),
  );
}

function verifiedReceiveProofs(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
): Proof[] {
  return readDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: exactAuthority(record, artifacts),
    exactResult: exactResult(record, artifacts),
  }).proofs.map(({ proof }) => proof);
}

async function applyStagedReceive(
  input: BrowserReceiveRuntime & {
    record: DurableCustodyRecord;
    operation: DurableWalletReceiveOperation;
    artifacts?: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[];
  },
): Promise<Proof[]> {
  const snapshot = input.artifacts
    ? { record: input.record, artifacts: input.artifacts }
    : await input.adapter.readOperationSnapshot(input.scope, input.record.operation.operationId);
  if (snapshot === null || snapshot.record.operation.result.state === "none") {
    throw new Error("browser wallet receive result is not staged");
  }
  if (snapshot.record.operation.result.state === "applied") {
    return verifiedReceiveProofs(snapshot.record, snapshot.artifacts);
  }
  const verified = readDurableCustodyVerifiedMintResult({
    record: snapshot.record,
    exactAuthority: exactAuthority(snapshot.record, snapshot.artifacts),
    exactResult: exactResult(snapshot.record, snapshot.artifacts),
  });
  const successors = createReceiveSuccessors(input, verified.proofs);
  const authorization = ownerAt(input.owner, (input.context.now ?? Date.now)());
  await input.adapter.transact(
    selection(input.scope, authorization, snapshot.record),
    (transaction) =>
      transaction.applyVerifiedResult({
        operationId: snapshot.record.operation.operationId,
        expectedRevision: snapshot.record.revision,
        authorization,
        outputPlanFingerprint: snapshot.record.operation.outputPlan.outputPlanFingerprint,
        resultHandle: snapshot.record.operation.result.resultHandle!,
        resultFingerprint: snapshot.record.operation.result.resultFingerprint!,
        successorAdmission: {
          scopeId: input.scope.scopeId,
          operationId: snapshot.record.operation.operationId,
          admissionId: `wallet-receive:${snapshot.record.operation.result.resultFingerprint!}`,
          proofRows: successors.map(({ proof, expectedRevision }) => ({
            proofId: proof.proofId,
            expectedRevision,
            admittedRevision: proof.revision,
          })),
        },
      }),
    {
      successorProofs: { [snapshot.record.operation.operationId]: successors },
      ...(input.context.injectFault === undefined
        ? {}
        : { injectFault: input.context.injectFault }),
    },
  );
  return verified.proofs.map(({ proof }) => proof);
}

function createReceiveSuccessors(
  input: Pick<BrowserReceiveRuntime, "scope" | "context"> & {
    operation: DurableWalletReceiveOperation;
  },
  proofs: ReturnType<typeof readDurableCustodyVerifiedMintResult>["proofs"],
) {
  const observedAtMs = (input.context.now ?? Date.now)();
  const locators = receiveProofLocators(input.operation, proofs, input.context.seed);
  return proofs.map(({ proof }) => ({
    proof: createBrowserCustodyProofRow({
      scopeId: input.scope.scopeId,
      normalizedMint: input.operation.mintUrl,
      unit: input.operation.unit as "sat" | "msat",
      proof,
      asset: { kind: "regular" },
      receivedAtMs: observedAtMs,
    }),
    expectedRevision: null,
    derivationLocator: requiredReceiveProofLocator(locators, proof.secret),
  }));
}

function receiveProofLocators(
  operation: DurableWalletReceiveOperation,
  proofs: readonly { readonly proof: Proof }[],
  seed: Uint8Array,
) {
  const range = operation.derivationRange;
  if (range === null) throw new Error("browser wallet receive derivation range is missing");
  const located = locateSeedDerivedProofLineage({
    seed,
    keysetId: range.keysetId,
    counterStart: range.counterStart,
    counterCount: range.counterCount,
    proofs: proofs.map(({ proof }) => proof),
  });
  return new Map(located.map(({ secret, ...locator }) => [secret, locator]));
}

function requiredReceiveProofLocator(
  locators: ReturnType<typeof receiveProofLocators>,
  secret: string,
) {
  const locator = locators.get(secret);
  if (locator === undefined)
    throw new Error("browser wallet receive derivation locator is missing");
  return locator;
}

function selection(
  scope: DurableCustodyScope,
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

function receiveOperationFromSnapshot(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
): DurableWalletReceiveOperation {
  const authority = assertDurableCustodyMintOperationAuthority(
    record,
    exactAuthority(record, artifacts),
  );
  const operation = requireDurableWalletOperationFromCustody(authority.operation);
  if (
    operation.kind !== "wallet-receive" ||
    operation.operationId !== record.operation.retainedOperationKey ||
    operation.mintUrl !== record.operation.custodyContext.normalizedMint
  ) {
    throw new Error("browser wallet receive authority is foreign");
  }
  return operation;
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

function exactResult(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
) {
  const reference = record.operation.result.exactResult;
  if (reference === null) throw new Error("browser wallet receive result is missing");
  return requiredArtifact(artifacts, reference.artifactId);
}

function requiredArtifact(
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
  artifactId: string,
) {
  const artifact = artifacts.find(({ reference }) => reference.artifactId === artifactId)?.artifact;
  if (artifact === undefined) throw new Error("browser wallet receive artifact is missing");
  return artifact as ReturnType<typeof prepareDurableCustodyExactArtifact>;
}

function receiveKeysets(
  operation: DurableCustodyProofOperationInput,
  wallet: BrowserDurableWalletReceiveWallet,
) {
  const ids = new Set([
    ...operation.inputs.map(({ id }) => id),
    ...Object.values(operation.outputs).flatMap((outputs) =>
      outputs.map(({ blindedMessage }) => blindedMessage.id),
    ),
  ]);
  return [...ids].map((id) => {
    if (!id || isBlsKeyset(id)) throw new Error("browser wallet receive supports only V2 keysets");
    const keyset = wallet.getKeyset(id);
    if (
      keyset.id !== id ||
      keyset.unit !== operation.metadata?.unit ||
      !keyset.verify() ||
      keyset.conditional
    ) {
      throw new Error("browser wallet receive keyset is invalid");
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

async function restoreExactReceiveOutputs(
  wallet: BrowserDurableWalletReceiveWallet,
  input: {
    readonly outputs: readonly {
      blindedMessage: { amount: string; id: string; B_: string };
      blindingFactor: string;
      secret: string;
      ephemeralE: string | null;
    }[];
  },
): Promise<Readonly<Record<string, readonly Proof[]>>> {
  const outputs = input.outputs.map((output) =>
    deserializeDurableCustodyOutput({
      blindedMessage: output.blindedMessage,
      blindingFactor: output.blindingFactor,
      secret: output.secret,
      ...(output.ephemeralE === null ? {} : { ephemeralE: output.ephemeralE }),
    }),
  );
  const response = await wallet.mint.restore({
    outputs: outputs.map(({ blindedMessage }) => blindedMessage),
  });
  if (response.outputs.length !== outputs.length || response.signatures.length !== outputs.length) {
    throw new Error("browser wallet receive restore response is incomplete");
  }
  const signatures = new Map(
    response.outputs.map((output, index) => [output.B_, response.signatures[index]]),
  );
  if (signatures.size !== outputs.length)
    throw new Error("browser wallet receive restore response is foreign");
  const proofs = outputs.map((output) => {
    const signature = signatures.get(output.blindedMessage.B_);
    if (signature === undefined)
      throw new Error("browser wallet receive restore output is missing");
    const keyset = wallet.getKeyset(output.blindedMessage.id);
    if (!keyset.verify()) throw new Error("browser wallet receive restore keyset is invalid");
    return output.toProof(signature as never, keyset as never);
  });
  return { receive: proofs };
}

function isWalletReceiveRecord(record: DurableCustodyRecord): boolean {
  return (
    record.operation.semanticKind === "generic-receive" &&
    record.operation.retainedOperationKey.startsWith("wallet-receive:")
  );
}

function toLegacyProofs(proofs: readonly Proof[], mintUrl: string, unit: string): StoredProof[] {
  if (unit !== "sat" && unit !== "msat") throw new Error("browser wallet receive unit is invalid");
  return proofs.map((proof) => ({
    ...proof,
    mintUrl,
    baseAsset: "sat",
    unit,
  }));
}

function toLegacyProofRow(row: ReturnType<typeof decodeBrowserCustodyProofRow>): StoredProof {
  const { proof: material } = decodeDurableCustodyProofMaterialRecord(row);
  const proof = deserializeDurableCustodyProofArtifact({ schemaVersion: 1, ...material });
  return {
    ...proof,
    mintUrl: row.normalizedMint,
    baseAsset: row.baseAsset,
    unit: row.unit,
    ...(row.conditionId === null ? {} : { conditionId: row.conditionId }),
    ...(row.outcomeCollection === null ? {} : { outcomeCollection: row.outcomeCollection }),
    ...(row.reservationOperationId === null ? {} : { reservedBy: row.reservationOperationId }),
  };
}

async function claimOwner(
  adapter: BrowserDurableCustodyAdapter,
  scope: DurableCustodyScope,
  now: () => number,
  randomId: () => string,
): Promise<DurableCustodyOwnerAuthorization> {
  const observedAtMs = now();
  return adapter.claimScope(scope, {
    incarnationId: `browser-wallet-receive:${randomId()}`,
    observedAtMs,
    leaseExpiresAtMs: observedAtMs + SCOPE_LEASE_MS,
  });
}

async function withReceiveScope<T>(
  adapter: BrowserDurableCustodyAdapter,
  scope: DurableCustodyScope,
  owner: DurableCustodyOwnerAuthorization,
  now: () => number,
  action: () => Promise<T>,
): Promise<T> {
  let actionFailed = false;
  try {
    return await action();
  } catch (error) {
    actionFailed = true;
    throw error;
  } finally {
    try {
      await adapter.releaseScope(scope, ownerAt(owner, now()));
    } catch (error) {
      if (!actionFailed) throw error;
    }
  }
}

function ownerAt(
  owner: DurableCustodyOwnerAuthorization,
  observedAtMs: number,
): DurableCustodyOwnerAuthorization {
  return { ...owner, observedAtMs };
}
