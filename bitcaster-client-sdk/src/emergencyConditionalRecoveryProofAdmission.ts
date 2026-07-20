import {
  Amount,
  hashToCurve,
  verifyProofsForReceive,
  type ProofLike,
} from "@cashu/cashu-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  advanceSeedScan,
  classifySeedRecoveryMintState,
  type SeedRecoveryDisposition,
} from "./seedRecoveryCore.ts";
import {
  CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
  CONDITIONAL_RECOVERY_MAX_PROOFS,
  CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS,
  type CanonicalConditionalRecoveryProof,
  type ChargedConditionalRecoveryProofBatch,
  type CompletedConditionalRecoveryCatalogue,
  type ConditionalRecoveryAdmissionAuthorization,
  type ConditionalRecoveryAdmissionPort,
  type ConditionalRecoveryAuthorityObservation,
  type ConditionalRecoveryNut07Classification,
  type ConditionalRecoveryNut07State,
  type ConditionalRecoveryNut09RequestAuthorization,
  type ConditionalRecoveryNut13DerivationPort,
  type ConditionalRecoverySession,
  type ConditionalRecoverySessionCasPort,
  type ConditionalRecoveryWalletScope,
  type SeedDerivedConditionalRecoveryPlan,
  type ValidatedConditionalRecoveryTarget,
  type VerifiedConditionalRecoveryProofBatch,
} from "./emergencyConditionalRecoveryTypes.ts";
import {
  advanceSession,
  assertConditionalRecoveryBudgetDoesNotRegress,
  assertConditionalRecoveryWalletScopeMatches,
  boundedJsonBytes,
  canonicalAmount,
  canonicalRestoreOutputAmount,
  chargeConditionalRecoveryBudget,
  checkedSafeAdd,
  checkedSafeMultiply,
  consumeAuthority,
  decodeConditionalRecoveryWalletScope,
  digestValue,
  freezeSession,
  getConditionalRecoveryTargetSessionPort,
  hasOwn,
  isConditionalRecoveryKeysetRecoverable,
  isObject,
  requireBoundedPageBytes,
  requireCompletedCatalogue,
  requireCompressedSecpPublicKey,
  requireExactKeys,
  requireLiveSession,
  requireLowerHex32,
  requireNonEmptyBoundedString,
  requireObject,
  requireSafeInteger,
  requireV2KeysetId,
  requireValidatedTarget,
  retireConditionalRecoverySession,
} from "./emergencyConditionalRecoveryCatalogue.ts";

const MAX_PROOF_FIELD_BYTES = 64 * 1_024;
const UINT64_MAX = (1n << 64n) - 1n;
const LOWER_HEX_64 = /^[0-9a-f]{128}$/;
const encoder = new TextEncoder();

interface ProofBatchState {
  readonly catalogue: CompletedConditionalRecoveryCatalogue;
  readonly target: ValidatedConditionalRecoveryTarget;
  readonly originalArray: readonly ProofLike[];
  readonly originalRows: readonly object[];
  readonly canonical: readonly CanonicalConditionalRecoveryProof[];
  readonly ys: readonly string[];
  readonly sessionPort: ConditionalRecoverySessionCasPort;
  session: ConditionalRecoverySession;
}

const chargedProofBatches = new WeakMap<object, ProofBatchState>();
const verifiedProofBatches = new WeakMap<object, ProofBatchState>();
const classifiedNut07Responses = new WeakMap<object, ProofBatchState>();
const seedPlans = new WeakMap<
  object,
  {
    readonly target: ValidatedConditionalRecoveryTarget;
    readonly privateOutputs: readonly {
      readonly counter: number;
      readonly id: string;
      readonly amount: string;
      readonly B_: string;
      readonly Y: string;
      readonly unblind: (signature: unknown) => ProofLike;
    }[];
  }
>();
const nut09Requests = new WeakMap<
  object,
  {
    readonly catalogue: CompletedConditionalRecoveryCatalogue;
    readonly target: ValidatedConditionalRecoveryTarget;
    readonly plan: SeedDerivedConditionalRecoveryPlan;
    readonly sessionPort: ConditionalRecoverySessionCasPort;
  }
>();
const consumedNut09Requests = new WeakSet<object>();
const consumedVerifiedProofBatches = new WeakSet<object>();
const consumedNut07Classifications = new WeakSet<object>();

