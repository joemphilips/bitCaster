import {
  Amount,
  CheckStateEnum,
  hashToCurve,
  hashToCurveBls,
  isBlsKeyset,
  OutputData,
  type MintKeys,
  type OutputDataLike,
  type Proof,
  type ProofState,
} from "@cashu/cashu-ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  allStates,
  deserializeOutputGroups,
  normalizeProofArray,
  restoreOutputGroups as defaultRestoreOutputGroups,
  serializeOutputDataArray,
  type CtfCommittedProofOperationStore,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from "./ctfSplit.ts";
import { amountToNumber } from "./proofSelection.ts";
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
} from "./durableWalletProofTransition.ts";

/**
 * Shared NUT-CTF redeem helpers.
 *
 * The mint is the sole authority that can condemn an outcome-token leg. The
 * terminal CDK error code below means the keyset's outcome collection does not
 * include the oracle-attested outcome.
 */
export const ORACLE_NOT_ATTESTED_OUTCOME_CODE = 13015;
const CTF_REDEEM_REQUEST_VERSION = 1;
const CTF_REDEEM_WITNESS_BYTES_MAX = 65_536;
const CTF_REDEEM_REQUEST_BYTES_MAX = 1_048_576;

export interface RedeemWallet {
  mint: {
    readonly mintUrl: string;
    getKeys(keysetId?: string): Promise<{ keysets: MintKeys[] }>;
  };
  loadMint(): Promise<void>;
  redeemOutcomeProofs(options: {
    inputs: Proof[];
    outputs: OutputDataLike[];
  }): Promise<Proof[]>;
  checkProofsStates?(
    proofs: Array<Pick<Proof, "id" | "secret">>,
  ): Promise<ProofState[]>;
}

export interface RedeemOutcomeLegResult {
  proofs: Proof[];
  losing: boolean;
}

export interface VerifiedCtfLosingOutcomeEvidence {
  readonly schemaVersion: 1;
  readonly operationIdDigest: string;
  readonly requestDigest: string;
  readonly failureCode: typeof ORACLE_NOT_ATTESTED_OUTCOME_CODE;
  readonly classifiedAt: number;
}

export interface CtfLosingOutcomeProofIdentity {
  readonly id: string;
  readonly amount: unknown;
  readonly secret: string;
  readonly C: string;
  readonly dleq?: Readonly<{ e: string; s: string; r?: string }>;
}

interface VerifiedCtfLosingOutcomeAuthority {
  readonly operationId: string;
  readonly mintUrl: string;
  readonly conditionId: string;
  readonly outcome: string;
  readonly keysetId: string;
  readonly oracleWitness: string;
  readonly proofRequestDigest: string;
}

const VERIFIED_CTF_LOSING_OUTCOMES = new WeakMap<
  object,
  VerifiedCtfLosingOutcomeAuthority
>();

export type RestoreOutputGroups = (
  mintUrl: string,
  outputs: CtfProofOperationRecord["outputs"],
) => Promise<Record<string, Proof[]>>;

