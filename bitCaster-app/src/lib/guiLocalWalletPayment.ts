import {
  restoreOutputGroups as restoreRegularSplitOutputGroups,
  splitRegularProofsWithOperation,
  type RegularSplitWallet,
} from "@bitcaster/client-sdk/ctfSplit";
import {
  parseMarketBaseAsset,
  type CashuProofUnit,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import type { components } from "@/generated/api";
import { encodeToken, getWalletForUnit } from "@/lib/cashu";
import {
  blockPendingEcashDepositUnderLock,
  completeCreditedEcashDepositUnderLock,
  createPendingEcashDepositUnderLock,
  deferPendingEcashDepositRetryUnderLock,
  depositSplitOperationId,
  findPendingEcashDepositBySplitOperationUnderLock,
  getPendingEcashDepositUnderLock,
  getPendingEcashDepositRecoverySummaryUnderLock,
  listPendingEcashDepositsUnderLock,
  recordPendingEcashDepositErrorUnderLock,
  recordPendingEcashDepositRemoteStateUnderLock,
  recordPendingEcashDepositSplitUnderLock,
  requirePendingEcashDepositRemoteAuthorityUnderLock,
  type PendingEcashDepositRecoveryCursor,
  type PendingEcashDepositRemoteState,
  type PendingEcashDepositRequest,
  type PendingLocalWalletPaymentRow,
  type ReservedPendingEcashDeposit,
} from "@/lib/pendingLocalWalletPayments";
import {
  releaseGuiCustodyAuthority,
  withGuiCustodyProfileLockForWallet,
} from "@/stores/gui-custody-authority";
import { createCapturedGuiWalletProofOperationStore } from "@/stores/gui-wallet-proof-operation-store";
import type { GuiWalletLockContext } from "@/stores/gui-wallet-lock";
import {
  currentGuiWalletId,
  getBoundedUnitProofsForAmountUnderLock,
} from "@/stores/proof-db";
import {
  decodePendingEcashDepositToken,
  PendingEcashDepositAuthorityError,
  pendingPaymentError,
  samePendingEcashDepositSerializedToken,
  samePaymentProofSet,
  serializePendingEcashDepositToken,
} from "@/stores/pending-local-wallet-payment-model";
import { useWalletStore } from "@/stores/wallet";

export type GuiEcashDepositState = components["schemas"]["DepositState"];

export interface GuiEcashDepositSubmission {
  depositId: string;
  token: string;
  request: PendingEcashDepositRequest;
}

export interface GuiEcashDepositStatusRequest {
  depositId: string;
  request: PendingEcashDepositRequest;
}

export interface GuiEcashDepositStatusSnapshot {
  depositId: string;
  conditionId: string;
  amountSubunits: number;
  method: string;
  state: string;
}

export interface GuiEcashDepositSubmitter {
  currentFundingIdentity(): string;
  submit(input: GuiEcashDepositSubmission): Promise<{
    depositId: string;
    state: string;
  }>;
}

export interface GuiEcashDepositStatusReader {
  getStatus(
    input: GuiEcashDepositStatusRequest,
  ): Promise<GuiEcashDepositStatusSnapshot | null>;
}

export interface GuiEcashDepositRemote
  extends GuiEcashDepositSubmitter, GuiEcashDepositStatusReader {}

export type GuiLocalWalletPaymentResult =
  | { status: "completed"; depositId: string }
  | { status: "insufficient" }
  | {
      status: "pending";
      depositId: string;
      remoteState: PendingEcashDepositRemoteState;
    }
  | { status: "transport-ambiguous"; depositId: string; error: string };

export interface GuiLocalWalletPaymentInput {
  mintUrl: string;
  amountSubunits: number;
  baseAsset: string;
  unit: CashuProofUnit;
  request: {
    conditionId: string;
    divisibility: number;
    fundAmm: boolean;
    creatorPubkey: string | null;
    fundingIdentity: string;
  };
  remote: GuiEcashDepositRemote;
}

export interface GuiEcashDepositRecoveryResult {
  remaining: PendingLocalWalletPaymentRow[];
  hasMore: boolean;
  nextCursor: PendingEcashDepositRecoveryCursor | null;
  nextAttemptAt: number | null;
  blocked: Array<{ depositId: string; error: string }>;
}

type ReservedPendingEcashDepositRow = PendingLocalWalletPaymentRow &
  ReservedPendingEcashDeposit;

export async function executeGuiLocalWalletPayment(
  input: GuiLocalWalletPaymentInput,
): Promise<GuiLocalWalletPaymentResult> {
  await useWalletStore.getState().ensureImplicitWallet();
  const walletId = currentGuiWalletId();
  const baseAsset = requireCanonicalBaseAsset(input.baseAsset);
  const preparation = await withCapturedWalletLock(walletId, async (lock) => {
    const proofs = await getBoundedUnitProofsForAmountUnderLock(
      lock,
      input.mintUrl,
      {
        unit: input.unit,
        minimumAmount: input.amountSubunits,
      },
    );
    if (totalProofAmount(proofs) < input.amountSubunits) return null;
    const depositId = crypto.randomUUID();
    const timestamp = Date.now();
    const prepared = await createPendingEcashDepositUnderLock(lock, {
      depositId,
      splitOperationId: depositSplitOperationId(depositId),
      phase: "prepared",
      request: {
        ...input.request,
        mintUrl: input.mintUrl,
        amountSubunits: input.amountSubunits,
        baseAsset,
        unit: input.unit,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { prepared, proofs };
  });
  if (!preparation) return { status: "insufficient" };
  const reserved = await ensureExactDepositSplit(
    walletId,
    preparation.prepared,
    preparation.proofs,
  );
  return submitReservedDeposit(walletId, reserved, input.remote);
}

/**
 * Bounded startup pass. It performs no background polling: each invocation
 * checks and retries each selected deposit at most once.
 */
export async function reconcileGuiEcashDeposits(
  remote: GuiEcashDepositRemote,
  cursor: PendingEcashDepositRecoveryCursor | null = null,
): Promise<GuiEcashDepositRecoveryResult> {
  await useWalletStore.getState().ensureImplicitWallet();
  const walletId = currentGuiWalletId();
  const page = await withCapturedWalletLock(walletId, (lock) =>
    listPendingEcashDepositsUnderLock(lock, cursor),
  );
  const remaining: PendingLocalWalletPaymentRow[] = [];
  const blockedDuringPage: Array<{ depositId: string; error: string }> = [];
  for (const row of page.records) {
    try {
      const result = await retryOneDeposit(walletId, row, remote);
      if (result.status !== "completed") remaining.push(row);
    } catch (error) {
      assertCurrentWallet(walletId);
      const blocked = await persistSplitRecoveryFailure(walletId, row, error);
      if (blocked) blockedDuringPage.push(blocked);
      remaining.push(row);
    }
  }
  const summary = await withCapturedWalletLock(
    walletId,
    getPendingEcashDepositRecoverySummaryUnderLock,
  );
  return {
    remaining,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    nextAttemptAt: summary.nextAttemptAt,
    blocked: mergeBlockedDeposits(summary.blocked, blockedDuringPage),
  };
}

export async function observeGuiEcashDeposit(
  depositId: string,
  remote: GuiEcashDepositStatusReader,
): Promise<GuiLocalWalletPaymentResult | null> {
  await useWalletStore.getState().ensureImplicitWallet();
  const walletId = currentGuiWalletId();
  const row = await withCapturedWalletLock(walletId, (lock) =>
    getRequiredPendingDeposit(lock, depositId),
  );
  return observeOneDeposit(walletId, row, remote);
}

export async function retryGuiEcashDeposit(
  depositId: string,
  remote: GuiEcashDepositRemote,
): Promise<GuiLocalWalletPaymentResult> {
  await useWalletStore.getState().ensureImplicitWallet();
  const walletId = currentGuiWalletId();
  const row = await withCapturedWalletLock(walletId, (lock) =>
    getRequiredPendingDeposit(lock, depositId),
  );
  return retryOneDeposit(walletId, row, remote);
}

/** Resumes one exact persisted split while mint I/O runs outside Web Locks. */
export async function recoverGuiEcashDepositSplit(
  walletId: string,
  splitOperationId: string,
): Promise<void> {
  const row = await withCapturedWalletLock(walletId, async (lock) => {
    const pending = await findPendingEcashDepositBySplitOperationUnderLock(
      lock,
      splitOperationId,
    );
    if (!pending) {
      throw new Error("Regular split has no pending ecash deposit pre-intent");
    }
    return pending;
  });
  await ensureExactDepositSplit(walletId, row);
}

async function retryOneDeposit(
  walletId: string,
  observed: PendingLocalWalletPaymentRow,
  remote: GuiEcashDepositRemote,
): Promise<GuiLocalWalletPaymentResult> {
  const reserved = await reserveExactDeposit(walletId, observed);
  let status: GuiEcashDepositState | null;
  try {
    status = await readExactDepositStatus(walletId, reserved, remote);
  } catch (error) {
    rethrowPendingAuthorityError(error);
    return transportAmbiguousResult(walletId, reserved, error, true);
  }
  if (status === "credited") {
    return completeCreditedDeposit(walletId, reserved);
  }
  if (status !== null) {
    await mutateExactReservedDeposit(walletId, reserved, (lock, current) =>
      recordPendingEcashDepositRemoteStateUnderLock(
        lock,
        current.depositId,
        status,
      ),
    );
  }
  return submitReservedDeposit(walletId, reserved, remote);
}

async function observeOneDeposit(
  walletId: string,
  observed: PendingLocalWalletPaymentRow,
  remote: GuiEcashDepositStatusReader,
): Promise<GuiLocalWalletPaymentResult | null> {
  const reserved = await reserveExactDeposit(walletId, observed);
  let status: GuiEcashDepositState | null;
  try {
    status = await readExactDepositStatus(walletId, reserved, remote);
  } catch (error) {
    rethrowPendingAuthorityError(error);
    return transportAmbiguousResult(walletId, reserved, error);
  }
  if (status === null) return null;
  if (status === "credited") {
    return completeCreditedDeposit(walletId, reserved);
  }
  await mutateExactReservedDeposit(walletId, reserved, (lock, current) =>
    recordPendingEcashDepositRemoteStateUnderLock(
      lock,
      current.depositId,
      status,
    ),
  );
  return pendingResult(reserved.depositId, status);
}

async function ensureExactDepositSplit(
  walletId: string,
  row: PendingLocalWalletPaymentRow,
  freshProofs?: Awaited<
    ReturnType<typeof getBoundedUnitProofsForAmountUnderLock>
  >,
): Promise<ReservedPendingEcashDepositRow> {
  if (row.phase === "reserved") return row;
  const store = createCapturedGuiWalletProofOperationStore(walletId);
  const existing = await store.getProofOperation(row.splitOperationId);
  const proofs = existing
    ? []
    : (freshProofs ?? (await selectExactDepositProofs(walletId, row)));
  if (!existing && totalProofAmount(proofs) < row.request.amountSubunits) {
    throw new Error("Insufficient spendable proofs for pending ecash deposit");
  }
  assertCurrentWallet(walletId);
  const wallet = await getWalletForUnit(row.request.mintUrl, row.request.unit, {
    expectedWalletId: walletId,
  });
  assertCurrentWallet(walletId);
  const split = await splitRegularProofsWithOperation({
    mintUrl: row.request.mintUrl,
    baseAsset: row.request.baseAsset,
    unit: row.request.unit,
    operationId: row.splitOperationId,
    wallet: fenceRegularSplitWallet(walletId, wallet),
    proofs,
    amountSubunits: row.request.amountSubunits,
    ...(existing
      ? { resumeInputAuthority: "persisted-operation" as const }
      : {}),
    resultDispositions: {
      send: {
        kind: "wallet",
        asset: "regular",
        reservedBy: row.depositId,
      },
      keep: { kind: "wallet", asset: "regular", reservedBy: null },
    },
    proofOperationStore: store,
    restoreOutputGroups: (mintUrl, outputs) =>
      fenceWalletAwait(walletId, () =>
        restoreRegularSplitOutputGroups(mintUrl, outputs),
      ),
  });
  const serializedToken = serializePendingEcashDepositToken(
    encodeToken(split.send, row.request.mintUrl, row.request.unit),
  );
  return withCapturedWalletLock(walletId, async (lock) => {
    const current = await getRequiredPendingDeposit(lock, row.depositId);
    assertSameDepositAuthority(row, current);
    if (current.phase === "reserved") {
      if (!samePaymentProofSet(current.sendProofs, split.send)) {
        throw new Error("Pending ecash deposit split result changed");
      }
      return current;
    }
    return recordPendingEcashDepositSplitUnderLock(
      lock,
      current.depositId,
      split.send,
      serializedToken,
    );
  });
}

async function selectExactDepositProofs(
  walletId: string,
  expected: PendingLocalWalletPaymentRow,
): Promise<Awaited<ReturnType<typeof getBoundedUnitProofsForAmountUnderLock>>> {
  return withCapturedWalletLock(walletId, async (lock) => {
    const current = await getRequiredPendingDeposit(lock, expected.depositId);
    assertSameDepositAuthority(expected, current);
    if (current.phase !== "prepared") {
      throw new Error("Pending ecash deposit already has split authority");
    }
    return getBoundedUnitProofsForAmountUnderLock(
      lock,
      current.request.mintUrl,
      {
        unit: current.request.unit,
        minimumAmount: current.request.amountSubunits,
      },
    );
  });
}

function fenceRegularSplitWallet(
  expectedWalletId: string,
  wallet: RegularSplitWallet,
): RegularSplitWallet {
  const fenced: RegularSplitWallet = {};
  if (wallet.prepareSwapToSend) {
    fenced.prepareSwapToSend = (...args) =>
      fenceWalletAwait(expectedWalletId, () =>
        wallet.prepareSwapToSend!(...args),
      );
  }
  if (wallet.completeSwap) {
    fenced.completeSwap = (preview) =>
      fenceWalletAwait(expectedWalletId, () => wallet.completeSwap!(preview));
  }
  if (wallet.checkProofsStates) {
    fenced.checkProofsStates = (proofs) =>
      fenceWalletAwait(expectedWalletId, () =>
        wallet.checkProofsStates!(proofs),
      );
  }
  return fenced;
}

async function submitReservedDeposit(
  walletId: string,
  row: ReservedPendingEcashDepositRow,
  remote: GuiEcashDepositRemote,
): Promise<GuiLocalWalletPaymentResult> {
  let state: GuiEcashDepositState;
  try {
    state = await submitExactDeposit(walletId, row, remote);
    if (state === "credited") {
      const confirmed = await readExactDepositStatus(walletId, row, remote);
      if (confirmed !== "credited") {
        throw new Error("Credited ecash deposit POST was not confirmed by GET");
      }
    }
  } catch (error) {
    rethrowPendingAuthorityError(error);
    return transportAmbiguousResult(walletId, row, error, true);
  }
  if (state === "credited") return completeCreditedDeposit(walletId, row);
  await mutateExactReservedDeposit(walletId, row, (lock, current) =>
    deferPendingEcashDepositRetryUnderLock(lock, current.depositId, {
      remoteState: state,
    }),
  );
  return pendingResult(row.depositId, state);
}

async function submitExactDeposit(
  walletId: string,
  row: ReservedPendingEcashDepositRow,
  remote: GuiEcashDepositSubmitter,
): Promise<GuiEcashDepositState> {
  const current = await requireExactRemoteAuthority(walletId, row);
  assertCurrentFundingIdentity(remote, current.request.fundingIdentity);
  const response = await remote.submit({
    depositId: current.depositId,
    token: decodePendingEcashDepositToken(current.serializedToken),
    request: current.request,
  });
  if (
    typeof response !== "object" ||
    response === null ||
    response.depositId !== current.depositId
  ) {
    throw new Error(
      "Ecash deposit POST binding conflicts with local authority",
    );
  }
  return requireDepositState(response.state, "POST");
}

function assertCurrentFundingIdentity(
  remote: GuiEcashDepositSubmitter,
  expected: string,
): void {
  if (remote.currentFundingIdentity() !== expected) {
    throw new Error("Pending ecash deposit authentication identity changed");
  }
}

async function getRequiredPendingDeposit(
  lock: GuiWalletLockContext,
  depositId: string,
): Promise<PendingLocalWalletPaymentRow> {
  const row = await getPendingEcashDepositUnderLock(lock, depositId);
  if (!row) throw new Error("Pending ecash deposit is missing");
  return row;
}

async function readExactDepositStatus(
  walletId: string,
  row: ReservedPendingEcashDepositRow,
  remote: GuiEcashDepositStatusReader,
): Promise<GuiEcashDepositState | null> {
  const current = await requireExactRemoteAuthority(walletId, row);
  const snapshot = await remote.getStatus({
    depositId: current.depositId,
    request: current.request,
  });
  if (snapshot === null) return null;
  if (
    typeof snapshot !== "object" ||
    snapshot.depositId !== current.depositId ||
    snapshot.conditionId !== current.request.conditionId ||
    snapshot.amountSubunits !== current.request.amountSubunits ||
    snapshot.method !== "ecash"
  ) {
    throw new Error(
      "Ecash deposit status binding conflicts with local authority",
    );
  }
  return requireDepositState(snapshot.state, "status");
}

function requireDepositState(
  state: unknown,
  source: "POST" | "status",
): GuiEcashDepositState {
  switch (state) {
    case "requested":
    case "paid":
    case "credited":
    case "failed":
      return state;
    default:
      throw new Error(`Ecash deposit ${source} state is invalid`);
  }
}

async function completeCreditedDeposit(
  walletId: string,
  row: ReservedPendingEcashDepositRow,
): Promise<GuiLocalWalletPaymentResult> {
  await mutateExactReservedDeposit(walletId, row, (lock, current) =>
    completeCreditedEcashDepositUnderLock(lock, current.depositId),
  );
  return { status: "completed", depositId: row.depositId };
}

function pendingResult(
  depositId: string,
  remoteState: PendingEcashDepositRemoteState,
): GuiLocalWalletPaymentResult {
  return { status: "pending", depositId, remoteState };
}

async function transportAmbiguousResult(
  walletId: string,
  row: ReservedPendingEcashDepositRow,
  error: unknown,
  deferRetry = false,
): Promise<GuiLocalWalletPaymentResult> {
  await mutateExactReservedDeposit(walletId, row, (lock, current) =>
    deferRetry
      ? deferPendingEcashDepositRetryUnderLock(lock, current.depositId, {
          error,
        })
      : recordPendingEcashDepositErrorUnderLock(lock, current.depositId, error),
  );
  return {
    status: "transport-ambiguous",
    depositId: row.depositId,
    error: pendingPaymentError(error),
  };
}

async function reserveExactDeposit(
  walletId: string,
  observed: PendingLocalWalletPaymentRow,
): Promise<ReservedPendingEcashDepositRow> {
  const current = await withCapturedWalletLock(walletId, async (lock) => {
    const current = await getRequiredPendingDeposit(lock, observed.depositId);
    assertSameDepositAuthority(observed, current);
    return current;
  });
  return ensureExactDepositSplit(walletId, current);
}

async function requireExactRemoteAuthority(
  walletId: string,
  expected: ReservedPendingEcashDepositRow,
): Promise<ReservedPendingEcashDepositRow> {
  return withCapturedWalletLock(walletId, async (lock) => {
    const current = await requirePendingEcashDepositRemoteAuthorityUnderLock(
      lock,
      expected,
    );
    assertSameDepositAuthority(expected, current);
    return current;
  });
}

async function persistSplitRecoveryFailure(
  walletId: string,
  expected: PendingLocalWalletPaymentRow,
  error: unknown,
): Promise<{ depositId: string; error: string } | null> {
  return withCapturedWalletLock(walletId, async (lock) => {
    const current = await getRequiredPendingDeposit(lock, expected.depositId);
    assertSameDepositAuthority(expected, current);
    if (isPendingAuthorityError(error)) {
      await blockPendingEcashDepositUnderLock(lock, current.depositId, error);
      return {
        depositId: current.depositId,
        error: pendingPaymentError(error),
      };
    }
    await deferPendingEcashDepositRetryUnderLock(lock, current.depositId, {
      error,
    });
    return null;
  });
}

function mergeBlockedDeposits(
  persisted: Array<{ depositId: string; error: string }>,
  current: Array<{ depositId: string; error: string }>,
): Array<{ depositId: string; error: string }> {
  const byId = new Map(persisted.map((row) => [row.depositId, row]));
  current.forEach((row) => byId.set(row.depositId, row));
  return [...byId.values()];
}

function isPendingAuthorityError(
  error: unknown,
): error is PendingEcashDepositAuthorityError {
  return (
    error instanceof PendingEcashDepositAuthorityError ||
    (error instanceof Error &&
      error.name === "PendingEcashDepositAuthorityError")
  );
}

function rethrowPendingAuthorityError(error: unknown): void {
  if (isPendingAuthorityError(error)) throw error;
}

async function fenceWalletAwait<T>(
  expectedWalletId: string,
  action: () => Promise<T>,
): Promise<T> {
  assertCurrentWallet(expectedWalletId);
  const result = await action();
  assertCurrentWallet(expectedWalletId);
  return result;
}

async function mutateExactReservedDeposit<T>(
  walletId: string,
  expected: ReservedPendingEcashDepositRow,
  mutate: (
    lock: GuiWalletLockContext,
    current: ReservedPendingEcashDepositRow,
  ) => Promise<T>,
): Promise<T> {
  return withCapturedWalletLock(walletId, async (lock) => {
    const current = await getRequiredPendingDeposit(lock, expected.depositId);
    assertSameDepositAuthority(expected, current);
    if (current.phase !== "reserved") {
      throw new Error("Pending ecash deposit lost reserved proof authority");
    }
    return mutate(lock, current);
  });
}

async function withCapturedWalletLock<T>(
  walletId: string,
  action: (lock: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  return withGuiCustodyProfileLockForWallet(walletId, async (context, lock) => {
    try {
      return await action(lock);
    } finally {
      await releaseGuiCustodyAuthority(lock, context.scope);
    }
  });
}

function assertSameDepositAuthority(
  expected: PendingLocalWalletPaymentRow,
  current: PendingLocalWalletPaymentRow,
): void {
  if (
    expected.walletId !== current.walletId ||
    expected.depositId !== current.depositId ||
    expected.splitOperationId !== current.splitOperationId ||
    !sameDepositRequest(expected.request, current.request) ||
    (expected.phase === "reserved" &&
      (current.phase !== "reserved" ||
        !samePaymentProofSet(expected.sendProofs, current.sendProofs) ||
        !samePendingEcashDepositSerializedToken(
          expected.serializedToken,
          current.serializedToken,
        )))
  ) {
    throw new Error("Pending ecash deposit durable authority changed");
  }
}

function sameDepositRequest(
  left: PendingEcashDepositRequest,
  right: PendingEcashDepositRequest,
): boolean {
  return (
    left.conditionId === right.conditionId &&
    left.mintUrl === right.mintUrl &&
    left.amountSubunits === right.amountSubunits &&
    left.baseAsset === right.baseAsset &&
    left.unit === right.unit &&
    left.divisibility === right.divisibility &&
    left.fundAmm === right.fundAmm &&
    left.creatorPubkey === right.creatorPubkey &&
    left.fundingIdentity === right.fundingIdentity
  );
}

function assertCurrentWallet(expectedWalletId: string): void {
  if (currentGuiWalletId() !== expectedWalletId) {
    throw new Error("Pending ecash deposit wallet seed changed");
  }
}

function requireCanonicalBaseAsset(value: string): MarketBaseAsset {
  const parsed = parseMarketBaseAsset(value);
  if (!parsed || parsed !== value) {
    throw new Error("Pending ecash deposit base asset is invalid");
  }
  return parsed;
}

function totalProofAmount(proofs: readonly { amount: unknown }[]): number {
  return proofs.reduce(
    (sum, proof) => sum + amountToNumber(proof.amount as never),
    0,
  );
}