export async function createSeedDerivedConditionalRecoveryPlan(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  target: ValidatedConditionalRecoveryTarget;
  walletScope: ConditionalRecoveryWalletScope;
  startCounter: number;
  count: number;
  derivationPort: ConditionalRecoveryNut13DerivationPort;
  session: ConditionalRecoverySession;
}): Promise<SeedDerivedConditionalRecoveryPlan> {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const target = requireValidatedTarget(input.target, catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    catalogue.walletScope,
    walletScope,
  );
  assertConditionalRecoveryWalletScopeMatches(target.walletScope, walletScope);
  const sessionPort = requireLiveSession(input.session, walletScope);
  if (getConditionalRecoveryTargetSessionPort(target) !== sessionPort) {
    throw new Error(
      "conditional recovery NUT-13 plan uses a foreign session adapter",
    );
  }
  const startCounter = requireSafeInteger(
    input.startCounter,
    "conditional recovery NUT-13 start counter",
  );
  const count = requireSafeInteger(
    input.count,
    "conditional recovery NUT-13 count",
  );
  if (
    startCounter < 0 ||
    count < 1 ||
    count > CONDITIONAL_RECOVERY_MAX_PROOFS
  ) {
    throw new Error("conditional recovery NUT-13 output plan size is invalid");
  }
  if (
    input.session.scan.plannedStart !== null ||
    startCounter !== input.session.scan.nextCounter
  ) {
    throw new Error(
      "conditional recovery NUT-13 plan does not continue the linear scan",
    );
  }
  const rawOutputs = await input.derivationPort.deriveSeedOutputs({
    walletScope,
    keysetId: target.metadata.id,
    startCounter,
    count,
  });
  if (!Array.isArray(rawOutputs) || rawOutputs.length !== count) {
    throw new Error(
      "conditional recovery NUT-13 derivation returned wrong output count",
    );
  }
  const seenCounters = new Set<number>();
  const seenBlinded = new Set<string>();
  const seenProofYs = new Set<string>();
  const outputs = rawOutputs.map((raw, outputIndex) => {
    const counter = requireSafeInteger(
      raw.counter,
      "conditional recovery NUT-13 counter",
    );
    if (counter < 0 || seenCounters.has(counter)) {
      throw new Error("conditional recovery NUT-13 counter plan is invalid");
    }
    if (counter !== startCounter + outputIndex) {
      throw new Error(
        "conditional recovery NUT-13 derivation changed counter order",
      );
    }
    seenCounters.add(counter);
    const id = requireV2KeysetId(raw.id);
    if (id !== target.metadata.id) {
      throw new Error(
        "conditional recovery NUT-13 output uses a foreign keyset",
      );
    }
    const amount = canonicalRestoreOutputAmount(
      raw.amount,
      "conditional recovery NUT-13 amount",
    );
    if (amount !== "0") {
      throw new Error(
        "conditional recovery NUT-13 restore output must be a zero-amount blank",
      );
    }
    const B_ = requireCompressedSecpPublicKey(
      raw.B_,
      "conditional recovery NUT-13 blinded message",
    );
    if (seenBlinded.has(B_)) {
      throw new Error("conditional recovery NUT-13 output plan repeated B_");
    }
    seenBlinded.add(B_);
    const Y = requireCompressedSecpPublicKey(
      raw.Y,
      "conditional recovery NUT-13 proof Y",
    );
    if (seenProofYs.has(Y)) {
      throw new Error(
        "conditional recovery NUT-13 output plan repeated proof Y",
      );
    }
    seenProofYs.add(Y);
    if (typeof raw.unblind !== "function") {
      throw new Error(
        "conditional recovery NUT-13 derivation omitted unblinding authority",
      );
    }
    return Object.freeze({
      counter,
      id,
      amount,
      B_,
      Y,
      unblind: raw.unblind,
    });
  });
  const sortedCounters = [...seenCounters].sort((a, b) => a - b);
  for (let index = 1; index < sortedCounters.length; index += 1) {
    if (sortedCounters[index] !== sortedCounters[index - 1]! + 1) {
      throw new Error(
        "conditional recovery NUT-13 counters must be contiguous",
      );
    }
  }
  const digest = digestValue([
    "conditional-recovery-nut13-plan-v1",
    walletScope,
    outputs.map(({ counter, id, amount, B_, Y }) => ({
      counter,
      id,
      amount,
      B_,
      Y,
    })),
  ]);
  const publicOutputs = outputs.map(({ counter, id, amount, B_, Y }) => ({
    counter,
    id,
    amount,
    B_,
    Y,
  }));
  const budget = chargeConditionalRecoveryBudget(input.session.budget, {
    serializedBytes: boundedJsonBytes(
      publicOutputs,
      CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
      "conditional recovery NUT-13 plan",
    ),
    workUnits: checkedSafeAdd(outputs.length * 3, 1, "NUT-13 plan work"),
  });
  const session = advanceSession(
    input.session,
    sessionPort,
    "nut13-plan",
    digestValue([digest, publicOutputs, budget]),
    budget,
    {
      ...input.session.scan,
      plannedStart: startCounter,
      plannedCount: count,
    },
  );
  const plan = Object.freeze({
    walletScope,
    keysetId: target.metadata.id,
    outputs: Object.freeze(
      outputs.map(({ counter, id, amount, B_, Y }) =>
        Object.freeze({ counter, id, amount, B_, Y }),
      ),
    ),
    digest,
    session,
  });
  seedPlans.set(plan, {
    target,
    privateOutputs: Object.freeze(outputs),
  });
  return plan;
}