export async function redeemOutcomeLegWithOperation(params: {
  mintUrl: string;
  operationId: string;
  wallet: RedeemWallet;
  proofOperationStore: CtfProofOperationStore;
  conditionId: string;
  outcome: string;
  outcomeKeysetId?: string;
  unit: string;
  oracleWitness: string;
  proofs: Proof[];
  regularKeyset?: MintKeys;
  restoreOutputGroups?: RestoreOutputGroups;
  onLosingLeg?: (inputs: Proof[]) => Promise<void>;
}): Promise<RedeemOutcomeLegResult> {
  if (params.proofs.length === 0) return { proofs: [], losing: false };

  const mintUrl = requireNormalizedMintUrl(params.mintUrl);

  const existing = await params.proofOperationStore.getProofOperation(
    params.operationId,
  );
  if (existing) {
    return resumeCtfRedeem({
      ...params,
      mintUrl,
      entry: existing,
      restoreOutputGroups:
        params.restoreOutputGroups ?? defaultRestoreOutputGroups,
    });
  }

  requireWalletMintTransport(params.wallet, mintUrl);

  const inputs = normalizeProofArray(params.proofs);
  const oracleWitness = requireBoundedOracleWitness(params.oracleWitness);
  const amountSubunits = inputs.reduce(
    (sum, proof) => sum + amountToNumber(proof.amount),
    0,
  );
  if (!Number.isSafeInteger(amountSubunits) || amountSubunits <= 0) {
    throw new Error(
      "CTF redeem inputs must have a positive safe-integer total",
    );
  }
  const inputKeysetIds = new Set(inputs.map((proof) => proof.id));
  if (inputKeysetIds.size !== 1) {
    throw new Error("CTF redeem inputs must use one outcome keyset");
  }
  const outcomeKeysetId = [...inputKeysetIds][0]!;
  if (
    params.outcomeKeysetId !== undefined &&
    params.outcomeKeysetId !== outcomeKeysetId
  ) {
    throw new Error("CTF redeem outcome keyset does not match inputs");
  }

  await params.wallet.loadMint();
  const regularKeyset =
    params.regularKeyset ??
    (await getActiveRegularKeyset(params.wallet, params.unit));
  const outputData = OutputData.createRandomData(
    Amount.from(amountSubunits),
    regularKeyset,
  );
  const serializedOutputs = serializeOutputDataArray(outputData);
  const redeemRequestDigest = deriveCtfRedeemRequestDigest({
    operationId: params.operationId,
    mintUrl,
    inputs,
    outputs: { regular: serializedOutputs },
    oracleWitness,
  });

  const walletProofTransition = createDurableWalletProofTransition({
    inputSource: "wallet",
    plannedOutputLabels: ["regular"],
    resultGroups: {
      regular: { kind: "wallet", asset: "regular", reservedBy: null },
    },
  });
  await params.proofOperationStore.prepareProofOperation({
    operationId: params.operationId,
    kind: "ctf-redeem",
    mintUrl,
    inputs,
    outputs: { regular: serializedOutputs },
    metadata: addDurableWalletProofTransitionMetadata(
      {
        conditionId: params.conditionId,
        outcome: params.outcome,
        amountSats: amountSubunits,
        amountSubunits,
        keysetId: outcomeKeysetId,
        regularKeysetId: regularKeyset.id,
        unit: params.unit,
        redeemRequestVersion: CTF_REDEEM_REQUEST_VERSION,
        oracleWitness,
        redeemRequestDigest,
      },
      walletProofTransition,
    ),
  });

  return executeCtfRedeem({
    wallet: params.wallet,
    proofOperationStore: params.proofOperationStore,
    operationId: params.operationId,
    inputs,
    outputData,
    oracleWitness,
    requestDigest: redeemRequestDigest,
    onLosingLeg: params.onLosingLeg,
  });
}

export function buildKeysetRedeemOperationId(
  conditionId: string,
  keysetId: string,
  sortedSecrets: readonly string[] | readonly Pick<Proof, "secret">[],
): string {
  const secrets = sortedSecrets
    .map((value) => (typeof value === "string" ? value : value.secret))
    .sort()
    .join("|");
  return ["ctf-redeem", conditionId.toLowerCase(), keysetId, secrets].join(":");
}

export async function getActiveRegularKeyset(
  wallet: Pick<RedeemWallet, "mint">,
  unit: string,
): Promise<MintKeys> {
  if (!wallet.mint || typeof wallet.mint.getKeys !== "function") {
    throw new Error("Cashu wallet adapter does not expose mint keyset lookup");
  }
  const response = await wallet.mint.getKeys();
  const keyset =
    response.keysets.find(
      (candidate) => candidate.unit === unit && candidate.active !== false,
    ) ?? response.keysets.find((candidate) => candidate.unit === unit);
  if (!keyset)
    throw new Error(`Mint did not return an active regular ${unit} keyset`);
  return keyset;
}

