import { performance } from "node:perf_hooks";
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
  initialConditionalRecoveryScan,
  validateConditionalRecoverySessionSuccessor,
} from "./emergencyConditionalRecoverySession.ts";
import {
  CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
  CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
  CONDITIONAL_RECOVERY_MAX_PROOFS,
  CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS,
  type CanonicalConditionalRecoveryProof,
  type ChargedConditionalRecoveryProofBatch,
  type CompletedConditionalRecoveryCatalogue,
  type ConditionalRecoveryAdmissionAuthorization,
  type ConditionalRecoveryAdmissionPort,
  type ConditionalRecoveryAuthorityObservation,
  type ConditionalRecoveryNut07CommitAuthority,
  type ConditionalRecoveryNut07TransportPort,
  type ConditionalRecoveryProofDispositionRow,
  type ConditionalRecoveryNut07Classification,
  type ConditionalRecoveryFreshExpiryEvidence,
  type ConditionalRecoveryNut07State,
  type ConditionalRecoveryNut09RequestAuthorization,
  type ConditionalRecoveryNut09TransportPort,
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
  adoptExternallyCommittedConditionalRecoverySession,
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
  registerRehydratedConditionalRecoverySession,
  rehydrateConditionalRecoveryTarget,
  requireLiveSession,
  requireLowerHex32,
  requireNonEmptyBoundedString,
  requireObject,
  requireSafeInteger,
  requireV2KeysetId,
  requireValidatedTarget,
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
const freshExpiryEvidence = new WeakSet<object>();
interface Nut07CommitAuthorityState {
  readonly batchState: ProofBatchState;
  readonly classification: ConditionalRecoveryNut07Classification;
  readonly authorityDigest: string;
  readonly issuedAt: number;
  readonly deadline: number;
  valid: boolean;
  consumed: boolean;
}

const nut07CommitAuthorities = new WeakMap<
  object,
  Nut07CommitAuthorityState
>();
export function issueConditionalRecoveryFreshExpiryEvidence(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  target: ValidatedConditionalRecoveryTarget;
  authority: ConditionalRecoveryAuthorityObservation;
}): ConditionalRecoveryFreshExpiryEvidence {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const target = requireValidatedTarget(input.target, catalogue);
  const authority = consumeAuthority(input.authority, catalogue);
  if (
    target.metadata.finalExpiry === null ||
    isConditionalRecoveryKeysetRecoverable(
      target.metadata,
      authority.effectiveTime,
    )
  ) {
    throw new Error(
      "conditional recovery expiry evidence does not prove a fresh expiry",
    );
  }
  const catalogueOrdinal = catalogue.keysets.findIndex(
    (candidate) => candidate.id === target.metadata.id,
  );
  if (
    catalogueOrdinal !== target.session.catalogueOrdinal ||
    target.session.activeKeysetId !== target.metadata.id ||
    target.session.keysetMetadataDigest === null
  ) {
    throw new Error(
      "conditional recovery expiry evidence does not match the active keyset",
    );
  }
  const evidence = Object.freeze({
    catalogueOrdinal,
    keysetId: target.metadata.id,
    conditionId: target.metadata.conditionId,
    finalExpiry: target.metadata.finalExpiry,
    observedAt: authority.effectiveTime,
    keysetMetadataDigest: target.session.keysetMetadataDigest,
    authorityDigest: digestValue([
      "conditional-recovery-fresh-expiry-v1",
      catalogueOrdinal,
      target.metadata.id,
      target.metadata.conditionId,
      target.metadata.finalExpiry,
      authority.effectiveTime,
      target.session.keysetMetadataDigest,
    ]),
  });
  freshExpiryEvidence.add(evidence);
  return evidence;
}
export function skipExpiredConditionalRecoveryKeyset(input: {
  session: ConditionalRecoverySession;
  expiryAuthority: ConditionalRecoveryFreshExpiryEvidence;
  sessionPort: ConditionalRecoverySessionCasPort;
}): ConditionalRecoverySession {
  const authority = input.expiryAuthority;
  if (
    !freshExpiryEvidence.has(authority) ||
    input.session.activeKeysetId !== authority.keysetId ||
    input.session.catalogueOrdinal !== authority.catalogueOrdinal ||
    input.session.keysetMetadataDigest !== authority.keysetMetadataDigest ||
    authority.observedAt < authority.finalExpiry ||
    requireLiveSession(input.session, input.session.walletScope) !==
      input.sessionPort
  ) {
    throw new Error(
      "conditional recovery expired-keyset skip authority is invalid",
    );
  }
  let reason:
    | "expired-before-request"
    | "expired-empty-response";
  switch (input.session.transition) {
    case "conditional-keys":
    case "nut13-plan":
      reason = "expired-before-request";
      break;
    case "nut09-response":
      if (input.session.currentBatch?.returnedCount !== 0) {
        throw new Error(
          "conditional recovery proof-bearing response cannot be skipped",
        );
      }
      reason = "expired-empty-response";
      break;
    case "nut09-request":
      throw new Error(
        "conditional recovery dispatched request must replay before expiry handling",
      );
    default:
      throw new Error(
        "conditional recovery expiry skip is invalid from this transition",
      );
  }
  const successor = advanceSession(
    input.session,
    input.sessionPort,
    "keyset-skipped",
    authority.authorityDigest,
    input.session.budget,
    initialConditionalRecoveryScan(input.session.scan.nextCounter),
    {
      completedKeysetProofCount: input.session.budget.proofCount,
      activeKeysetId: null,
      keysetMetadataDigest: null,
      currentBatch: null,
      keysetTerminalEvidence: null,
      skipEvidence: {
        catalogueOrdinal: authority.catalogueOrdinal,
        keysetId: authority.keysetId,
        reason,
        authorityDigest: authority.authorityDigest,
      },
      terminalEvidence: null,
    },
  );
  freshExpiryEvidence.delete(authority);
  return successor;
}



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
    {
      currentBatch: {
        planDigest: digest,
        planStart: input.startCounter,
        planCount: input.count,
        requestDigest: null,
        batchDigest: null,
        stagedBatchId: null,
        returnedCount: null,
      },
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
  const requestBytes = encoder.encode(JSON.stringify({ outputs }));
  const requestDigest = digestValue([
    "conditional-recovery-nut09-request-v2",
    walletScope.mintUrl,
    walletScope.unit,
    bytesToHex(requestBytes),
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
    {
      currentBatch: {
        ...input.plan.session.currentBatch!,
        requestDigest,
      },
    },
  );
  const request = Object.freeze({
    walletScope,
    keysetId: target.metadata.id,
    outputs,
    requestBytes,
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
export async function acceptConditionalRecoveryNut09Response(input: {
  readonly request: ConditionalRecoveryNut09RequestAuthorization;
  readonly transport: ConditionalRecoveryNut09TransportPort;
  readonly authority: ConditionalRecoveryAuthorityObservation;
}): Promise<ChargedConditionalRecoveryProofBatch> {
  if (!isObject(input.request)) {
    throw new Error("conditional recovery NUT-09 request evidence is invalid");
  }
  const remaining = checkedSafeAdd(
    CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
    -input.request.session.budget.transportBytes,
    "remaining NUT-09 transport budget",
  );
  const maxEntityBytes = Math.min(
    CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
    remaining,
  );
  const responseBody = await input.transport.fetchNut09Entity({
    walletScope: input.request.walletScope,
    endpoint: new URL(
      "/v1/restore",
      input.request.walletScope.mintUrl,
    ).toString(),
    requestBytes: new Uint8Array(input.request.requestBytes),
    maxEntityBytes,
  });
  if (
    !(responseBody instanceof Uint8Array) ||
    responseBody.byteLength > maxEntityBytes
  ) {
    throw new Error(
      "conditional recovery NUT-09 transport exceeded its exact entity bound",
    );
  }
  return acceptConditionalRecoveryNut09ResponseBytes({
    request: input.request,
    responseBody,
    authority: input.authority,
  });
}

async function acceptConditionalRecoveryNut09ResponseBytes(input: {
  request: ConditionalRecoveryNut09RequestAuthorization;
  responseBody: Uint8Array;
  authority: ConditionalRecoveryAuthorityObservation;
}): Promise<ChargedConditionalRecoveryProofBatch> {
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
  const privateRequested = new Map(
    planState.privateOutputs.map((output) => [output.B_, output] as const),
  );
  if (
    digestValue([
      "conditional-recovery-nut09-request-v2",
      input.request.walletScope.mintUrl,
      input.request.walletScope.unit,
      bytesToHex(input.request.requestBytes),
    ]) !== input.request.requestDigest
  ) {
    throw new Error(
      "conditional recovery NUT-09 dispatched request bytes changed before replay",
    );
  }
  if (
    !(input.responseBody instanceof Uint8Array) ||
    input.responseBody.byteLength > CONDITIONAL_RECOVERY_MAX_PAGE_BYTES
  ) {
    throw new Error(
      "conditional recovery NUT-09 response body exceeded its byte bound",
    );
  }
  let parsedResponseBody: unknown;
  try {
    parsedResponseBody = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.responseBody),
    ) as unknown;
  } catch {
    throw new Error(
      "conditional recovery NUT-09 response body is not exact valid JSON",
    );
  }
  const response = parsedResponseBody;
  const authority = consumeAuthority(input.authority, catalogue);
  assertConditionalRecoveryWalletScopeMatches(
    authority.walletScope,
    input.request.walletScope,
  );
  const responseObject = requireObject(
    response,
    "conditional recovery NUT-09 response",
  );
  requireExactKeys(
    responseObject,
    ["outputs", "signatures"],
    "conditional recovery NUT-09 response",
  );
  if (
    !Array.isArray(responseObject.outputs) ||
    !Array.isArray(responseObject.signatures) ||
    responseObject.outputs.length !== responseObject.signatures.length ||
    responseObject.outputs.length > CONDITIONAL_RECOVERY_MAX_PROOFS
  ) {
    throw new Error(
      "conditional recovery NUT-09 response output/signature count is invalid",
    );
  }
  const responseOutputs = responseObject.outputs;
  const responseSignatures = responseObject.signatures;
  const requested = new Map(
    plan.outputs.map((output) => [output.B_, output] as const),
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
    transportBytes: requireBoundedPageBytes(input.responseBody.byteLength),
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
    "conditional-recovery-nut09-response-v2",
    bytesToHex(input.responseBody),
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
  const stagedBatchId =
    snapshot.canonical.length === 0
      ? null
      : digestValue([
          "conditional-recovery-staged-batch-v1",
          input.request.requestDigest,
          responseDigest,
          digestCanonicalProofs(snapshot.canonical),
        ]);
  const currentBatch = {
    ...input.request.session.currentBatch!,
    batchDigest: responseDigest,
    stagedBatchId,
    returnedCount: snapshot.canonical.length,
  };
  const evidenceDigest = digestValue([
    responseDigest,
    budget,
    digestCanonicalProofs(snapshot.canonical),
  ]);
  let session: ConditionalRecoverySession;
  if (stagedBatchId === null) {
    session = advanceSession(
      input.request.session,
      sessionPort,
      "nut09-response",
      evidenceDigest,
      budget,
      scan,
      { currentBatch },
    );
  } else {
    session = freezeSession({
      walletScope: input.request.session.walletScope,
      sequence: checkedSafeAdd(
        input.request.session.sequence,
        1,
        "session sequence",
      ),
      predecessorDigest: input.request.session.digest,
      transition: "nut09-response",
      evidenceDigest,
      budget,
      catalogueDigest: input.request.session.catalogueDigest,
      completedKeysetProofCount:
        input.request.session.completedKeysetProofCount,
      catalogueOrdinal: input.request.session.catalogueOrdinal,
      activeKeysetId: input.request.session.activeKeysetId,
      keysetMetadataDigest: input.request.session.keysetMetadataDigest,
      scan,
      currentBatch,
      keysetTerminalEvidence: null,
      skipEvidence: null,
      terminalEvidence: null,
    });
    validateConditionalRecoverySessionSuccessor(input.request.session, session);
    if (
      (await sessionPort.compareAndSwapStageNut09Response({
        expectedSessionDigest: input.request.session.digest,
        successor: session,
        stagedBatchId,
        requestBytes: new Uint8Array(input.request.requestBytes),
        responseBytes: new Uint8Array(input.responseBody),
        rows: snapshot.canonical,
      })) !== true
    ) {
      throw new Error(
        "conditional recovery NUT-09 response atomic staging CAS failed",
      );
    }
    adoptExternallyCommittedConditionalRecoverySession(
      input.request.session,
      session,
      sessionPort,
    );
  }
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
    stagedBatchId,
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
  expiryEvidence?: ConditionalRecoveryFreshExpiryEvidence;
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
    const expiryEvidence = input.expiryEvidence;
    if (
      expiryEvidence === undefined ||
      !freshExpiryEvidence.has(expiryEvidence) ||
      expiryEvidence.keysetId !== target.metadata.id ||
      expiryEvidence.catalogueOrdinal !== target.session.catalogueOrdinal ||
      expiryEvidence.conditionId !== target.metadata.conditionId ||
      expiryEvidence.finalExpiry !== target.metadata.finalExpiry ||
      expiryEvidence.observedAt !== authority.effectiveTime ||
      expiryEvidence.keysetMetadataDigest !==
        target.session.keysetMetadataDigest
    ) {
      throw new Error(
        "conditional recovery target expired without fresh retention authority",
      );
    }
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
    { currentBatch: state.session.currentBatch },
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

export async function fetchConditionalRecoveryNut07CommitAuthority(input: {
  readonly catalogue: CompletedConditionalRecoveryCatalogue;
  readonly target: ValidatedConditionalRecoveryTarget;
  readonly walletScope: ConditionalRecoveryWalletScope;
  readonly proofBatch: ChargedConditionalRecoveryProofBatch;
  readonly transport: ConditionalRecoveryNut07TransportPort;
}): Promise<ConditionalRecoveryNut07CommitAuthority> {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const target = requireValidatedTarget(input.target, catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(catalogue.walletScope, walletScope);
  assertConditionalRecoveryWalletScopeMatches(target.walletScope, walletScope);
  const { batch, state } = requireChargedProofBatch(
    input.proofBatch,
    catalogue,
    target,
  );
  assertExactProofBatchUnchanged(batch, state, state.originalArray);
  if (
    batch.proofCount === 0 ||
    state.session.transition !== "proof-verification" ||
    state.session.currentBatch?.stagedBatchId !== batch.stagedBatchId
  ) {
    throw new Error(
      "conditional recovery NUT-07 requires the exact verified staged batch",
    );
  }
  const endpoint = new URL(
    "/v1/checkstate",
    walletScope.mintUrl,
  ).toString();
  const requestBytes = encoder.encode(JSON.stringify({ Ys: state.ys }));
  const requestDigest = digestValue([
    "conditional-recovery-nut07-request-v1",
    endpoint,
    walletScope,
    state.session.digest,
    batch.stagedBatchId,
    batch.proofYDigest,
    bytesToHex(requestBytes),
  ]);
  const remaining = checkedSafeAdd(
    CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
    -state.session.budget.transportBytes,
    "remaining NUT-07 transport budget",
  );
  const maxEntityBytes = Math.min(
    CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
    remaining,
  );
  const responseBytes = await input.transport.fetchNut07Entity({
    walletScope,
    endpoint,
    requestBytes: new Uint8Array(requestBytes),
    maxEntityBytes,
  });
  if (
    !(responseBytes instanceof Uint8Array) ||
    responseBytes.byteLength > maxEntityBytes
  ) {
    throw new Error(
      "conditional recovery NUT-07 transport exceeded its exact entity bound",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
    ) as unknown;
  } catch {
    throw new Error(
      "conditional recovery NUT-07 response entity is not exact valid JSON",
    );
  }
  const response = requireObject(
    parsed,
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
    if (!expectedPositions.has(y) || states.has(y)) {
      throw new Error(
        "conditional recovery NUT-07 response Y set is foreign or repeated",
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
    transportBytes: requireBoundedPageBytes(responseBytes.byteLength),
    serializedBytes: checkedSafeAdd(
      requestBytes.byteLength,
      responseBytes.byteLength,
      "NUT-07 serialized bytes",
    ),
    workUnits: checkedSafeAdd(response.states.length, 1, "NUT-07 work"),
  });
  const responseDigest = digestValue([
    "conditional-recovery-nut07-response-v1",
    bytesToHex(responseBytes),
  ]);
  const issuedAt = performance.now();
  const deadline = issuedAt + 5_000;
  const authorityDigest = digestValue([
    "conditional-recovery-nut07-commit-authority-v1",
    walletScope,
    state.session.digest,
    batch.stagedBatchId,
    batch.proofYDigest,
    requestDigest,
    responseDigest,
    results,
    issuedAt,
    deadline,
    budget,
  ]);
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
    session: state.session,
    budget,
  });
  let authority!: ConditionalRecoveryNut07CommitAuthority;
  authority = Object.freeze({
    consumeAtCommitInitiation: () => {
      const authorityState = nut07CommitAuthorities.get(authority);
      if (
        authorityState === undefined ||
        !authorityState.valid ||
        authorityState.consumed
      ) {
        throw new Error(
          "conditional recovery NUT-07 commit authority is invalid or already consumed",
        );
      }
      const now = performance.now();
      if (now < authorityState.issuedAt || now > authorityState.deadline) {
        authorityState.valid = false;
        throw new Error(
          "conditional recovery NUT-07 commit authority monotonic age is invalid",
        );
      }
      authorityState.consumed = true;
      return Object.freeze({
        authorityDigest: authorityState.authorityDigest,
        monotonicAgeMs: now - authorityState.issuedAt,
      });
    },
  });
  nut07CommitAuthorities.set(authority, {
    batchState: state,
    classification,
    authorityDigest,
    issuedAt,
    deadline,
    valid: true,
    consumed: false,
  });
  return authority;
}

export function authorizeConditionalRecoveryAdmission(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  target: ValidatedConditionalRecoveryTarget;
  verifiedProofs: VerifiedConditionalRecoveryProofBatch;
  nut07Authority: ConditionalRecoveryNut07CommitAuthority;
  walletScope: ConditionalRecoveryWalletScope;
  proofs: readonly ProofLike[];
  authority: ConditionalRecoveryAuthorityObservation;
  admissionPort: ConditionalRecoveryAdmissionPort;
}): ConditionalRecoveryAdmissionAuthorization {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const target = requireValidatedTarget(input.target, catalogue);
  const expiryObservation = consumeAuthority(input.authority, catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(catalogue.walletScope, walletScope);
  assertConditionalRecoveryWalletScopeMatches(target.walletScope, walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    expiryObservation.walletScope,
    walletScope,
  );
  if (
    !isConditionalRecoveryKeysetRecoverable(
      target.metadata,
      expiryObservation.effectiveTime,
    )
  ) {
    throw new Error("conditional recovery target expired before admission");
  }
  const verifiedState = requireVerifiedProofBatch(
    input.verifiedProofs,
    catalogue,
    target,
  );
  const nut07State = nut07CommitAuthorities.get(input.nut07Authority);
  if (nut07State?.consumed === true) {
    throw new Error(
      "conditional recovery NUT-07 commit authority was already consumed",
    );
  }
  if (
    nut07State === undefined ||
    nut07State.batchState !== verifiedState ||
    !nut07State.valid
  ) {
    throw new Error(
      "conditional recovery NUT-07 commit authority is foreign or stale",
    );
  }
  if (input.admissionPort !== verifiedState.sessionPort) {
    throw new Error(
      "conditional recovery admission must use the session CAS adapter",
    );
  }
  if (consumedVerifiedProofBatches.has(input.verifiedProofs)) {
    throw new Error("conditional recovery verified proof evidence was consumed");
  }
  assertExactProofBatchUnchanged(
    {
      proofBodyDigest: input.verifiedProofs.proofBodyDigest,
      proofYDigest: input.verifiedProofs.proofYDigest,
    },
    verifiedState,
    input.proofs,
  );
  const selectableProofs: CanonicalConditionalRecoveryProof[] = [];
  const pendingProofs: CanonicalConditionalRecoveryProof[] = [];
  const spentProofs: CanonicalConditionalRecoveryProof[] = [];
  const rows: ConditionalRecoveryProofDispositionRow[] = [];
  for (const result of nut07State.classification.results) {
    const proof = verifiedState.canonical[result.proofIndex]!;
    const proofIdentity =
      input.verifiedProofs.proofIdentities[result.proofIndex]!;
    switch (classifySeedRecoveryMintState(result.state)) {
      case "selectable":
        selectableProofs.push(proof);
        rows.push(
          Object.freeze({
            proofIdentity,
            state: "UNSPENT",
            disposition: "selectable-wallet-custody",
            proof,
          }),
        );
        break;
      case "retain-nonselectable":
        pendingProofs.push(proof);
        rows.push(
          Object.freeze({
            proofIdentity,
            state: "PENDING",
            disposition: "pending-mint-state",
            proof,
          }),
        );
        break;
      case "spent":
        spentProofs.push(proof);
        rows.push(
          Object.freeze({
            proofIdentity,
            state: "SPENT",
            disposition: "spent-audit",
            proof,
          }),
        );
        break;
      case "fail-closed":
        throw new Error(
          "conditional recovery NUT-07 disposition cannot be admitted",
        );
      default:
        assertNever(
          classifySeedRecoveryMintState(result.state) as never,
        );
    }
  }
  const dispositionRows = Object.freeze(rows);
  const currentSession = verifiedState.session;
  requireLiveSession(currentSession, walletScope);
  const evidenceDigest = digestValue([
    "conditional-recovery-admission-v2",
    nut07State.authorityDigest,
    nut07State.classification.results,
    dispositionRows,
    nut07State.classification.budget,
  ]);
  const successorSession = freezeSession({
    walletScope,
    sequence: checkedSafeAdd(currentSession.sequence, 1, "session sequence"),
    predecessorDigest: currentSession.digest,
    transition: "atomic-admission",
    evidenceDigest,
    budget: nut07State.classification.budget,
    catalogueDigest: currentSession.catalogueDigest,
    completedKeysetProofCount: currentSession.completedKeysetProofCount,
    catalogueOrdinal: currentSession.catalogueOrdinal,
    activeKeysetId: currentSession.activeKeysetId,
    keysetMetadataDigest: currentSession.keysetMetadataDigest,
    scan: currentSession.scan,
    currentBatch: currentSession.currentBatch,
    keysetTerminalEvidence: null,
    skipEvidence: null,
    terminalEvidence: null,
  });
  validateConditionalRecoverySessionSuccessor(currentSession, successorSession);
  const committed = input.admissionPort.compareAndSwapInsertUnique({
    walletScope,
    expectedSessionDigest: currentSession.digest,
    successorSession,
    stagedBatchId: currentSession.currentBatch!.stagedBatchId!,
    rows: dispositionRows,
    nut07Authority: input.nut07Authority,
  });
  if (
    committed !== true ||
    !nut07State.consumed
  ) {
    nut07State.valid = false;
    throw new Error(
      committed === true
        ? "conditional recovery admission port omitted NUT-07 commit consumption"
        : "conditional recovery atomic admission CAS or global proof uniqueness failed",
    );
  }
  adoptExternallyCommittedConditionalRecoverySession(
    currentSession,
    successorSession,
    verifiedState.sessionPort,
  );
  consumedVerifiedProofBatches.add(input.verifiedProofs);
  return Object.freeze({
    walletScope,
    keysetId: target.metadata.id,
    authorizedAt: expiryObservation.effectiveTime,
    session: successorSession,
    selectableProofs: Object.freeze(selectableProofs),
    pendingProofs: Object.freeze(pendingProofs),
    spentProofs: Object.freeze(spentProofs),
  });
}

export function retainExpiredConditionalRecoveryKeyset(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  target: ValidatedConditionalRecoveryTarget;
  verifiedProofs: VerifiedConditionalRecoveryProofBatch;
  nut07Authority: ConditionalRecoveryNut07CommitAuthority;
  walletScope: ConditionalRecoveryWalletScope;
  proofs: readonly ProofLike[];
  expiryAuthority: ConditionalRecoveryFreshExpiryEvidence;
  sessionPort: ConditionalRecoverySessionCasPort;
}): ConditionalRecoverySession {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const target = requireValidatedTarget(input.target, catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(target.walletScope, walletScope);
  const verifiedState = requireVerifiedProofBatch(
    input.verifiedProofs,
    catalogue,
    target,
  );
  const nut07State = nut07CommitAuthorities.get(input.nut07Authority);
  if (
    nut07State === undefined ||
    nut07State.batchState !== verifiedState ||
    !nut07State.valid ||
    nut07State.consumed ||
    input.sessionPort !== verifiedState.sessionPort ||
    !freshExpiryEvidence.has(input.expiryAuthority)
  ) {
    throw new Error(
      "conditional recovery expired-keyset retention authority is invalid",
    );
  }
  const authority = input.expiryAuthority;
  if (
    authority.catalogueOrdinal !== target.session.catalogueOrdinal ||
    authority.keysetId !== target.metadata.id ||
    authority.conditionId !== target.metadata.conditionId ||
    authority.finalExpiry !== target.metadata.finalExpiry ||
    authority.keysetMetadataDigest !== target.session.keysetMetadataDigest ||
    authority.observedAt < authority.finalExpiry
  ) {
    throw new Error(
      "conditional recovery expired-keyset retention authority mismatched the session",
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
  const currentSession = verifiedState.session;
  const stagedBatchId = currentSession.currentBatch?.stagedBatchId;
  if (stagedBatchId === null || stagedBatchId === undefined) {
    throw new Error(
      "conditional recovery expired-keyset retention has no staged batch",
    );
  }
  const rows = Object.freeze(
    nut07State.classification.results.map((result) => {
      const proof = verifiedState.canonical[result.proofIndex]!;
      const proofIdentity =
        input.verifiedProofs.proofIdentities[result.proofIndex]!;
      if (result.state === "SPENT") {
        return Object.freeze({
          proofIdentity,
          state: "SPENT" as const,
          disposition: "spent-audit" as const,
          proof,
        });
      }
      return Object.freeze({
        proofIdentity,
        state: result.state,
        disposition: "expired-keyset" as const,
        proof,
      });
    }),
  );
  const successor = freezeSession({
    walletScope,
    sequence: checkedSafeAdd(currentSession.sequence, 1, "session sequence"),
    predecessorDigest: currentSession.digest,
    transition: "expired-keyset-retention",
    evidenceDigest: digestValue([
      "conditional-recovery-expired-retention-v2",
      authority,
      nut07State.authorityDigest,
      nut07State.classification.results,
      stagedBatchId,
      rows,
      nut07State.classification.budget,
    ]),
    budget: nut07State.classification.budget,
    catalogueDigest: currentSession.catalogueDigest,
    completedKeysetProofCount: currentSession.completedKeysetProofCount,
    catalogueOrdinal: currentSession.catalogueOrdinal,
    activeKeysetId: currentSession.activeKeysetId,
    keysetMetadataDigest: currentSession.keysetMetadataDigest,
    scan: currentSession.scan,
    currentBatch: currentSession.currentBatch,
    keysetTerminalEvidence: null,
    skipEvidence: null,
    terminalEvidence: null,
  });
  validateConditionalRecoverySessionSuccessor(currentSession, successor);
  input.nut07Authority.consumeAtCommitInitiation();
  if (!nut07State.consumed) {
    nut07State.valid = false;
    throw new Error(
      "conditional recovery NUT-07 commit authority did not consume",
    );
  }
  const committed = input.sessionPort.compareAndSwapRetainExpiredKeyset({
    expectedSessionDigest: currentSession.digest,
    successor,
    stagedBatchId,
    expiryAuthority: authority,
    rows,
  });
  if (committed !== true) {
    nut07State.valid = false;
    throw new Error(
      "conditional recovery expired-keyset retention CAS failed",
    );
  }
  adoptExternallyCommittedConditionalRecoverySession(
    currentSession,
    successor,
    verifiedState.sessionPort,
  );
  consumedVerifiedProofBatches.add(input.verifiedProofs);
  freshExpiryEvidence.delete(authority);
  return successor;
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

interface ConditionalRecoveryCommonRehydrationEvidence {
  readonly catalogue: CompletedConditionalRecoveryCatalogue;
}

interface ConditionalRecoveryTargetRehydrationEvidence
  extends ConditionalRecoveryCommonRehydrationEvidence {
  readonly keysResponse: unknown;
}

interface ConditionalRecoveryPlanRehydrationEvidence
  extends ConditionalRecoveryTargetRehydrationEvidence {
  readonly derivationPort: ConditionalRecoveryNut13DerivationPort;
}

interface ConditionalRecoveryRequestRehydrationEvidence
  extends ConditionalRecoveryPlanRehydrationEvidence {
  readonly requestBytes: Uint8Array;
}

interface ConditionalRecoveryBatchRehydrationEvidence
  extends ConditionalRecoveryRequestRehydrationEvidence {
  readonly responseBytes: Uint8Array;
  readonly stagedProofRows: readonly CanonicalConditionalRecoveryProof[];
}

export type ConditionalRecoverySessionRehydrationEvidence =
  | (ConditionalRecoveryCommonRehydrationEvidence & {
      readonly stage:
        | "completed-catalogue"
        | "keyset-completed"
        | "keyset-skipped";
    })
  | (ConditionalRecoveryTargetRehydrationEvidence & {
      readonly stage:
        | "conditional-keys"
        | "atomic-admission"
        | "expired-keyset-retention";
    })
  | (ConditionalRecoveryPlanRehydrationEvidence & {
      readonly stage: "nut13-plan";
    })
  | (ConditionalRecoveryRequestRehydrationEvidence & {
      readonly stage: "nut09-request";
    })
  | (ConditionalRecoveryBatchRehydrationEvidence & {
      readonly stage: "nut09-response" | "proof-verification";
    });

export interface ConditionalRecoverySessionCapabilities {
  readonly session: ConditionalRecoverySession;
  readonly catalogue: CompletedConditionalRecoveryCatalogue;
  readonly target: ValidatedConditionalRecoveryTarget | null;
  readonly plan: SeedDerivedConditionalRecoveryPlan | null;
  readonly request: ConditionalRecoveryNut09RequestAuthorization | null;
  readonly proofBatch: ChargedConditionalRecoveryProofBatch | null;
  readonly verifiedProofs: VerifiedConditionalRecoveryProofBatch | null;
}

export async function rehydrateConditionalRecoverySessionCapabilities(
  session: ConditionalRecoverySession,
  evidence: ConditionalRecoverySessionRehydrationEvidence,
  sessionPort: ConditionalRecoverySessionCasPort,
): Promise<ConditionalRecoverySessionCapabilities> {
  if (
    session.transition === "recovery-completed" ||
    session.transition === "recovery-failed-closed"
  ) {
    throw new Error(
      "conditional recovery terminal session has no rehydratable capabilities",
    );
  }
  const evidenceRow = requireObject(
    evidence,
    "conditional recovery session rehydration evidence",
  );
  const evidenceKeys: Record<
    ConditionalRecoverySessionRehydrationEvidence["stage"],
    readonly string[]
  > = {
    "completed-catalogue": ["stage", "catalogue"],
    "keyset-completed": ["stage", "catalogue"],
    "keyset-skipped": ["stage", "catalogue"],
    "conditional-keys": ["stage", "catalogue", "keysResponse"],
    "nut13-plan": ["stage", "catalogue", "keysResponse", "derivationPort"],
    "nut09-request": [
      "stage",
      "catalogue",
      "keysResponse",
      "derivationPort",
      "requestBytes",
    ],
    "nut09-response": [
      "stage",
      "catalogue",
      "keysResponse",
      "derivationPort",
      "requestBytes",
      "responseBytes",
      "stagedProofRows",
    ],
    "proof-verification": [
      "stage",
      "catalogue",
      "keysResponse",
      "derivationPort",
      "requestBytes",
      "responseBytes",
      "stagedProofRows",
    ],
    "atomic-admission": ["stage", "catalogue", "keysResponse"],
    "expired-keyset-retention": ["stage", "catalogue", "keysResponse"],
  };
  const exactEvidenceKeys = evidenceKeys[evidence.stage];
  if (exactEvidenceKeys === undefined) {
    throw new Error("conditional recovery rehydration stage is unsupported");
  }
  requireExactKeys(
    evidenceRow,
    exactEvidenceKeys,
    "conditional recovery session rehydration evidence",
  );
  if (evidence.stage !== session.transition) {
    throw new Error(
      "conditional recovery rehydration evidence is for the wrong stage",
    );
  }
  const catalogue = requireCompletedCatalogue(evidence.catalogue);
  assertConditionalRecoveryWalletScopeMatches(
    catalogue.walletScope,
    session.walletScope,
  );
  if (
    digestValue([catalogue.capability, catalogue.keysets]) !==
    session.catalogueDigest
  ) {
    throw new Error(
      "conditional recovery rehydrated catalogue does not match the session",
    );
  }

  let target: ValidatedConditionalRecoveryTarget | null = null;
  let plan: SeedDerivedConditionalRecoveryPlan | null = null;
  let request: ConditionalRecoveryNut09RequestAuthorization | null = null;
  let proofBatch: ChargedConditionalRecoveryProofBatch | null = null;
  let verifiedProofs: VerifiedConditionalRecoveryProofBatch | null = null;
  if ("keysResponse" in evidence) {
    target = rehydrateConditionalRecoveryTarget({
      catalogue,
      session,
      keysResponse: evidence.keysResponse,
      sessionPort,
    });
  }
  if ("derivationPort" in evidence) {
    if (
      target === null ||
      session.currentBatch === null ||
      typeof evidence.derivationPort?.deriveSeedOutputs !== "function"
    ) {
      throw new Error(
        "conditional recovery persisted NUT-13 derivation evidence is missing",
      );
    }
    plan = await rederivePersistedConditionalRecoveryPlan({
      target,
      session,
      port: evidence.derivationPort,
    });
  }
  if ("requestBytes" in evidence) {
    if (
      target === null ||
      plan === null ||
      !(evidence.requestBytes instanceof Uint8Array)
    ) {
      throw new Error(
        "conditional recovery persisted dispatched request evidence is missing",
      );
    }
    request = rehydratePersistedConditionalRecoveryRequest({
      catalogue,
      target,
      plan,
      session,
      requestBytes: evidence.requestBytes,
      sessionPort,
    });
  }
  if ("responseBytes" in evidence) {
    if (
      target === null ||
      plan === null ||
      request === null ||
      !(evidence.responseBytes instanceof Uint8Array) ||
      !Array.isArray(evidence.stagedProofRows)
    ) {
      throw new Error(
        "conditional recovery persisted staged response evidence is missing",
      );
    }
    proofBatch = rehydratePersistedConditionalRecoveryBatch({
      catalogue,
      target,
      plan,
      request,
      session,
      responseBytes: evidence.responseBytes,
      rows: evidence.stagedProofRows,
      sessionPort,
    });
    if (session.transition === "proof-verification") {
      const proofBatchState = chargedProofBatches.get(proofBatch);
      if (proofBatchState === undefined) {
        throw new Error(
          "conditional recovery rehydrated proof batch state is missing",
        );
      }
      try {
        verifyProofsForReceive(
          [...proofBatchState.originalArray],
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
          "conditional recovery rehydrated proofs failed cryptographic verification",
        );
      }
      verifiedProofs = Object.freeze({
        walletScope: proofBatch.walletScope,
        keysetId: proofBatch.keysetId,
        proofCount: proofBatch.proofCount,
        proofBodyDigest: proofBatch.proofBodyDigest,
        proofYDigest: proofBatch.proofYDigest,
        requestDigest: proofBatch.requestDigest,
        responseDigest: proofBatch.responseDigest,
        planDigest: proofBatch.planDigest,
        proofIdentities: proofBatch.proofIdentities,
        session,
        verifiedAt: 0,
        budget: session.budget,
      });
      verifiedProofBatches.set(verifiedProofs, proofBatchState);
    }
  }
  registerRehydratedConditionalRecoverySession({ session, sessionPort });
  return Object.freeze({
    session,
    catalogue,
    target,
    plan,
    request,
    proofBatch,
    verifiedProofs,
  });
}

async function rederivePersistedConditionalRecoveryPlan(input: {
  readonly target: ValidatedConditionalRecoveryTarget;
  readonly session: ConditionalRecoverySession;
  readonly port: ConditionalRecoveryNut13DerivationPort;
}): Promise<SeedDerivedConditionalRecoveryPlan> {
  const binding = input.session.currentBatch!;
  const rawOutputs = await input.port.deriveSeedOutputs({
    walletScope: input.session.walletScope,
    keysetId: input.target.metadata.id,
    startCounter: binding.planStart,
    count: binding.planCount,
  });
  if (!Array.isArray(rawOutputs) || rawOutputs.length !== binding.planCount) {
    throw new Error("conditional recovery rehydrated NUT-13 plan is invalid");
  }
  const outputs = rawOutputs.map((raw, index) => {
    const row = requireObject(raw, "conditional recovery NUT-13 output");
    const counter = requireSafeInteger(row.counter, "NUT-13 counter");
    if (counter !== binding.planStart + index) {
      throw new Error("conditional recovery NUT-13 counters are not exact");
    }
    if (typeof row.unblind !== "function") {
      throw new Error(
        "conditional recovery NUT-13 derivation omitted unblinding authority",
      );
    }
    return Object.freeze({
      counter,
      id: requireV2KeysetId(row.id),
      amount: canonicalRestoreOutputAmount(
        row.amount,
        "conditional recovery rehydrated NUT-13 amount",
      ),
      B_: requireCompressedSecpPublicKey(row.B_, "NUT-13 output B_"),
      Y: requireCompressedSecpPublicKey(row.Y, "NUT-13 output Y"),
    });
  });
  const digest = digestValue([
    "conditional-recovery-nut13-plan-v1",
    input.session.walletScope,
    outputs.map(({ counter, id, amount, B_, Y }) => ({
      counter,
      id,
      amount,
      B_,
      Y,
    })),
  ]);
  if (digest !== binding.planDigest) {
    throw new Error("conditional recovery rehydrated NUT-13 plan changed");
  }
  const plan = Object.freeze({
    walletScope: input.session.walletScope,
    keysetId: input.target.metadata.id,
    outputs: Object.freeze(outputs),
    digest,
    session: input.session,
    budget: input.session.budget,
  });
  seedPlans.set(plan, {
    target: input.target,
    privateOutputs: Object.freeze(rawOutputs),
  });
  return plan;
}

function rehydratePersistedConditionalRecoveryRequest(input: {
  readonly catalogue: CompletedConditionalRecoveryCatalogue;
  readonly target: ValidatedConditionalRecoveryTarget;
  readonly plan: SeedDerivedConditionalRecoveryPlan;
  readonly session: ConditionalRecoverySession;
  readonly requestBytes: Uint8Array;
  readonly sessionPort: ConditionalRecoverySessionCasPort;
}): ConditionalRecoveryNut09RequestAuthorization {
  const expectedRequestBytes = encoder.encode(
    JSON.stringify({
      outputs: input.plan.outputs.map(({ id, amount, B_ }) => ({
        id,
        amount,
        B_,
      })),
    }),
  );
  if (!equalBytes(input.requestBytes, expectedRequestBytes)) {
    throw new Error(
      "conditional recovery dispatched NUT-09 request replay changed bytes",
    );
  }
  requireBoundedPageBytes(input.requestBytes.byteLength);
  const binding = input.session.currentBatch!;
  const requestDigest = digestValue([
    "conditional-recovery-nut09-request-v2",
    input.session.walletScope.mintUrl,
    input.session.walletScope.unit,
    bytesToHex(input.requestBytes),
  ]);
  if (requestDigest !== binding.requestDigest) {
    throw new Error(
      "conditional recovery dispatched NUT-09 request replay changed bytes",
    );
  }
  const request = Object.freeze({
    walletScope: input.session.walletScope,
    keysetId: input.target.metadata.id,
    outputs: input.plan.outputs,
    requestBytes: new Uint8Array(input.requestBytes),
    requestDigest,
    planDigest: input.plan.digest,
    session: input.session,
  });
  nut09Requests.set(request, {
    catalogue: input.catalogue,
    target: input.target,
    plan: input.plan,
    sessionPort: input.sessionPort,
  });
  return request;
}

function rehydratePersistedConditionalRecoveryBatch(input: {
  readonly catalogue: CompletedConditionalRecoveryCatalogue;
  readonly target: ValidatedConditionalRecoveryTarget;
  readonly plan: SeedDerivedConditionalRecoveryPlan;
  readonly request: ConditionalRecoveryNut09RequestAuthorization;
  readonly session: ConditionalRecoverySession;
  readonly responseBytes: Uint8Array;
  readonly rows: readonly CanonicalConditionalRecoveryProof[];
  readonly sessionPort: ConditionalRecoverySessionCasPort;
}): ChargedConditionalRecoveryProofBatch {
  requireBoundedPageBytes(input.responseBytes.byteLength);
  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.responseBytes),
    );
  } catch {
    throw new Error(
      "conditional recovery persisted NUT-09 response is not exact valid JSON",
    );
  }
  const response = requireObject(
    parsedResponse,
    "conditional recovery persisted NUT-09 response",
  );
  requireExactKeys(
    response,
    ["outputs", "signatures"],
    "conditional recovery persisted NUT-09 response",
  );
  if (
    !Array.isArray(response.outputs) ||
    !Array.isArray(response.signatures) ||
    response.outputs.length !== response.signatures.length ||
    response.outputs.length !== input.rows.length
  ) {
    throw new Error(
      "conditional recovery persisted NUT-09 response proof count is invalid",
    );
  }
  const binding = input.session.currentBatch!;
  const snapshot = canonicalizeProofBatch(
    input.rows as readonly ProofLike[],
    input.target.metadata.id,
    true,
  );
  if (snapshot.canonical.length !== binding.returnedCount) {
    throw new Error(
      "conditional recovery staged proof rows do not match returned count",
    );
  }
  const responseDigest = digestValue([
    "conditional-recovery-nut09-response-v2",
    bytesToHex(input.responseBytes),
  ]);
  const proofBodyDigest = digestCanonicalProofs(snapshot.canonical);
  const proofYDigest = digestProofYs(snapshot.canonical, snapshot.ys);
  const stagedBatchId =
    snapshot.canonical.length === 0
      ? null
      : digestValue([
          "conditional-recovery-staged-batch-v1",
          input.request.requestDigest,
          responseDigest,
          proofBodyDigest,
        ]);
  if (
    responseDigest !== binding.batchDigest ||
    stagedBatchId !== binding.stagedBatchId
  ) {
    throw new Error(
      "conditional recovery staged response does not match session bindings",
    );
  }
  const proofIdentities = Object.freeze(
    snapshot.ys.map((y) =>
      digestValue([
        "conditional-recovery-global-proof-v1",
        input.session.walletScope.mintUrl,
        input.session.walletScope.unit,
        input.target.metadata.id,
        y,
      ]),
    ),
  );
  const admittedProofs = Object.freeze(
    snapshot.canonical.map((proof) => {
      const witness = rehydrateProofLikeWitness(proof.witness);
      return Object.freeze({
        id: proof.id,
        amount: proof.amount,
        secret: proof.secret,
        C: proof.C,
        dleq: proof.dleq,
        ...(proof.p2pkE === null ? {} : { p2pk_e: proof.p2pkE }),
        ...(witness === undefined ? {} : { witness }),
      });
    }),
  );
  const proofBatch = Object.freeze({
    walletScope: input.session.walletScope,
    keysetId: input.target.metadata.id,
    proofCount: snapshot.canonical.length,
    proofBodyDigest,
    proofYDigest,
    requestDigest: input.request.requestDigest,
    responseDigest,
    planDigest: input.plan.digest,
    proofIdentities,
    stagedBatchId,
    proofs: admittedProofs,
    session: input.session,
    budget: input.session.budget,
  });
  chargedProofBatches.set(proofBatch, {
    catalogue: input.catalogue,
    target: input.target,
    originalArray: admittedProofs,
    originalRows: admittedProofs,
    canonical: snapshot.canonical,
    ys: snapshot.ys,
    session: input.session,
    sessionPort: input.sessionPort,
  });
  return proofBatch;
}

function rehydrateProofLikeWitness(
  value: CanonicalConditionalRecoveryProof["witness"],
):
  | string
  | { readonly signatures?: string[] }
  | { readonly preimage: string; readonly signatures?: string[] }
  | undefined {
  if (value === null) return undefined;
  if (typeof value === "string") return value;
  let signatures: string[] | undefined;
  if (hasOwn(value, "signatures")) {
    if (!Array.isArray(value.signatures)) {
      throw new Error(
        "conditional recovery persisted proof witness signatures are invalid",
      );
    }
    signatures = value.signatures.map((signature) => {
      if (typeof signature !== "string") {
        throw new Error(
          "conditional recovery persisted proof witness signature is invalid",
        );
      }
      return signature;
    });
  }
  if (hasOwn(value, "preimage")) {
    if (typeof value.preimage !== "string") {
      throw new Error(
        "conditional recovery persisted proof witness preimage is invalid",
      );
    }
    return {
      preimage: value.preimage,
      ...(signatures === undefined ? {} : { signatures }),
    };
  }
  return signatures === undefined ? {} : { signatures };
}


function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