export function authorizeConditionalRecoveryNut09Request(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  target: ValidatedConditionalRecoveryTarget;
  plan: SeedDerivedConditionalRecoveryPlan;
  walletScope: ConditionalRecoveryWalletScope;
  authority: ConditionalRecoveryAuthorityObservation;
}): ConditionalRecoveryNut09RequestAuthorization {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const target = requireValidatedTarget(input.target, catalogue);
  const authority = consumeAuthority(input.authority, catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    catalogue.walletScope,
    walletScope,
  );
  assertConditionalRecoveryWalletScopeMatches(target.walletScope, walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    authority.walletScope,
    walletScope,
  );
  if (seedPlans.get(input.plan)?.target !== target) {
    throw new Error("conditional recovery NUT-13 plan evidence is invalid");
  }
  if (
    !isConditionalRecoveryKeysetRecoverable(
      target.metadata,
      authority.effectiveTime,
    )
  ) {
    throw new Error(
      "conditional recovery target expired before NUT-09 request",
    );
  }
  const sessionPort = requireLiveSession(input.plan.session, walletScope);
  if (getConditionalRecoveryTargetSessionPort(target) !== sessionPort) {
    throw new Error(
      "conditional recovery NUT-09 request uses a foreign session adapter",
    );
  }
  const outputs = Object.freeze(
    input.plan.outputs.map(({ id, amount, B_ }) =>
      Object.freeze({ id, amount, B_ }),
    ),
  );
  const requestDigest = digestValue([
    "conditional-recovery-nut09-request-v1",
    walletScope.mintUrl,
    walletScope.unit,
    outputs,
  ]);
  const budget = chargeConditionalRecoveryBudget(input.plan.session.budget, {
    serializedBytes: boundedJsonBytes(
      { outputs },
      CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
      "conditional recovery NUT-09 request",
    ),
    workUnits: checkedSafeAdd(outputs.length, 1, "NUT-09 request work"),
  });
  const session = advanceSession(
    input.plan.session,
    sessionPort,
    "nut09-request",
    digestValue([input.plan.digest, requestDigest, budget]),
    budget,
    input.plan.session.scan,
  );
  const request = Object.freeze({
    walletScope,
    keysetId: target.metadata.id,
    outputs,
    requestDigest,
    planDigest: input.plan.digest,
    session,
  });
  nut09Requests.set(request, {
    catalogue,
    target,
    plan: input.plan,
    sessionPort,
  });
  return request;
}