export function isLosingLegError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown };
    if (
      typeof e.code === "number" &&
      e.code === ORACLE_NOT_ATTESTED_OUTCOME_CODE
    ) {
      return true;
    }
  }
  return false;
}

export async function readVerifiedCtfLosingOutcomeEvidence(input: {
  store: CtfCommittedProofOperationStore;
  operationId: string;
  proof: CtfLosingOutcomeProofIdentity;
}): Promise<VerifiedCtfLosingOutcomeEvidence> {
  if (
    typeof input.store !== "object" ||
    input.store === null ||
    typeof input.store.withCommittedProofOperation !== "function"
  ) {
    throw new Error("committed CTF proof operation store is invalid");
  }
  const operationId = requireEvidenceText(
    input.operationId,
    "CTF losing operation id",
  );
  let callbackOpen = true;
  let callbackCalls = 0;
  let issued: VerifiedCtfLosingOutcomeEvidence | undefined;
  let returned: unknown;
  try {
    returned = await input.store.withCommittedProofOperation(
      operationId,
      (operation) => {
        if (!callbackOpen || callbackCalls++ !== 0) {
          throw new Error("committed CTF operation callback is invalid");
        }
        issued = issueVerifiedCtfLosingOutcomeEvidence({
          operation,
          operationId,
          proof: input.proof,
        });
        return issued;
      },
    );
  } finally {
    callbackOpen = false;
  }
  if (
    isThenable(returned) ||
    issued === undefined ||
    returned !== issued ||
    callbackCalls !== 1
  ) {
    throw new Error(
      "committed CTF operation read must be synchronous and exact",
    );
  }
  return issued;
}

function issueVerifiedCtfLosingOutcomeEvidence(input: {
  operation: CtfProofOperationRecord;
  operationId: string;
  proof: CtfLosingOutcomeProofIdentity;
}): VerifiedCtfLosingOutcomeEvidence {
  const operation = input.operation;
  if (
    operation.operationId !== input.operationId ||
    operation.kind !== "ctf-redeem" ||
    (operation.state !== "Failed" && operation.state !== "failed") ||
    operation.failureCode !== ORACLE_NOT_ATTESTED_OUTCOME_CODE ||
    !Number.isSafeInteger(operation.updatedAt) ||
    operation.updatedAt < 0
  ) {
    throw new Error("CTF losing outcome evidence is invalid");
  }
  const request = requireCtfRedeemRequestBinding(operation);
  if (
    operation.metadata.redeemMintSubmissionVersion !== 1 ||
    operation.metadata.redeemMintSubmissionRequestDigest !==
      request.requestDigest
  ) {
    throw new Error("CTF losing mint submission binding is invalid");
  }
  const conditionId = requireEvidenceText(
    operation.metadata.conditionId,
    "CTF losing condition",
  );
  const outcome = requireEvidenceText(
    operation.metadata.outcome,
    "CTF losing outcome",
  );
  const keysetId = requireEvidenceText(
    operation.metadata.keysetId,
    "CTF losing keyset",
  );
  const matching = operation.inputs.filter(
    (proof) =>
      proof.id === input.proof.id && proof.secret === input.proof.secret,
  );
  if (
    matching.length !== 1 ||
    keysetId !== input.proof.id ||
    deriveCtfRedeemProofRequestDigest(matching[0]!, request.oracleWitness) !==
      deriveCtfRedeemProofRequestDigest(input.proof, request.oracleWitness)
  ) {
    throw new Error("CTF losing outcome evidence does not match proof");
  }
  const evidence = Object.freeze({
    schemaVersion: 1 as const,
    operationIdDigest: bytesToHex(
      sha256(new TextEncoder().encode(operation.operationId)),
    ),
    requestDigest: request.requestDigest,
    failureCode: ORACLE_NOT_ATTESTED_OUTCOME_CODE,
    classifiedAt: operation.updatedAt,
  });
  VERIFIED_CTF_LOSING_OUTCOMES.set(evidence, {
    operationId: operation.operationId,
    mintUrl: operation.mintUrl,
    conditionId,
    outcome,
    keysetId,
    oracleWitness: request.oracleWitness,
    proofRequestDigest: deriveCtfRedeemProofRequestDigest(
      input.proof,
      request.oracleWitness,
    ),
  });
  return evidence;
}

export function requireVerifiedCtfLosingOutcomeEvidence(input: {
  evidence: VerifiedCtfLosingOutcomeEvidence;
  operationId?: string;
  mintUrl: string;
  conditionId: string;
  outcome: string;
  keysetId: string;
  proof: CtfLosingOutcomeProofIdentity;
}): VerifiedCtfLosingOutcomeEvidence {
  const authority =
    typeof input.evidence === "object" && input.evidence !== null
      ? VERIFIED_CTF_LOSING_OUTCOMES.get(input.evidence)
      : undefined;
  if (
    authority === undefined ||
    (input.operationId !== undefined &&
      authority.operationId !== input.operationId) ||
    authority.mintUrl !== input.mintUrl ||
    authority.conditionId !== input.conditionId ||
    authority.outcome !== input.outcome ||
    authority.keysetId !== input.keysetId ||
    authority.proofRequestDigest !==
      deriveCtfRedeemProofRequestDigest(input.proof, authority.oracleWitness)
  ) {
    throw new Error("CTF losing outcome evidence does not match proof");
  }
  return input.evidence;
}

async function resumeCtfRedeem(params: {
  mintUrl: string;
  entry: CtfProofOperationRecord;
  wallet: RedeemWallet;
  proofOperationStore: CtfProofOperationStore;
  oracleWitness: string;
  restoreOutputGroups: RestoreOutputGroups;
  onLosingLeg?: (inputs: Proof[]) => Promise<void>;
}): Promise<RedeemOutcomeLegResult> {
  const { entry } = params;
  if (entry.kind !== "ctf-redeem") {
    throw new Error(`proof operation ${entry.operationId} is not a CTF redeem`);
  }
  const persistedMintUrl = requireNormalizedMintUrl(entry.mintUrl);
  if (persistedMintUrl !== requireNormalizedMintUrl(params.mintUrl)) {
    throw new Error("CTF redeem mint does not match persisted operation");
  }
  const requestBinding = requireCtfRedeemRequestBinding(entry);
  if (entry.state === "completed") {
    const proofs = normalizeProofArray(entry.resultProofs?.regular ?? []);
    requireCommittedCtfRedeemCompletion(
      entry,
      entry.operationId,
      requestBinding.requestDigest,
      proofs,
    );
    return {
      proofs,
      losing: false,
    };
  }
  if (entry.state === "Failed" || entry.state === "failed") {
    if (entry.failureCode === ORACLE_NOT_ATTESTED_OUTCOME_CODE) {
      requireCommittedCtfRedeemFailure(
        entry,
        entry.operationId,
        requestBinding.requestDigest,
      );
      await params.onLosingLeg?.(normalizeProofArray(entry.inputs));
      return { proofs: [], losing: true };
    }
    throw new Error(
      `CTF redeem ${entry.operationId} failed with non-losing failure code ${entry.failureCode ?? "unknown"}; refusing to condemn proofs`,
    );
  }
  if (entry.state !== "prepared" && entry.state !== "mint-submitted") {
    throw new Error("CTF redeem operation state is invalid");
  }
  requireWalletMintTransport(params.wallet, persistedMintUrl);
  await params.wallet.loadMint();
  if (!params.wallet.checkProofsStates) {
    throw new Error(
      "Cashu wallet adapter does not support proof-state recovery checks",
    );
  }

  const inputs = entry.inputs.map(({ id, secret }) => ({ id, secret }));
  const states = requireExactCtfRedeemProofStates(
    await params.wallet.checkProofsStates(inputs),
    inputs,
  );
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await params.restoreOutputGroups(
      persistedMintUrl,
      entry.outputs,
    );
    const final = normalizeProofArray(restored.regular ?? []);
    const completed =
      await params.proofOperationStore.markProofOperationCompleted(
        entry.operationId,
        { regular: final },
      );
    requireCommittedCtfRedeemCompletion(
      completed,
      entry.operationId,
      requestBinding.requestDigest,
      final,
    );
    return { proofs: final, losing: false };
  }
  if (allStates(states, CheckStateEnum.UNSPENT)) {
    const outputData = deserializeOutputGroups(entry.outputs).regular ?? [];
    if (outputData.length === 0) {
      throw new Error(
        `proof operation ${entry.operationId} has no redeem outputs`,
      );
    }
    return executeCtfRedeem({
      wallet: params.wallet,
      proofOperationStore: params.proofOperationStore,
      operationId: entry.operationId,
      inputs: normalizeProofArray(entry.inputs),
      outputData,
      oracleWitness: requestBinding.oracleWitness,
      requestDigest: requestBinding.requestDigest,
      onLosingLeg: params.onLosingLeg,
    });
  }

  throw new Error(
    `Proof operation ${entry.operationId} is still pending at the mint`,
  );
}