export function acceptConditionalRecoveryNut09Response(input: {
  request: ConditionalRecoveryNut09RequestAuthorization;
  response: unknown;
  responseBytes: number;
  authority: ConditionalRecoveryAuthorityObservation;
}): ChargedConditionalRecoveryProofBatch {
  if (!isObject(input.request)) {
    throw new Error("conditional recovery NUT-09 request evidence is invalid");
  }
  const requestState = nut09Requests.get(input.request);
  if (requestState === undefined || consumedNut09Requests.has(input.request)) {
    throw new Error(
      "conditional recovery NUT-09 request evidence is invalid or already used",
    );
  }
  const { catalogue, target, plan, sessionPort } = requestState;
  const planState = seedPlans.get(plan);
  if (planState === undefined || planState.target !== target) {
    throw new Error("conditional recovery NUT-13 plan evidence is invalid");
  }
  const authority = consumeAuthority(input.authority, catalogue);
  assertConditionalRecoveryWalletScopeMatches(
    authority.walletScope,
    input.request.walletScope,
  );
  if (
    !isConditionalRecoveryKeysetRecoverable(
      target.metadata,
      authority.effectiveTime,
    )
  ) {
    throw new Error(
      "conditional recovery target expired before NUT-09 response acceptance",
    );
  }
  const response = requireObject(
    input.response,
    "conditional recovery NUT-09 response",
  );
  requireExactKeys(
    response,
    ["outputs", "signatures"],
    "conditional recovery NUT-09 response",
  );
  if (
    !Array.isArray(response.outputs) ||
    !Array.isArray(response.signatures) ||
    response.outputs.length !== response.signatures.length ||
    response.outputs.length > CONDITIONAL_RECOVERY_MAX_PROOFS
  ) {
    throw new Error(
      "conditional recovery NUT-09 response cardinality is invalid",
    );
  }
  const responseOutputs = response.outputs;
  const responseSignatures = response.signatures;
  const requested = new Map(
    plan.outputs.map((output) => [output.B_, output] as const),
  );
  const privateRequested = new Map(
    planState.privateOutputs.map((output) => [output.B_, output] as const),
  );
  const seenOutputs = new Set<string>();
  const seenSignatures = new Set<string>();
  const derivedProofs: ProofLike[] = [];
  responseOutputs.forEach((rawValue, index) => {
    const output = requireObject(
      rawValue,
      "conditional recovery NUT-09 output",
    );
    requireExactKeys(
      output,
      ["id", "amount", "B_"],
      "conditional recovery NUT-09 output",
    );
    const B_ = requireCompressedSecpPublicKey(
      output.B_,
      "conditional recovery NUT-09 output B_",
    );
    const expected = requested.get(B_);
    if (expected === undefined || seenOutputs.has(B_)) {
      throw new Error(
        "conditional recovery NUT-09 response output was not uniquely requested",
      );
    }
    seenOutputs.add(B_);
    if (
      requireV2KeysetId(output.id) !== expected.id ||
      canonicalRestoreOutputAmount(
        output.amount,
        "conditional recovery NUT-09 output amount",
      ) !== expected.amount
    ) {
      throw new Error(
        "conditional recovery NUT-09 response output metadata changed",
      );
    }
    const signature = requireObject(
      responseSignatures[index],
      "conditional recovery NUT-09 signature",
    );
    requireExactKeys(
      signature,
      ["id", "amount", "C_", "dleq"],
      "conditional recovery NUT-09 signature",
      ["dleq"],
    );
    const C_ = requireCompressedSecpPublicKey(
      signature.C_,
      "conditional recovery NUT-09 blind signature",
    );
    if (seenSignatures.has(C_)) {
      throw new Error(
        "conditional recovery NUT-09 response repeated a signature",
      );
    }
    seenSignatures.add(C_);
    const signatureAmount = canonicalAmount(
      signature.amount,
      "conditional recovery NUT-09 signature amount",
    );
    if (
      requireV2KeysetId(signature.id) !== expected.id ||
      !hasOwn(target.keys as Record<string, unknown>, signatureAmount)
    ) {
      throw new Error("conditional recovery NUT-09 signature metadata changed");
    }
    const rawDleq = requireObject(
      signature.dleq,
      "conditional recovery NUT-09 signature DLEQ",
    );
    requireExactKeys(
      rawDleq,
      ["e", "s"],
      "conditional recovery NUT-09 signature DLEQ",
    );
    const rawE = requireLowerHex32(rawDleq.e, "NUT-09 signature DLEQ e");
    const rawS = requireLowerHex32(rawDleq.s, "NUT-09 signature DLEQ s");
    const privateOutput = privateRequested.get(B_);
    if (privateOutput === undefined) {
      throw new Error(
        "conditional recovery NUT-09 output omitted private derivation evidence",
      );
    }
    let proof: ProofLike;
    try {
      proof = privateOutput.unblind(responseSignatures[index]);
    } catch (cause) {
      throw new Error(
        "conditional recovery NUT-09 signature unblinding failed",
        { cause },
      );
    }
    const proofRecord = requireObject(
      proof,
      "conditional recovery unblinded proof",
    );
    const proofDleq = requireObject(
      proofRecord.dleq,
      "conditional recovery unblinded proof DLEQ",
    );
    if (
      canonicalAmount(
        proofRecord.amount,
        "conditional recovery unblinded proof amount",
      ) !==
        canonicalAmount(
          signature.amount,
          "conditional recovery NUT-09 signature amount",
        ) ||
      requireLowerHex32(proofDleq.e, "unblinded proof DLEQ e") !== rawE ||
      requireLowerHex32(proofDleq.s, "unblinded proof DLEQ s") !== rawS
    ) {
      throw new Error(
        "conditional recovery unblinded proof does not match raw NUT-09 signature",
      );
    }
    derivedProofs.push(proof);
  });
  const snapshot = canonicalizeProofBatch(
    derivedProofs,
    target.metadata.id,
    true,
  );
  responseOutputs.forEach((rawValue, index) => {
    const B_ = (rawValue as { B_: string }).B_;
    const expected = requested.get(B_)!;
    if (snapshot.ys[index] !== expected.Y) {
      throw new Error(
        "conditional recovery restored proof does not match its seed-derived counter output",
      );
    }
  });
  const responseSerializedBytes = boundedJsonBytes(
    response,
    CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
    "conditional recovery NUT-09 response",
  );
  const canonicalBytes = boundedJsonBytes(
    snapshot.canonical,
    CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
    "conditional recovery NUT-09 proofs",
  );
  const budget = chargeConditionalRecoveryBudget(input.request.session.budget, {
    transportBytes: requireBoundedPageBytes(input.responseBytes),
    serializedBytes: checkedSafeAdd(
      responseSerializedBytes,
      canonicalBytes,
      "NUT-09 serialized bytes",
    ),
    workUnits: checkedSafeAdd(
      checkedSafeMultiply(
        snapshot.canonical.length,
        6,
        "NUT-09 acceptance work",
      ),
      1,
      "NUT-09 acceptance work",
    ),
    proofCount: snapshot.canonical.length,
  });
  const responseDigest = digestValue([
    "conditional-recovery-nut09-response-v1",
    response,
  ]);
  const plannedStart = input.request.session.scan.plannedStart;
  const plannedCount = input.request.session.scan.plannedCount;
  if (plannedStart === null || plannedCount !== plan.outputs.length) {
    throw new Error("conditional recovery NUT-09 scan plan is inconsistent");
  }
  const advancedScan = advanceSeedScan(
    input.request.session.scan,
    {
      startCounter: plannedStart,
      requestedCount: plannedCount,
      returnedCounterOffsets: responseOutputs.map((rawValue) => {
        const requestedOutput = requested.get((rawValue as { B_: string }).B_);
        return plan.outputs.indexOf(requestedOutput!);
      }),
    },
    {
      maxBatchSize: CONDITIONAL_RECOVERY_MAX_PROOFS,
      maxTotalOutputs: CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS,
    },
  );
  const scan = Object.freeze({
    ...advancedScan,
    plannedStart: null,
    plannedCount: 0,
  });
  const session = advanceSession(
    input.request.session,
    sessionPort,
    "nut09-response",
    digestValue([
      responseDigest,
      budget,
      digestCanonicalProofs(snapshot.canonical),
    ]),
    budget,
    scan,
  );
  const proofIdentities = Object.freeze(
    snapshot.ys.map((y) =>
      digestValue([
        "conditional-recovery-global-proof-v1",
        target.walletScope.mintUrl,
        target.walletScope.unit,
        target.metadata.id,
        y,
      ]),
    ),
  );
  const admittedProofs = Object.freeze([...derivedProofs]);
  const batch = Object.freeze({
    walletScope: target.walletScope,
    keysetId: target.metadata.id,
    proofCount: snapshot.canonical.length,
    proofBodyDigest: digestCanonicalProofs(snapshot.canonical),
    proofYDigest: digestProofYs(snapshot.canonical, snapshot.ys),
    requestDigest: input.request.requestDigest,
    responseDigest,
    planDigest: input.request.planDigest,
    proofIdentities,
    proofs: admittedProofs,
    session,
    budget,
  });
  consumedNut09Requests.add(input.request);
  chargedProofBatches.set(batch, {
    catalogue,
    target,
    originalArray: admittedProofs,
    originalRows: Object.freeze([...(admittedProofs as readonly object[])]),
    canonical: snapshot.canonical,
    ys: snapshot.ys,
    sessionPort,
    session,
  });
  return batch;
}