async function executeCtfRedeem(params: {
  wallet: RedeemWallet;
  proofOperationStore: CtfProofOperationStore;
  operationId: string;
  inputs: Proof[];
  outputData: OutputDataLike[];
  oracleWitness: string;
  requestDigest: string;
  onLosingLeg?: (inputs: Proof[]) => Promise<void>;
}): Promise<RedeemOutcomeLegResult> {
  const submitted =
    await params.proofOperationStore.markProofOperationMintSubmitted(
      params.operationId,
      {
        schemaVersion: 1,
        requestDigest: params.requestDigest,
      },
    );
  requireCommittedCtfRedeemMintSubmission(
    submitted,
    params.operationId,
    params.requestDigest,
  );

  let settled: Proof[];
  try {
    settled = await params.wallet.redeemOutcomeProofs({
      inputs: withOracleWitness(params.inputs, params.oracleWitness),
      outputs: params.outputData,
    });
  } catch (error) {
    if (isLosingLegError(error)) {
      if (!params.proofOperationStore.markProofOperationFailed) {
        throw new Error(
          "proof operation store does not support terminal redeem failures",
        );
      }
      const failed = await params.proofOperationStore.markProofOperationFailed(
        params.operationId,
        "losing leg: mint returned OracleNotAttestedOutcome (13015)",
        ORACLE_NOT_ATTESTED_OUTCOME_CODE,
      );
      requireCommittedCtfRedeemFailure(
        failed,
        params.operationId,
        params.requestDigest,
      );
      await params.onLosingLeg?.(params.inputs);
      return { proofs: [], losing: true };
    }
    throw error;
  }

  const final = normalizeProofArray(settled);
  const completed =
    await params.proofOperationStore.markProofOperationCompleted(
      params.operationId,
      { regular: final },
    );
  requireCommittedCtfRedeemCompletion(
    completed,
    params.operationId,
    params.requestDigest,
    final,
  );
  return { proofs: final, losing: false };
}

function requireCommittedCtfRedeemMintSubmission(
  operation: CtfProofOperationRecord,
  operationId: string,
  requestDigest: string,
): void {
  if (
    operation.operationId !== operationId ||
    operation.kind !== "ctf-redeem" ||
    operation.state !== "mint-submitted"
  ) {
    throw new Error("CTF redeem mint submission was not committed exactly");
  }
  const request = requireCtfRedeemRequestBinding(operation);
  if (
    request.requestDigest !== requestDigest ||
    operation.metadata.redeemMintSubmissionVersion !== 1 ||
    operation.metadata.redeemMintSubmissionRequestDigest !== requestDigest
  ) {
    throw new Error("CTF redeem mint submission was not committed exactly");
  }
}

function requireCommittedCtfRedeemFailure(
  operation: CtfProofOperationRecord,
  operationId: string,
  requestDigest: string,
): void {
  if (
    operation.operationId !== operationId ||
    operation.kind !== "ctf-redeem" ||
    (operation.state !== "Failed" && operation.state !== "failed") ||
    operation.failureCode !== ORACLE_NOT_ATTESTED_OUTCOME_CODE
  ) {
    throw new Error("CTF redeem terminal failure was not committed exactly");
  }
  requireCommittedCtfRedeemRequestAndSubmission(
    operation,
    requestDigest,
    "terminal failure",
  );
}

function requireCommittedCtfRedeemCompletion(
  operation: CtfProofOperationRecord,
  operationId: string,
  requestDigest: string,
  expectedProofs: readonly Proof[],
): void {
  if (
    operation.operationId !== operationId ||
    operation.kind !== "ctf-redeem" ||
    operation.state !== "completed" ||
    operation.resultProofs === undefined ||
    Object.keys(operation.resultProofs).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(operation.resultProofs, "regular")
  ) {
    throw new Error("CTF redeem completion was not committed exactly");
  }
  requireCommittedCtfRedeemRequestAndSubmission(
    operation,
    requestDigest,
    "completion",
  );
  const actualProofs = normalizeProofArray(
    operation.resultProofs.regular ?? [],
  );
  if (
    canonicalRedeemJson(actualProofs) !==
    canonicalRedeemJson(normalizeProofArray(expectedProofs))
  ) {
    throw new Error("CTF redeem completion was not committed exactly");
  }
}

function requireCommittedCtfRedeemRequestAndSubmission(
  operation: CtfProofOperationRecord,
  requestDigest: string,
  boundary: string,
): void {
  const request = requireCtfRedeemRequestBinding(operation);
  if (
    request.requestDigest !== requestDigest ||
    operation.metadata.redeemMintSubmissionVersion !== 1 ||
    operation.metadata.redeemMintSubmissionRequestDigest !== requestDigest
  ) {
    throw new Error(`CTF redeem ${boundary} was not committed exactly`);
  }
}

function requireExactCtfRedeemProofStates(
  value: unknown,
  inputs: readonly Readonly<{ id: string; secret: string }>[],
): ProofState[] {
  if (!Array.isArray(value) || value.length !== inputs.length) {
    throw new Error("CTF redeem proof-state response is invalid");
  }
  const encoder = new TextEncoder();
  const expected = new Set(
    inputs.map(({ id, secret }) => {
      const bytes = encoder.encode(secret);
      return isBlsKeyset(id)
        ? hashToCurveBls(bytes).toHex(true)
        : hashToCurve(bytes).toHex(true);
    }),
  );
  if (expected.size !== inputs.length) {
    throw new Error("CTF redeem proof-state request is invalid");
  }
  const observed = new Set<string>();
  const states: ProofState[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("CTF redeem proof-state response is invalid");
    }
    const state = raw as Record<string, unknown>;
    const keys = Object.keys(state).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "Y" ||
      keys[1] !== "state" ||
      keys[2] !== "witness" ||
      typeof state.Y !== "string" ||
      !expected.has(state.Y) ||
      observed.has(state.Y) ||
      (state.state !== CheckStateEnum.UNSPENT &&
        state.state !== CheckStateEnum.PENDING &&
        state.state !== CheckStateEnum.SPENT) ||
      (state.witness !== null && typeof state.witness !== "string")
    ) {
      throw new Error("CTF redeem proof-state response is invalid");
    }
    observed.add(state.Y);
    states.push(state as unknown as ProofState);
  }
  if (observed.size !== expected.size) {
    throw new Error("CTF redeem proof-state response is invalid");
  }
  return states;
}