export function verifyConditionalRecoveryProofs(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  target: ValidatedConditionalRecoveryTarget;
  walletScope: ConditionalRecoveryWalletScope;
  proofBatch: ChargedConditionalRecoveryProofBatch;
  authority: ConditionalRecoveryAuthorityObservation;
}): VerifiedConditionalRecoveryProofBatch {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const target = requireValidatedTarget(input.target, catalogue);
  const authority = consumeAuthority(input.authority, catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    catalogue.walletScope,
    walletScope,
  );
  assertConditionalRecoveryWalletScopeMatches(target.walletScope, walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    authority.walletScope,
    walletScope,
  );
  if (
    !isConditionalRecoveryKeysetRecoverable(
      target.metadata,
      authority.effectiveTime,
    )
  ) {
    throw new Error(
      "conditional recovery target expired before proof verification",
    );
  }
  const { batch, state } = requireChargedProofBatch(
    input.proofBatch,
    catalogue,
    target,
  );
  assertExactProofBatchUnchanged(batch, state, state.originalArray);
  if (batch.proofCount === 0) {
    throw new Error(
      "conditional recovery empty proof batch cannot be verified",
    );
  }
  try {
    verifyProofsForReceive(
      [...state.originalArray],
      (id) => {
        if (id !== target.metadata.id) {
          throw new Error(
            "conditional recovery proof belongs to a foreign keyset",
          );
        }
        return { id, keys: { ...target.keys } };
      },
      { requireDleq: true },
    );
  } catch {
    throw new Error(
      "conditional recovery proof cryptographic verification failed",
    );
  }
  const budget = chargeConditionalRecoveryBudget(state.session.budget, {
    workUnits: checkedSafeMultiply(
      batch.proofCount,
      2,
      "proof verification work",
    ),
  });
  const session = advanceSession(
    state.session,
    state.sessionPort,
    "proof-verification",
    digestValue([batch.proofBodyDigest, budget]),
    budget,
    state.session.scan,
  );
  state.session = session;
  const verified = Object.freeze({
    walletScope,
    keysetId: batch.keysetId,
    proofCount: batch.proofCount,
    proofBodyDigest: batch.proofBodyDigest,
    proofYDigest: batch.proofYDigest,
    requestDigest: batch.requestDigest,
    responseDigest: batch.responseDigest,
    planDigest: batch.planDigest,
    proofIdentities: batch.proofIdentities,
    session,
    verifiedAt: authority.effectiveTime,
    budget,
  });
  verifiedProofBatches.set(verified, state);
  return verified;
}

export function classifyConditionalRecoveryNut07(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  target: ValidatedConditionalRecoveryTarget;
  walletScope: ConditionalRecoveryWalletScope;
  proofBatch: ChargedConditionalRecoveryProofBatch;
  response: unknown;
  responseBytes: number;
}): ConditionalRecoveryNut07Classification {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const target = requireValidatedTarget(input.target, catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    catalogue.walletScope,
    walletScope,
  );
  assertConditionalRecoveryWalletScopeMatches(target.walletScope, walletScope);
  const { batch, state } = requireChargedProofBatch(
    input.proofBatch,
    catalogue,
    target,
  );
  assertExactProofBatchUnchanged(batch, state, state.originalArray);
  if (batch.proofCount === 0) {
    throw new Error(
      "conditional recovery empty proof batch cannot be classified",
    );
  }
  const response = requireObject(
    input.response,
    "conditional recovery NUT-07 response",
  );
  requireExactKeys(
    response,
    ["states"],
    "conditional recovery NUT-07 response",
  );
  if (
    !Array.isArray(response.states) ||
    response.states.length !== state.ys.length
  ) {
    throw new Error(
      "conditional recovery NUT-07 response did not contain the exact proof Y set",
    );
  }
  const expectedPositions = new Map<string, number>();
  state.ys.forEach((y, index) => expectedPositions.set(y, index));
  const states = new Map<string, ConditionalRecoveryNut07State>();
  for (const value of response.states) {
    const row = requireObject(value, "conditional recovery NUT-07 state");
    requireExactKeys(
      row,
      ["Y", "state", "witness"],
      "conditional recovery NUT-07 state",
    );
    const y = requireCompressedSecpPublicKey(
      row.Y,
      "conditional recovery NUT-07 proof Y",
    );
    if (!expectedPositions.has(y)) {
      throw new Error(
        "conditional recovery NUT-07 response contained a foreign proof Y",
      );
    }
    if (states.has(y)) {
      throw new Error(
        "conditional recovery NUT-07 response repeated a proof Y",
      );
    }
    if (row.witness !== null) {
      throw new Error("conditional recovery NUT-07 witness must be null");
    }
    states.set(y, classifyNut07State(row.state));
  }
  const results = Object.freeze(
    state.ys.map((y, proofIndex) => {
      const proofState = states.get(y);
      if (proofState === undefined) {
        throw new Error(
          "conditional recovery NUT-07 response omitted a proof Y",
        );
      }
      return Object.freeze({ proofIndex, state: proofState });
    }),
  );
  const budget = chargeConditionalRecoveryBudget(state.session.budget, {
    transportBytes: requireBoundedPageBytes(input.responseBytes),
    serializedBytes: boundedJsonBytes(
      response,
      CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
      "conditional recovery NUT-07 response",
    ),
    workUnits: checkedSafeAdd(response.states.length, 1, "NUT-07 work"),
  });
  const session = advanceSession(
    state.session,
    state.sessionPort,
    "nut07-classification",
    digestValue([batch.proofYDigest, results, budget]),
    budget,
    state.session.scan,
  );
  state.session = session;
  const classification = Object.freeze({
    walletScope,
    keysetId: batch.keysetId,
    results,
    proofCount: batch.proofCount,
    proofBodyDigest: batch.proofBodyDigest,
    proofYDigest: batch.proofYDigest,
    requestDigest: batch.requestDigest,
    responseDigest: batch.responseDigest,
    planDigest: batch.planDigest,
    proofIdentities: batch.proofIdentities,
    session,
    budget,
  });
  classifiedNut07Responses.set(classification, state);
  return classification;
}