function requireCtfRedeemRequestBinding(entry: CtfProofOperationRecord): {
  oracleWitness: string;
  requestDigest: string;
} {
  const version = entry.metadata.redeemRequestVersion;
  const digest = entry.metadata.redeemRequestDigest;
  if (
    version !== CTF_REDEEM_REQUEST_VERSION ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    throw new Error("CTF redeem request binding is invalid");
  }
  const oracleWitness = requireBoundedOracleWitness(
    entry.metadata.oracleWitness,
  );
  const expected = deriveCtfRedeemRequestDigest({
    operationId: entry.operationId,
    mintUrl: entry.mintUrl,
    inputs: entry.inputs,
    outputs: entry.outputs,
    oracleWitness,
  });
  if (digest !== expected) {
    throw new Error("CTF redeem request binding is invalid");
  }
  return { oracleWitness, requestDigest: digest };
}

function deriveCtfRedeemRequestDigest(input: {
  operationId: string;
  mintUrl: string;
  inputs: readonly Proof[];
  outputs: CtfProofOperationRecord["outputs"];
  oracleWitness: string;
}): string {
  const canonical = canonicalRedeemJson([
    CTF_REDEEM_REQUEST_VERSION,
    "ctf-redeem-request",
    input.operationId,
    input.mintUrl,
    input.inputs.map((proof) => ({ ...proof, witness: input.oracleWitness })),
    input.outputs,
  ]);
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength > CTF_REDEEM_REQUEST_BYTES_MAX) {
    throw new Error("CTF redeem request binding exceeds the byte limit");
  }
  return bytesToHex(sha256(bytes));
}

function deriveCtfRedeemProofRequestDigest(
  proof: CtfLosingOutcomeProofIdentity,
  oracleWitness: string,
): string {
  const amount = amountToNumber(proof.amount as never);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("CTF losing proof amount is invalid");
  }
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        canonicalRedeemJson({
          id: proof.id,
          amount,
          secret: proof.secret,
          C: proof.C,
          ...(proof.dleq === undefined
            ? {}
            : {
                dleq: {
                  e: proof.dleq.e,
                  s: proof.dleq.s,
                  ...(proof.dleq.r === undefined ? {} : { r: proof.dleq.r }),
                },
              }),
          witness: oracleWitness,
        }),
      ),
    ),
  );
}

function requireBoundedOracleWitness(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\uD800-\uDFFF]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > CTF_REDEEM_WITNESS_BYTES_MAX
  ) {
    throw new Error("CTF redeem oracle witness is invalid");
  }
  return value;
}

function requireEvidenceText(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 512
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireNormalizedMintUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error("CTF redeem mint is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CTF redeem mint is invalid");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("CTF redeem mint is invalid");
  }
  const normalized = parsed.toString().replace(/\/$/, "");
  return normalized;
}

function requireWalletMintTransport(
  wallet: RedeemWallet,
  expectedMintUrl: string,
): void {
  if (
    typeof wallet !== "object" ||
    wallet === null ||
    typeof wallet.mint !== "object" ||
    wallet.mint === null ||
    requireNormalizedMintUrl(wallet.mint.mintUrl) !== expectedMintUrl
  ) {
    throw new Error("CTF redeem wallet does not match persisted mint");
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function canonicalRedeemJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("CTF redeem request binding is invalid");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalRedeemJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("CTF redeem request binding is invalid");
    }
    const keys = Object.keys(record).sort();
    if (keys.some((key) => record[key] === undefined)) {
      throw new Error("CTF redeem request binding is invalid");
    }
    return `{${keys
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalRedeemJson(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("CTF redeem request binding is invalid");
}

function withOracleWitness(proofs: Proof[], witnessJson: string): Proof[] {
  return proofs.map((proof) => ({ ...proof, witness: witnessJson }));
}