export function authorizeConditionalRecoveryAdmission(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  target: ValidatedConditionalRecoveryTarget;
  verifiedProofs: VerifiedConditionalRecoveryProofBatch;
  nut07: ConditionalRecoveryNut07Classification;
  walletScope: ConditionalRecoveryWalletScope;
  proofs: readonly ProofLike[];
  authority: ConditionalRecoveryAuthorityObservation;
  admissionPort: ConditionalRecoveryAdmissionPort;
}): ConditionalRecoveryAdmissionAuthorization {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const target = requireValidatedTarget(input.target, catalogue);
  const authority = consumeAuthority(input.authority, catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    catalogue.walletScope,
    walletScope,
  );
  assertConditionalRecoveryWalletScopeMatches(target.walletScope, walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    authority.walletScope,
    walletScope,
  );
  if (
    !isConditionalRecoveryKeysetRecoverable(
      target.metadata,
      authority.effectiveTime,
    )
  ) {
    throw new Error("conditional recovery target expired before admission");
  }
  const verifiedState = requireVerifiedProofBatch(
    input.verifiedProofs,
    catalogue,
    target,
  );
  const classifiedState = requireNut07Classification(
    input.nut07,
    catalogue,
    target,
  );
  if (verifiedState !== classifiedState) {
    throw new Error(
      "conditional recovery proof verification and NUT-07 sets differ",
    );
  }
  if (input.admissionPort !== verifiedState.sessionPort) {
    throw new Error(
      "conditional recovery admission must use the session CAS adapter",
    );
  }
  if (
    consumedVerifiedProofBatches.has(input.verifiedProofs) ||
    consumedNut07Classifications.has(input.nut07)
  ) {
    throw new Error("conditional recovery final evidence was already consumed");
  }
  if (
    input.verifiedProofs.proofBodyDigest !== input.nut07.proofBodyDigest ||
    input.verifiedProofs.proofYDigest !== input.nut07.proofYDigest ||
    input.verifiedProofs.proofCount !== input.nut07.proofCount ||
    input.verifiedProofs.requestDigest !== input.nut07.requestDigest ||
    input.verifiedProofs.responseDigest !== input.nut07.responseDigest ||
    input.verifiedProofs.planDigest !== input.nut07.planDigest ||
    digestValue(input.verifiedProofs.proofIdentities) !==
      digestValue(input.nut07.proofIdentities)
  ) {
    throw new Error(
      "conditional recovery proof verification and NUT-07 sets differ",
    );
  }
  assertExactProofBatchUnchanged(
    {
      proofBodyDigest: input.verifiedProofs.proofBodyDigest,
      proofYDigest: input.verifiedProofs.proofYDigest,
    },
    verifiedState,
    input.proofs,
  );
  assertConditionalRecoveryBudgetDoesNotRegress(
    input.verifiedProofs.budget,
    input.nut07.budget,
  );
  const selectableProofs: CanonicalConditionalRecoveryProof[] = [];
  const pendingProofs: CanonicalConditionalRecoveryProof[] = [];
  const spentProofs: CanonicalConditionalRecoveryProof[] = [];
  for (const result of input.nut07.results) {
    const proof = verifiedState.canonical[result.proofIndex]!;
    const disposition = classifySeedRecoveryMintState(result.state);
    switch (disposition) {
      case "selectable":
        selectableProofs.push(proof);
        break;
      case "retain-nonselectable":
        pendingProofs.push(proof);
        break;
      case "spent":
        spentProofs.push(proof);
        break;
      case "fail-closed":
        throw new Error(
          "conditional recovery NUT-07 disposition cannot be admitted",
        );
      default:
        assertNever(disposition);
    }
  }
  const admissionRows = Object.freeze(
    input.nut07.results.map((result) =>
      Object.freeze({
        proofIdentity: input.verifiedProofs.proofIdentities[result.proofIndex]!,
        state: result.state,
        proof: verifiedState.canonical[result.proofIndex]!,
      }),
    ),
  );
  const authorizationDigest = digestValue([
    "conditional-recovery-admission-v1",
    input.verifiedProofs.requestDigest,
    input.verifiedProofs.responseDigest,
    input.verifiedProofs.planDigest,
    input.verifiedProofs.proofBodyDigest,
    input.verifiedProofs.proofIdentities,
    input.nut07.results,
  ]);
  const currentSession = verifiedState.session;
  requireLiveSession(currentSession, walletScope);
  const successorSession = freezeSession({
    walletScope,
    sequence: checkedSafeAdd(currentSession.sequence, 1, "session sequence"),
    predecessorDigest: currentSession.digest,
    transition: "atomic-admission",
    evidenceDigest: authorizationDigest,
    budget: currentSession.budget,
    scan: currentSession.scan,
  });
  if (
    input.admissionPort.compareAndSwapInsertUnique({
      walletScope,
      expectedSessionDigest: currentSession.digest,
      successorSession,
      rows: admissionRows,
      authorizationDigest,
    }) !== true
  ) {
    throw new Error(
      "conditional recovery atomic admission CAS or global proof uniqueness failed",
    );
  }
  retireConditionalRecoverySession(currentSession);
  consumedVerifiedProofBatches.add(input.verifiedProofs);
  consumedNut07Classifications.add(input.nut07);
  return Object.freeze({
    walletScope,
    keysetId: target.metadata.id,
    authorizedAt: authority.effectiveTime,
    selectableProofs: Object.freeze(selectableProofs),
    pendingProofs: Object.freeze(pendingProofs),
    spentProofs: Object.freeze(spentProofs),
  });
}

function canonicalizeProofBatch(
  proofs: readonly ProofLike[],
  keysetId: string,
  allowEmpty = false,
): {
  canonical: readonly CanonicalConditionalRecoveryProof[];
  ys: readonly string[];
} {
  if (
    !Array.isArray(proofs) ||
    (!allowEmpty && proofs.length < 1) ||
    proofs.length > CONDITIONAL_RECOVERY_MAX_PROOFS
  ) {
    throw new Error("conditional recovery proof batch size is invalid");
  }
  const ys: string[] = [];
  const seenYs = new Set<string>();
  const canonical = proofs.map((value) => {
    const proof = requireObject(value, "conditional recovery proof");
    requireExactKeys(
      proof,
      ["id", "amount", "secret", "C", "dleq", "p2pk_e", "witness"],
      "conditional recovery proof",
      ["p2pk_e", "witness"],
    );
    const id = requireV2KeysetId(proof.id);
    if (id !== keysetId) {
      throw new Error("conditional recovery proof belongs to a foreign keyset");
    }
    let amount: string;
    try {
      const parsed = Amount.from(proof.amount as never).toBigInt();
      if (parsed < 1n || parsed > UINT64_MAX) throw new Error();
      amount = parsed.toString();
    } catch {
      throw new Error("conditional recovery proof amount is invalid");
    }
    const secret = requireNonEmptyBoundedString(
      proof.secret,
      MAX_PROOF_FIELD_BYTES,
      "conditional recovery proof secret",
    );
    const C = requireCompressedSecpPublicKey(
      proof.C,
      "conditional recovery proof C",
    );
    const dleqRaw = requireObject(
      proof.dleq,
      "conditional recovery proof DLEQ",
    );
    requireExactKeys(
      dleqRaw,
      ["e", "s", "r"],
      "conditional recovery proof DLEQ",
    );
    const dleq = Object.freeze({
      e: requireLowerHex32(dleqRaw.e, "proof DLEQ e"),
      s: requireLowerHex32(dleqRaw.s, "proof DLEQ s"),
      r: requireLowerHex32(dleqRaw.r, "proof DLEQ r"),
    });
    const p2pkE =
      proof.p2pk_e === undefined
        ? null
        : requireCompressedSecpPublicKey(
            proof.p2pk_e,
            "conditional recovery proof p2pk_e",
          );
    const witness = canonicalizeWitness(proof.witness);
    const y = hashToCurve(encoder.encode(secret)).toHex(true);
    if (seenYs.has(y)) {
      throw new Error("conditional recovery proof batch repeated a proof Y");
    }
    seenYs.add(y);
    ys.push(y);
    return Object.freeze({ id, amount, secret, C, dleq, p2pkE, witness });
  });
  return {
    canonical: Object.freeze(canonical),
    ys: Object.freeze(ys),
  };
}

function classifyNut07State(value: unknown): ConditionalRecoveryNut07State {
  switch (value) {
    case "UNSPENT":
    case "PENDING":
    case "SPENT":
    case "UNKNOWN":
      return admittedNut07StateForDisposition(
        classifySeedRecoveryMintState(value),
      );
    default:
      throw new Error("conditional recovery NUT-07 state is unknown");
  }
}

function admittedNut07StateForDisposition(
  disposition: SeedRecoveryDisposition,
): ConditionalRecoveryNut07State {
  switch (disposition) {
    case "selectable":
      return "UNSPENT";
    case "retain-nonselectable":
      return "PENDING";
    case "spent":
      return "SPENT";
    case "fail-closed":
      throw new Error("conditional recovery NUT-07 state is unknown");
    default:
      return assertNever(disposition);
  }
}

function assertNever(value: never): never {
  throw new Error(`conditional recovery value is unhandled: ${String(value)}`);
}

function canonicalizeWitness(
  value: unknown,
): string | Readonly<Record<string, unknown>> | null {
  if (value === undefined) return null;
  if (typeof value === "string") {
    return requireNonEmptyBoundedString(
      value,
      MAX_PROOF_FIELD_BYTES,
      "conditional recovery proof witness",
    );
  }
  const witness = requireObject(value, "conditional recovery proof witness");
  requireExactKeys(
    witness,
    ["preimage", "signatures"],
    "conditional recovery proof witness",
    ["preimage", "signatures"],
  );
  if (!hasOwn(witness, "preimage") && !hasOwn(witness, "signatures")) {
    throw new Error("conditional recovery proof witness is empty");
  }
  const canonical: Record<string, unknown> = {};
  if (hasOwn(witness, "preimage")) {
    canonical.preimage = requireNonEmptyBoundedString(
      witness.preimage,
      MAX_PROOF_FIELD_BYTES,
      "conditional recovery proof witness preimage",
    );
  }
  if (hasOwn(witness, "signatures")) {
    if (!Array.isArray(witness.signatures) || witness.signatures.length < 1) {
      throw new Error(
        "conditional recovery proof witness signatures are invalid",
      );
    }
    canonical.signatures = Object.freeze(
      witness.signatures.map((signature) => {
        if (typeof signature !== "string" || !LOWER_HEX_64.test(signature)) {
          throw new Error(
            "conditional recovery proof witness signature is invalid",
          );
        }
        return signature;
      }),
    );
  }
  return Object.freeze(canonical);
}

function digestCanonicalProofs(
  proofs: readonly CanonicalConditionalRecoveryProof[],
): string {
  return bytesToHex(sha256(encoder.encode(JSON.stringify(proofs))));
}

function digestProofYs(
  proofs: readonly CanonicalConditionalRecoveryProof[],
  ys: readonly string[],
): string {
  if (proofs.length !== ys.length) {
    throw new Error(
      "conditional recovery proof digest inputs are inconsistent",
    );
  }
  return bytesToHex(
    sha256(
      encoder.encode(
        JSON.stringify(proofs.map((proof, index) => [proof.id, ys[index]])),
      ),
    ),
  );
}

function assertExactProofBatchUnchanged(
  batch: { readonly proofBodyDigest: string; readonly proofYDigest: string },
  state: ProofBatchState,
  proofs: readonly ProofLike[],
): void {
  if (proofs !== state.originalArray) {
    throw new Error("conditional recovery admission replaced the proof array");
  }
  if (
    proofs.length !== state.originalRows.length ||
    proofs.some((proof, index) => proof !== state.originalRows[index])
  ) {
    throw new Error("conditional recovery admission replaced a proof object");
  }
  const current = canonicalizeProofBatch(proofs, state.target.metadata.id);
  if (
    digestCanonicalProofs(current.canonical) !== batch.proofBodyDigest ||
    digestProofYs(current.canonical, current.ys) !== batch.proofYDigest
  ) {
    throw new Error("conditional recovery exact proof batch changed");
  }
}

function requireChargedProofBatch(
  value: unknown,
  catalogue: CompletedConditionalRecoveryCatalogue,
  target: ValidatedConditionalRecoveryTarget,
): { batch: ChargedConditionalRecoveryProofBatch; state: ProofBatchState } {
  if (!isObject(value)) {
    throw new Error("conditional recovery charged proof evidence is invalid");
  }
  const state = chargedProofBatches.get(value);
  if (
    state === undefined ||
    state.catalogue !== catalogue ||
    state.target !== target
  ) {
    throw new Error("conditional recovery charged proof evidence is invalid");
  }
  return {
    batch: value as unknown as ChargedConditionalRecoveryProofBatch,
    state,
  };
}

function requireVerifiedProofBatch(
  value: unknown,
  catalogue: CompletedConditionalRecoveryCatalogue,
  target: ValidatedConditionalRecoveryTarget,
): ProofBatchState {
  if (!isObject(value)) {
    throw new Error("conditional recovery verified proof evidence is invalid");
  }
  const state = verifiedProofBatches.get(value);
  if (
    state === undefined ||
    state.catalogue !== catalogue ||
    state.target !== target
  ) {
    throw new Error("conditional recovery verified proof evidence is invalid");
  }
  return state;
}

function requireNut07Classification(
  value: unknown,
  catalogue: CompletedConditionalRecoveryCatalogue,
  target: ValidatedConditionalRecoveryTarget,
): ProofBatchState {
  if (!isObject(value)) {
    throw new Error(
      "conditional recovery NUT-07 classification evidence is invalid",
    );
  }
  const state = classifiedNut07Responses.get(value);
  if (
    state === undefined ||
    state.catalogue !== catalogue ||
    state.target !== target
  ) {
    throw new Error(
      "conditional recovery NUT-07 classification evidence is invalid",
    );
  }
  return state;
}
