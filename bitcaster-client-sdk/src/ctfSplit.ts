import {
  Amount,
  CheckStateEnum,
  Mint as CashuMint,
  OutputData as RegularOutputData,
  Wallet as CashuWallet,
  type MintKeys,
  type P2PKOptions,
  type Proof,
  type ProofState,
  type CtfConvertRequest,
  type CtfConvertResponse,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
  type SwapPreview,
  splitAmount,
} from "@cashu/cashu-ts";
import {
  amountToNumber,
  computeInputFeeSatsForProofs,
  sumProofs,
  takeProofsForLock,
} from "./proofSelection.ts";
import {
  defaultCollateralUnit,
  isCollateralUnitOf,
  parseMarketBaseAsset,
  type MarketBaseAsset,
} from "./marketUnits.ts";

export interface CtfConditionalKeysetInfo {
  id: string;
  unit?: string | null;
  condition_id: string;
  outcome_collection: string;
  outcome_collection_id: string;
  active?: boolean;
}

export interface CtfConditionInfo {
  condition_id: string;
  collateral?: string | null;
  keysets: Record<string, string>;
}

export interface CtfSplitOutputData {
  blindedMessage: SerializedBlindedMessage;
  blindingFactor: bigint;
  secret: Uint8Array;
  toProof(signature: SerializedBlindedSignature, keyset: MintKeys): Proof;
}

export interface StoredOutputData {
  blindedMessage: {
    amount: number;
    id: string;
    B_: string;
  };
  blindingFactor: string;
  secret: string;
}

export type CtfProofOperationKind =
  | "ctf-split"
  | "ctf-merge"
  | "regular-split";
export type ProofOperationState = "prepared" | "completed" | "failed";

export interface CtfProofOperationRecord {
  operationId: string;
  kind: CtfProofOperationKind;
  state: ProofOperationState;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata: Record<string, unknown>;
  resultProofs?: Record<string, Proof[]>;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CtfPrepareProofOperationInput {
  operationId: string;
  kind: CtfProofOperationKind;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata?: Record<string, unknown>;
}

export interface CtfProofOperationStore {
  getProofOperation(
    operationId: string,
  ): Promise<CtfProofOperationRecord | null>;
  prepareProofOperation(
    input: CtfPrepareProofOperationInput,
  ): Promise<CtfProofOperationRecord>;
  markProofOperationCompleted(
    operationId: string,
    resultProofs: Record<string, Proof[]>,
  ): Promise<CtfProofOperationRecord>;
}

export interface SplitCollateralSelection {
  inputs: Proof[];
  keep: Proof[];
  inputFeeSats: number;
  grossInputSats: number;
}

export type CtfCollateralBaseAsset = MarketBaseAsset | string | null | undefined;

export interface CtfGrossInputPlanningKeyset {
  id: string;
  keys: Record<string, string> | Record<number, string>;
  input_fee_ppk: number;
}

export interface MintSplitForSwapResult {
  resolvedLockOutcomeSetId: string;
  resolvedKeepOutcomeSetId: string;
  lockCollections: string[];
  keepCollections: string[];
  lockedProofs: Proof[];
  keepProofs: Proof[];
  proofsByCollection: Record<string, Proof[]>;
  spentSatProofs: Proof[];
}

export interface PreflightCompleteSetSplitResult {
  resolvedLockOutcomeSetId: string;
  resolvedKeepOutcomeSetId: string;
  lockCollections: string[];
  keepCollections: string[];
  lockProofs: Proof[];
  keepProofs: Proof[];
  proofsByCollection: Record<string, Proof[]>;
  spentSatProofs: Proof[];
}

export interface ComplementaryOutcomeLegResolution {
  resolvedLockOutcomeSetId: string;
  resolvedKeepOutcomeSetId: string;
  lockCollections: string[];
  keepCollections: string[];
}

export interface CtfRootPartitionSelection {
  lockOutcomeSetId: string;
  keepOutcomeSetId: string;
  baseAsset?: CtfCollateralBaseAsset;
}

export interface CtfSplitTransport {
  getKeys(keysetId: string): Promise<MintKeys>;
  getConditionalKeysets?(query?: {
    active?: boolean;
  }): Promise<CtfConditionalKeysetInfo[]>;
  getRootPartitionKeysets(
    conditionId: string,
    selection?: CtfRootPartitionSelection,
  ): Promise<Record<string, string>>;
  postConvert?(request: {
    condition_id: CtfConvertRequest["condition_id"];
    inputs: CtfConvertRequest["inputs"];
    outputs: CtfConvertRequest["outputs"];
  }): Promise<CtfConvertResponse>;
  postSplit(request: {
    condition_id: CtfConvertRequest["condition_id"];
    inputs: Proof[];
    outputs: CtfConvertRequest["outputs"];
  }): Promise<CtfConvertResponse>;
}

export interface CtfSplitMakeOutputsInput {
  collection: string;
  amountSubunits: number;
  /** @deprecated Use amountSubunits. Kept for pre-rename callback adapters. */
  amountSats?: number;
  keyset: MintKeys;
}

export type CtfSplitMakeOutputs = (
  input: CtfSplitMakeOutputsInput,
) => CtfSplitOutputData[];

export interface CtfSplitOptions {
  makeOutputs?: CtfSplitMakeOutputs;
  baseAsset?: CtfCollateralBaseAsset;
  onPrepared?: (prepared: {
    inputs: Proof[];
    outputsByCollection: Record<string, CtfSplitOutputData[]>;
    requestOutputs: Record<string, SerializedBlindedMessage[]>;
  }) => Promise<void>;
}

export interface RegularSplitWallet {
  prepareSwapToSend?(
    amount: number,
    proofs: Proof[],
    config?: unknown,
    outputConfig?: unknown,
  ): Promise<SwapPreview>;
  completeSwap?(
    swapPreview: SwapPreview,
  ): Promise<{ keep: Proof[]; send: Proof[] }>;
  checkProofsStates?(
    proofs: Array<Pick<Proof, "id" | "secret">>,
  ): Promise<ProofState[]>;
}

export interface RegularProofSplitResult {
  send: Proof[];
  keep: Proof[];
  spent: Proof[];
}

export interface MergeCompleteSetToRegularResult {
  regularProofs: Proof[];
  spentConditionalProofsByCollection: Record<string, Proof[]>;
  outputAmountSubunits: number;
}

export interface CompleteSetMergeInputSelection {
  selectedProofsByCollection: Record<string, Proof[]>;
  grossInputSats: number;
  convertFeeSats: number;
  outputAmountSubunits: number;
}

export async function splitRegularProofsWithOperation(params: {
  mintUrl: string;
  baseAsset?: CtfCollateralBaseAsset;
  operationId: string;
  wallet: RegularSplitWallet;
  proofs: Proof[];
  amountSubunits?: number;
  amountSats?: number;
  proofOperationStore: CtfProofOperationStore;
}): Promise<RegularProofSplitResult> {
  const amountSubunits = requirePositiveSafeInteger(
    params.amountSubunits ?? params.amountSats,
    "amountSubunits",
  );

  const normalizedProofs = params.proofs.map(normalizeProof);
  const existing = await params.proofOperationStore.getProofOperation(
    params.operationId,
  );
  if (existing) {
    return resumeRegularSplit(
      params.mintUrl,
      existing,
      params.wallet,
      params.proofOperationStore,
    );
  }

  if (!params.wallet.prepareSwapToSend || !params.wallet.completeSwap) {
    throw new Error(
      "Cashu wallet adapter does not support resumable split preparation",
    );
  }

  const preview = await params.wallet.prepareSwapToSend(
    amountSubunits,
    normalizedProofs,
    undefined,
    { send: { type: "random" }, keep: { type: "random" } },
  );
  await params.proofOperationStore.prepareProofOperation({
    operationId: params.operationId,
    kind: "regular-split",
    mintUrl: params.mintUrl,
    inputs: preview.inputs,
    outputs: {
      send: serializeOutputDataArray(preview.sendOutputs ?? []),
      keep: serializeOutputDataArray(preview.keepOutputs ?? []),
    },
    metadata: {
      amount: amountToNumber(preview.amount),
      fees: amountToNumber(preview.fees),
      keysetId: preview.keysetId,
      baseAsset: requireMarketBaseAsset(params.baseAsset, "regular split baseAsset"),
      unit: defaultCollateralUnit(params.baseAsset),
      unselectedProofs: preview.unselectedProofs ?? [],
    },
  });

  const result = await params.wallet.completeSwap(preview);
  const completed = {
    send: result.send.map(normalizeProof),
    keep: result.keep.map(normalizeProof),
  };
  await params.proofOperationStore.markProofOperationCompleted(
    params.operationId,
    completed,
  );
  return { ...completed, spent: preview.inputs.map(normalizeProof) };
}

export async function selectCollateralForCtfSplit(
  mintUrl: string,
  availableProofs: Proof[],
  faceAmountSubunits: number,
  baseAsset?: CtfCollateralBaseAsset,
): Promise<SplitCollateralSelection> {
  if (!Number.isSafeInteger(faceAmountSubunits) || faceAmountSubunits <= 0) {
    throw new Error("faceAmountSubunits must be a positive safe integer");
  }

  const mint = new CashuMint(mintUrl);
  const wallet = new CashuWallet(mint, {
    unit: requireMarketBaseAsset(baseAsset, "CTF split collateral baseAsset"),
  });
  await wallet.loadMint();
  if (!wallet.selectProofsToSend) {
    throw new Error(
      "Cashu wallet adapter does not support fee-aware proof selection",
    );
  }

  const selected = wallet.selectProofsToSend(
    availableProofs.map(normalizeProof),
    faceAmountSubunits,
    true,
    true,
  );
  const selectedSend = selected.send.map(normalizeProof);
  const selectedKeep = selected.keep.map(normalizeProof);
  const inputFeePpkBySelectedKeyset = await resolveInputFeePpkByProofKeyset(
    mint,
    selectedSend,
  );
  const inputFeeSats = computeInputFeeSatsForProofs(
    selectedSend,
    inputFeePpkBySelectedKeyset,
  );
  const grossInputSats = selectedSend.reduce(
    (acc, proof) => acc + amountToNumber(proof.amount),
    0,
  );
  const netInputSats = grossInputSats - inputFeeSats;
  if (netInputSats !== faceAmountSubunits) {
    throw new Error(
      `Selected collateral nets ${netInputSats} sats after ${inputFeeSats} sats input fee, expected ${faceAmountSubunits}`,
    );
  }

  return {
    inputs: selectedSend,
    keep: selectedKeep,
    inputFeeSats,
    grossInputSats,
  };
}

export function computeGrossCtfInputAmountSubunits(params: {
  faceAmountSubunits: number;
  keyset: CtfGrossInputPlanningKeyset;
}): number {
  const { faceAmountSubunits, keyset } = params;
  if (!Number.isSafeInteger(faceAmountSubunits) || faceAmountSubunits <= 0) {
    throw new Error("faceAmountSubunits must be a positive safe integer");
  }
  if (!keyset?.id || !keyset.keys || Object.keys(keyset.keys).length === 0) {
    throw new Error(
      `Cashu keyset ${keyset?.id ?? "<missing>"} has no spendable keys`,
    );
  }
  if (!Number.isSafeInteger(keyset.input_fee_ppk) || keyset.input_fee_ppk < 0) {
    throw new Error(`Cashu keyset ${keyset.id} has invalid input_fee_ppk`);
  }

  let grossAmountSubunits = faceAmountSubunits;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const feeSats = ctfInputFeeForGrossAmount(keyset, grossAmountSubunits);
    const nextGrossAmountSubunits = faceAmountSubunits + feeSats;
    if (nextGrossAmountSubunits === grossAmountSubunits) return grossAmountSubunits;
    grossAmountSubunits = nextGrossAmountSubunits;
  }

  const scanLimit = faceAmountSubunits + Math.max(faceAmountSubunits, 10_000);
  for (
    grossAmountSubunits = faceAmountSubunits;
    grossAmountSubunits <= scanLimit;
    grossAmountSubunits += 1
  ) {
    const feeSats = ctfInputFeeForGrossAmount(keyset, grossAmountSubunits);
    if (grossAmountSubunits - feeSats === faceAmountSubunits) {
      return grossAmountSubunits;
    }
  }

  throw new Error(
    `Could not find gross CTF input amount that nets ${faceAmountSubunits} sats after input fees`,
  );
}

export function computeGrossCtfInputAmountSats(params: {
  faceAmountSats: number;
  keyset: CtfGrossInputPlanningKeyset;
}): number {
  return computeGrossCtfInputAmountSubunits({
    faceAmountSubunits: params.faceAmountSats,
    keyset: params.keyset,
  });
}

export async function splitRootCompleteSetForSwap(params: {
  mintUrl: string;
  baseAsset?: CtfCollateralBaseAsset;
  conditionId: string;
  collateralProofs: Proof[];
  amountSubunits?: number;
  amountSats?: number;
  lockOutcomeSetId: string;
  keepOutcomeSetId: string;
  p2pk: P2PKOptions;
  operationId: string;
  proofOperationStore: CtfProofOperationStore;
}): Promise<MintSplitForSwapResult> {
  const amountSubunits = requirePositiveSafeInteger(
    params.amountSubunits ?? params.amountSats,
    "amountSubunits",
  );
  const transport = new CashuMintCtfSplitTransport(params.mintUrl);
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    params.conditionId,
    {
      lockOutcomeSetId: params.lockOutcomeSetId,
      keepOutcomeSetId: params.keepOutcomeSetId,
      baseAsset: params.baseAsset,
    },
  );
  const outcomeLegs = resolveComplementaryOutcomeLegs(
    params.lockOutcomeSetId,
    params.keepOutcomeSetId,
    outcomeCollectionKeysets,
  );
  const lockCollections = new Set(outcomeLegs.lockCollections);
  const keepCollections = new Set(outcomeLegs.keepCollections);
  const normalizedCollateral = params.collateralProofs.map(normalizeProof);
  const proofsByCollection = await splitCompleteSetWithOperation({
    mintUrl: params.mintUrl,
    operationId: params.operationId,
    transport,
    conditionId: params.conditionId,
    collateralProofs: normalizedCollateral,
    outcomeCollectionKeysets,
    amountSubunits,
    baseAsset: params.baseAsset,
    proofOperationStore: params.proofOperationStore,
    makeOutputs: ({ collection, amountSubunits, keyset }) => {
      if (lockCollections.has(collection)) {
        return RegularOutputData.createP2PKData(
          params.p2pk,
          Amount.from(amountSubunits),
          keyset,
        );
      }
      if (keepCollections.has(collection)) {
        return RegularOutputData.createRandomData(
          Amount.from(amountSubunits),
          keyset,
        );
      }
      throw new Error(
        `CTF split has no lock/keep branch for outcome collection ${collection}`,
      );
    },
  });

  return {
    resolvedLockOutcomeSetId: outcomeLegs.resolvedLockOutcomeSetId,
    resolvedKeepOutcomeSetId: outcomeLegs.resolvedKeepOutcomeSetId,
    lockCollections: outcomeLegs.lockCollections,
    keepCollections: outcomeLegs.keepCollections,
    lockedProofs: requireOutcomeProofsForCollections(
      proofsByCollection,
      outcomeLegs.lockCollections,
      params.operationId,
    ),
    keepProofs: requireOutcomeProofsForCollections(
      proofsByCollection,
      outcomeLegs.keepCollections,
      params.operationId,
    ),
    proofsByCollection,
    spentSatProofs: normalizedCollateral,
  };
}

export async function splitRootCompleteSetForPreflightOrder(params: {
  mintUrl: string;
  baseAsset?: CtfCollateralBaseAsset;
  conditionId: string;
  collateralProofs: Proof[];
  amountSubunits?: number;
  amountSats?: number;
  lockOutcomeSetId: string;
  keepOutcomeSetId: string;
  operationId: string;
  proofOperationStore: CtfProofOperationStore;
}): Promise<PreflightCompleteSetSplitResult> {
  const amountSubunits = requirePositiveSafeInteger(
    params.amountSubunits ?? params.amountSats,
    "amountSubunits",
  );
  const transport = new CashuMintCtfSplitTransport(params.mintUrl);
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    params.conditionId,
    {
      lockOutcomeSetId: params.lockOutcomeSetId,
      keepOutcomeSetId: params.keepOutcomeSetId,
      baseAsset: params.baseAsset,
    },
  );
  const outcomeLegs = resolveComplementaryOutcomeLegs(
    params.lockOutcomeSetId,
    params.keepOutcomeSetId,
    outcomeCollectionKeysets,
  );
  const normalizedCollateral = params.collateralProofs.map(normalizeProof);
  const proofsByCollection = await splitCompleteSetWithOperation({
    mintUrl: params.mintUrl,
    operationId: params.operationId,
    transport,
    conditionId: params.conditionId,
    collateralProofs: normalizedCollateral,
    outcomeCollectionKeysets,
    amountSubunits,
    baseAsset: params.baseAsset,
    proofOperationStore: params.proofOperationStore,
    makeOutputs: ({ amountSubunits, keyset }) =>
      RegularOutputData.createRandomData(Amount.from(amountSubunits), keyset),
  });

  return {
    resolvedLockOutcomeSetId: outcomeLegs.resolvedLockOutcomeSetId,
    resolvedKeepOutcomeSetId: outcomeLegs.resolvedKeepOutcomeSetId,
    lockCollections: outcomeLegs.lockCollections,
    keepCollections: outcomeLegs.keepCollections,
    lockProofs: requireOutcomeProofsForCollections(
      proofsByCollection,
      outcomeLegs.lockCollections,
      params.operationId,
    ),
    keepProofs: requireOutcomeProofsForCollections(
      proofsByCollection,
      outcomeLegs.keepCollections,
      params.operationId,
    ),
    proofsByCollection,
    spentSatProofs: normalizedCollateral,
  };
}

export async function resolveRootPreflightOutputAmountSubunits(params: {
  mintUrl: string;
  baseAsset?: CtfCollateralBaseAsset;
  conditionId: string;
  amountSubunits?: number;
  amountSats?: number;
  lockOutcomeSetId: string;
  keepOutcomeSetId: string;
}): Promise<number> {
  const amountSubunits = requirePositiveSafeInteger(
    params.amountSubunits ?? params.amountSats,
    "amountSubunits",
  );
  const transport = new CashuMintCtfSplitTransport(params.mintUrl);
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    params.conditionId,
    {
      lockOutcomeSetId: params.lockOutcomeSetId,
      keepOutcomeSetId: params.keepOutcomeSetId,
      baseAsset: params.baseAsset,
    },
  );

  let preflightOutputAmountSubunits = amountSubunits;
  for (const keysetId of Object.values(outcomeCollectionKeysets)) {
    const keyset = await transport.getKeys(keysetId);
    const planningKeyset = {
      id: keyset.id,
      keys: keyset.keys,
      input_fee_ppk: keyset.input_fee_ppk ?? 0,
    };
    const claimInputAmountSubunits = computeGrossCtfInputAmountSubunits({
      faceAmountSubunits: amountSubunits,
      keyset: planningKeyset,
    });
    preflightOutputAmountSubunits = Math.max(
      preflightOutputAmountSubunits,
      computeGrossCtfInputAmountSubunits({
        faceAmountSubunits: claimInputAmountSubunits,
        keyset: planningKeyset,
      }),
    );
  }
  return preflightOutputAmountSubunits;
}

export const resolveRootPreflightOutputAmountSats = resolveRootPreflightOutputAmountSubunits;

export async function resolveRootDirectLockOutputAmountSubunits(params: {
  mintUrl: string;
  baseAsset?: CtfCollateralBaseAsset;
  conditionId: string;
  amountSubunits?: number;
  amountSats?: number;
  lockOutcomeSetId: string;
  keepOutcomeSetId: string;
}): Promise<number> {
  const amountSubunits = requirePositiveSafeInteger(
    params.amountSubunits ?? params.amountSats,
    "amountSubunits",
  );
  const transport = new CashuMintCtfSplitTransport(params.mintUrl);
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    params.conditionId,
    {
      lockOutcomeSetId: params.lockOutcomeSetId,
      keepOutcomeSetId: params.keepOutcomeSetId,
      baseAsset: params.baseAsset,
    },
  );
  const outcomeLegs = resolveComplementaryOutcomeLegs(
    params.lockOutcomeSetId,
    params.keepOutcomeSetId,
    outcomeCollectionKeysets,
  );

  let outputAmountSubunits = amountSubunits;
  for (const collection of outcomeLegs.lockCollections) {
    const keysetId = outcomeCollectionKeysets[collection];
    if (!keysetId) {
      throw new Error(
        `CTF split lock outcome ${collection} has no root keyset for condition ${params.conditionId}`,
      );
    }
    const keyset = await transport.getKeys(keysetId);
    outputAmountSubunits = Math.max(
      outputAmountSubunits,
      computeGrossCtfInputAmountSubunits({
        faceAmountSubunits: amountSubunits,
        keyset: {
          id: keyset.id,
          keys: keyset.keys,
          input_fee_ppk: keyset.input_fee_ppk ?? 0,
        },
      }),
    );
  }
  return outputAmountSubunits;
}

export const resolveRootDirectLockOutputAmountSats = resolveRootDirectLockOutputAmountSubunits;

export async function splitRootCompleteSet(
  transport: CtfSplitTransport,
  conditionId: string,
  inputs: Proof[],
  amountSubunits: number,
  options: CtfSplitOptions = {},
  selection?: CtfRootPartitionSelection,
): Promise<Record<string, Proof[]>> {
  const outcomeCollectionKeysets = await transport.getRootPartitionKeysets(
    conditionId,
    selection,
  );
  const splitKeysets = selection
    ? outcomeCollectionKeysets
    : preferAtomicRootPartitionKeysets(outcomeCollectionKeysets);
  return splitCompleteSet(
    transport,
    conditionId,
    inputs,
    splitKeysets,
    amountSubunits,
    { ...options, baseAsset: selection?.baseAsset ?? options.baseAsset },
  );
}

export async function splitCompleteSet(
  transport: CtfSplitTransport,
  conditionId: string,
  inputs: Proof[],
  outcomeCollectionKeysets: Record<string, string>,
  amountSubunits: number,
  options: CtfSplitOptions = {},
): Promise<Record<string, Proof[]>> {
  const normalizedInputs = inputs.map(normalizeProof);
  const expectedBaseAsset = options.baseAsset
    ? requireMarketBaseAsset(options.baseAsset, "CTF split baseAsset")
    : null;
  validateSplitInput(
    conditionId,
    normalizedInputs,
    outcomeCollectionKeysets,
    amountSubunits,
  );

  const makeOutputs = options.makeOutputs ?? defaultMakeOutputs;
  const keysetsById = new Map<string, MintKeys>();
  const getCachedKeys = async (keysetId: string): Promise<MintKeys> => {
    const cached = keysetsById.get(keysetId);
    if (cached) return cached;
    const keyset = await transport.getKeys(keysetId);
    keysetsById.set(keysetId, keyset);
    return keyset;
  };

  await validateInputBalance(
    normalizedInputs,
    amountSubunits,
    getCachedKeys,
    expectedBaseAsset,
  );

  const keysetsByCollection = new Map<string, MintKeys>();
  const outputsByCollection: Record<string, CtfSplitOutputData[]> = {};
  const requestOutputs: Record<string, SerializedBlindedMessage[]> = {};

  for (const [collection, keysetId] of Object.entries(
    outcomeCollectionKeysets,
  )) {
    const keyset = await getCachedKeys(keysetId);
    if (expectedBaseAsset) {
      validateKeysetUnit(
        keyset,
        expectedBaseAsset,
        `CTF split output keyset ${keysetId} for ${collection}`,
      );
    }
    keysetsByCollection.set(collection, keyset);
    const outputs = makeOutputs({
      collection,
      amountSubunits,
      amountSats: amountSubunits,
      keyset,
    });
    validateOutputs(collection, keysetId, amountSubunits, outputs);
    outputsByCollection[collection] = outputs;
    requestOutputs[collection] = outputs.map((output) =>
      toWireBlindedMessage(output.blindedMessage),
    );
  }

  await options.onPrepared?.({
    inputs: normalizedInputs,
    outputsByCollection,
    requestOutputs,
  });

  const response = await transport.postSplit({
    condition_id: conditionId,
    inputs: normalizedInputs,
    outputs: requestOutputs,
  });

  const proofsByCollection: Record<string, Proof[]> = {};
  for (const [collection, outputs] of Object.entries(outputsByCollection)) {
    const signatures = response.signatures[collection];
    if (!signatures) {
      throw new Error(
        `Mint did not return split signatures for outcome collection ${collection}`,
      );
    }
    if (signatures.length !== outputs.length) {
      throw new Error(
        `Mint returned ${signatures.length} signatures for outcome collection ${collection}, expected ${outputs.length}`,
      );
    }
    const keyset = keysetsByCollection.get(collection);
    if (!keyset)
      throw new Error(`Missing keyset for outcome collection ${collection}`);
    proofsByCollection[collection] = outputs.map((output, index) => {
      validateSignature(
        collection,
        outputs[index].blindedMessage,
        signatures[index],
      );
      return normalizeProof(
        output.toProof(
          { ...signatures[index], amount: output.blindedMessage.amount },
          keyset,
        ),
      );
    });
  }

  return proofsByCollection;
}

export class CashuMintCtfSplitTransport implements CtfSplitTransport {
  private readonly mint: CashuMint & {
    getCtfCondition(conditionId: string): Promise<CtfConditionInfo>;
    getConditionalKeysets(query?: {
      active?: boolean;
    }): Promise<{ keysets: CtfConditionalKeysetInfo[] }>;
    ctfConvert(request: CtfConvertRequest): Promise<CtfConvertResponse>;
  };

  constructor(mintUrl: string) {
    this.mint = new CashuMint(mintUrl) as CashuMint & {
      getCtfCondition(conditionId: string): Promise<CtfConditionInfo>;
      getConditionalKeysets(query?: {
        active?: boolean;
      }): Promise<{ keysets: CtfConditionalKeysetInfo[] }>;
      ctfConvert(request: CtfConvertRequest): Promise<CtfConvertResponse>;
    };
  }

  async getKeys(keysetId: string): Promise<MintKeys> {
    const response = await this.mint.getKeys(keysetId);
    const keyset = response.keysets.find(
      (candidate) => candidate.id === keysetId,
    );
    if (!keyset) {
      throw new Error(
        `Mint did not return keys for conditional keyset ${keysetId}`,
      );
    }
    return keyset;
  }

  async getRootPartitionKeysets(
    conditionId: string,
    selection?: CtfRootPartitionSelection,
  ): Promise<Record<string, string>> {
    const condition = await this.mint.getCtfCondition(conditionId);
    let conditionalKeysets: CtfConditionalKeysetInfo[] = [];
    try {
      conditionalKeysets = (
        await this.mint.getConditionalKeysets({ active: true })
      ).keysets;
    } catch {
      conditionalKeysets = [];
    }
    return selectRootPartitionKeysets(
      condition,
      selection,
      conditionalKeysets,
    );
  }

  async getConditionalKeysets(query?: {
    active?: boolean;
  }): Promise<CtfConditionalKeysetInfo[]> {
    return (await this.mint.getConditionalKeysets(query)).keysets;
  }

  async postSplit(
    request: Parameters<CtfSplitTransport["postSplit"]>[0],
  ): Promise<CtfConvertResponse> {
    return this.mint.ctfConvert({
      condition_id: request.condition_id,
      inputs: { "*": request.inputs },
      outputs: request.outputs,
    });
  }

  async postConvert(
    request: Parameters<NonNullable<CtfSplitTransport["postConvert"]>>[0],
  ): Promise<CtfConvertResponse> {
    return this.mint.ctfConvert({
      condition_id: request.condition_id,
      inputs: request.inputs,
      outputs: request.outputs,
    });
  }
}

export async function splitCompleteSetWithOperation(params: {
  mintUrl: string;
  baseAsset?: CtfCollateralBaseAsset;
  operationId: string;
  transport: CtfSplitTransport;
  conditionId: string;
  collateralProofs: Proof[];
  outcomeCollectionKeysets: Record<string, string>;
  amountSubunits: number;
  proofOperationStore: CtfProofOperationStore;
  makeOutputs: (input: {
    collection: string;
    amountSubunits: number;
    keyset: MintKeys;
  }) => CtfSplitOutputData[];
}): Promise<Record<string, Proof[]>> {
  const existing = await params.proofOperationStore.getProofOperation(
    params.operationId,
  );
  if (existing) {
    return resumeCtfSplit(
      params.mintUrl,
      existing,
      params.transport,
      params.proofOperationStore,
    );
  }

  const result = await splitCompleteSet(
    params.transport,
    params.conditionId,
    params.collateralProofs,
    params.outcomeCollectionKeysets,
    params.amountSubunits,
    {
      baseAsset: params.baseAsset,
      makeOutputs: params.makeOutputs,
      onPrepared: async (prepared) => {
        const preparedOutputs = Object.fromEntries(
          Object.entries(prepared.outputsByCollection).map(
            ([collection, outputs]) => [
              collection,
              serializeOutputDataArray(outputs),
            ],
          ),
        );
        await params.proofOperationStore.prepareProofOperation({
          operationId: params.operationId,
          kind: "ctf-split",
          mintUrl: params.mintUrl,
          inputs: prepared.inputs,
          outputs: preparedOutputs,
          metadata: {
            conditionId: params.conditionId,
            amountSubunits: params.amountSubunits,
            baseAsset: requireMarketBaseAsset(params.baseAsset, "CTF split baseAsset"),
            unit: defaultCollateralUnit(params.baseAsset),
            outcomeCollectionKeysets: params.outcomeCollectionKeysets,
          },
        });
      },
    },
  );

  await params.proofOperationStore.markProofOperationCompleted(
    params.operationId,
    result,
  );
  return result;
}

export async function mergeCompleteSetToRegularWithOperation(params: {
  mintUrl: string;
  baseAsset?: CtfCollateralBaseAsset;
  operationId: string;
  transport: CtfSplitTransport;
  conditionId: string;
  conditionalProofsByCollection: Record<string, Proof[]>;
  outputAmountSubunits: number;
  regularKeyset: MintKeys;
  proofOperationStore: CtfProofOperationStore;
  makeRegularOutputs?: (input: {
    amountSubunits: number;
    keyset: MintKeys;
  }) => CtfSplitOutputData[];
}): Promise<MergeCompleteSetToRegularResult> {
  if (!Number.isSafeInteger(params.outputAmountSubunits) || params.outputAmountSubunits <= 0) {
    throw new Error("outputAmountSubunits must be a positive safe integer");
  }
  if (!params.transport.postConvert) {
    throw new Error("CTF transport does not support conditional merge convert");
  }

  const normalizedInputsByCollection = normalizeProofGroups(
    params.conditionalProofsByCollection,
  );
  const existing = await params.proofOperationStore.getProofOperation(
    params.operationId,
  );
  if (existing) {
    const spentConditionalProofsByCollection = readMergeInputsByCollection(
      existing,
      normalizedInputsByCollection,
    );
    const regularProofs = await resumeCtfMergeToRegular(
      params.mintUrl,
      existing,
      params.transport,
      params.proofOperationStore,
    );
    return {
      regularProofs,
      spentConditionalProofsByCollection,
      outputAmountSubunits: sumProofs(regularProofs),
    };
  }

  const outputData =
    params.makeRegularOutputs?.({
      amountSubunits: params.outputAmountSubunits,
      keyset: params.regularKeyset,
    }) ??
    RegularOutputData.createRandomData(
      Amount.from(params.outputAmountSubunits),
      params.regularKeyset,
    );
  await params.proofOperationStore.prepareProofOperation({
    operationId: params.operationId,
    kind: "ctf-merge",
    mintUrl: params.mintUrl,
    inputs: flattenProofs(normalizedInputsByCollection),
    outputs: { "*": serializeOutputDataArray(outputData) },
    metadata: {
      conditionId: params.conditionId,
      outputAmountSubunits: params.outputAmountSubunits,
      baseAsset: requireMarketBaseAsset(params.baseAsset, "CTF merge baseAsset"),
      unit: defaultCollateralUnit(params.baseAsset),
      inputsByCollection: normalizedInputsByCollection,
    },
  });

  const regularProofs = await executeCtfMergeToRegular({
    transport: params.transport,
    conditionId: params.conditionId,
    inputsByCollection: normalizedInputsByCollection,
    outputData,
    regularKeyset: params.regularKeyset,
  });
  await params.proofOperationStore.markProofOperationCompleted(
    params.operationId,
    { regular: regularProofs },
  );
  return {
    regularProofs,
    spentConditionalProofsByCollection: normalizedInputsByCollection,
    outputAmountSubunits: sumProofs(regularProofs),
  };
}

export function selectCompleteSetMergeInputs(params: {
  conditionalProofsByCollection: Record<string, Proof[]>;
  desiredOutputSats: number;
  inputFeePpkByKeyset: Record<string, number>;
  maxScanExtraSats?: number;
}): CompleteSetMergeInputSelection | null {
  if (!Number.isSafeInteger(params.desiredOutputSats) || params.desiredOutputSats <= 0) {
    throw new Error("desiredOutputSats must be a positive safe integer");
  }
  const normalized = normalizeProofGroups(params.conditionalProofsByCollection);
  const collections = Object.keys(normalized).sort();
  if (collections.length < 2) return null;

  const scanLimit =
    params.desiredOutputSats +
    (params.maxScanExtraSats ?? Math.max(params.desiredOutputSats, 10_000));
  for (
    let targetGross = params.desiredOutputSats;
    targetGross <= scanLimit;
    targetGross += 1
  ) {
    const selected: Record<string, Proof[]> = {};
    const selectedAmounts = new Set<number>();
    let missing = false;
    for (const collection of collections) {
      const proofs = takeProofsForLock(
        normalized[collection] ?? [],
        targetGross,
        params.inputFeePpkByKeyset,
      );
      if (!proofs) {
        missing = true;
        break;
      }
      const amount = sumProofs(proofs);
      selected[collection] = proofs.map(normalizeProof);
      selectedAmounts.add(amount);
    }
    if (missing || selectedAmounts.size !== 1) continue;

    const grossInputSats = [...selectedAmounts][0]!;
    const convertFeeSats = computeInputFeeSatsForProofs(
      flattenProofs(selected),
      params.inputFeePpkByKeyset,
    );
    const outputAmountSubunits = grossInputSats - convertFeeSats;
    if (outputAmountSubunits >= params.desiredOutputSats) {
      return {
        selectedProofsByCollection: selected,
        grossInputSats,
        convertFeeSats,
        outputAmountSubunits,
      };
    }
  }

  return null;
}

async function resumeCtfMergeToRegular(
  mintUrl: string,
  entry: CtfProofOperationRecord,
  transport: CtfSplitTransport,
  proofOperationStore: CtfProofOperationStore,
): Promise<Proof[]> {
  if (entry.kind !== "ctf-merge") {
    throw new Error(`proof operation ${entry.operationId} is not a CTF merge`);
  }
  if (entry.state === "completed") {
    return (entry.resultProofs?.regular ?? []).map(normalizeProof);
  }
  if (entry.state === "failed") {
    throw new Error(
      `proof operation ${entry.operationId} previously failed: ${entry.lastError ?? "unknown error"}`,
    );
  }

  const wallet = new CashuWallet(new CashuMint(mintUrl), {
    unit: readOperationBaseAsset(entry.metadata),
  });
  await wallet.loadMint();
  if (!wallet.checkProofsStates) {
    throw new Error(
      "Cashu wallet adapter does not support proof-state recovery checks",
    );
  }
  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  );
  let completed: Proof[];
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await restoreOutputGroups(mintUrl, entry.outputs);
    completed = (restored["*"] ?? restored.regular ?? []).map(normalizeProof);
  } else if (allStates(states, CheckStateEnum.UNSPENT)) {
    const metadata = entry.metadata as {
      conditionId?: string;
      inputsByCollection?: Record<string, Proof[]>;
    };
    if (!metadata.conditionId || !metadata.inputsByCollection) {
      throw new Error(
        `proof operation ${entry.operationId} is missing CTF merge metadata`,
      );
    }
    const outputDataByCollection = deserializeCtfOutputGroups(entry.outputs);
    const outputData = outputDataByCollection["*"] ?? outputDataByCollection.regular ?? [];
    if (outputData.length === 0) {
      throw new Error(`proof operation ${entry.operationId} has no regular merge outputs`);
    }
    const regularKeyset = await transport.getKeys(outputData[0].blindedMessage.id);
    completed = await executeCtfMergeToRegular({
      transport,
      conditionId: metadata.conditionId,
      inputsByCollection: normalizeProofGroups(metadata.inputsByCollection),
      outputData,
      regularKeyset,
    });
  } else {
    throw new Error(
      `Proof operation ${entry.operationId} is still pending at the mint`,
    );
  }

  await proofOperationStore.markProofOperationCompleted(
    entry.operationId,
    { regular: completed },
  );
  return completed;
}

function readMergeInputsByCollection(
  entry: CtfProofOperationRecord,
  fallback: Record<string, Proof[]>,
): Record<string, Proof[]> {
  const metadata = entry.metadata as {
    inputsByCollection?: Record<string, Proof[]>;
  };
  return metadata.inputsByCollection
    ? normalizeProofGroups(metadata.inputsByCollection)
    : fallback;
}

async function executeCtfMergeToRegular(params: {
  transport: CtfSplitTransport;
  conditionId: string;
  inputsByCollection: Record<string, Proof[]>;
  outputData: CtfSplitOutputData[];
  regularKeyset: MintKeys;
}): Promise<Proof[]> {
  if (!params.transport.postConvert) {
    throw new Error("CTF transport does not support conditional merge convert");
  }
  const response = await params.transport.postConvert({
    condition_id: params.conditionId,
    inputs: params.inputsByCollection,
    outputs: {
      "*": params.outputData.map((output) =>
        toWireBlindedMessage(output.blindedMessage),
      ),
    },
  });
  const signatures = response.signatures["*"];
  if (!signatures) {
    throw new Error("Mint did not return merge signatures for regular collateral");
  }
  if (signatures.length !== params.outputData.length) {
    throw new Error(
      `Mint returned ${signatures.length} merge signatures, expected ${params.outputData.length}`,
    );
  }
  return params.outputData.map((output, index) =>
    normalizeProof(
      output.toProof(
        { ...signatures[index], amount: output.blindedMessage.amount },
        params.regularKeyset,
      ),
    ),
  );
}

async function resumeCtfSplit(
  mintUrl: string,
  entry: CtfProofOperationRecord,
  transport: CtfSplitTransport,
  proofOperationStore: CtfProofOperationStore,
): Promise<Record<string, Proof[]>> {
  if (entry.kind !== "ctf-split") {
    throw new Error(`proof operation ${entry.operationId} is not a CTF split`);
  }
  if (entry.state === "completed") {
    return structuredClone(entry.resultProofs ?? {});
  }
  if (entry.state === "failed") {
    throw new Error(
      `proof operation ${entry.operationId} previously failed: ${entry.lastError ?? "unknown error"}`,
    );
  }

  const wallet = new CashuWallet(new CashuMint(mintUrl), {
    unit: readOperationBaseAsset(entry.metadata),
  });
  await wallet.loadMint();
  if (!wallet.checkProofsStates) {
    throw new Error(
      "Cashu wallet adapter does not support proof-state recovery checks",
    );
  }
  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  );
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await restoreOutputGroups(mintUrl, entry.outputs);
    await proofOperationStore.markProofOperationCompleted(
      entry.operationId,
      restored,
    );
    return restored;
  }
  if (allStates(states, CheckStateEnum.UNSPENT)) {
    const metadata = entry.metadata as {
      conditionId?: string;
      amountSubunits?: number;
      baseAsset?: string | null;
      outcomeCollectionKeysets?: Record<string, string>;
    };
    if (
      !metadata.conditionId ||
      !metadata.amountSubunits ||
      !metadata.outcomeCollectionKeysets
    ) {
      throw new Error(
        `proof operation ${entry.operationId} is missing CTF split metadata`,
      );
    }
    const outputDataByCollection = deserializeCtfOutputGroups(entry.outputs);
    const result = await splitCompleteSet(
      transport,
      metadata.conditionId,
      entry.inputs,
      metadata.outcomeCollectionKeysets,
      metadata.amountSubunits,
      {
        makeOutputs: ({ collection }) =>
          outputDataByCollection[collection] ?? [],
      },
    );
    await proofOperationStore.markProofOperationCompleted(
      entry.operationId,
      result,
    );
    return normalizeProofGroups(result);
  }

  throw new Error(
    `Proof operation ${entry.operationId} is still pending at the mint`,
  );
}

function readOperationBaseAsset(metadata: Record<string, unknown>): MarketBaseAsset {
  return requireMarketBaseAsset(
    typeof metadata.baseAsset === "string" ? metadata.baseAsset : undefined,
    "proof operation baseAsset",
  );
}

async function resumeRegularSplit(
  mintUrl: string,
  entry: CtfProofOperationRecord,
  wallet: RegularSplitWallet,
  proofOperationStore: CtfProofOperationStore,
): Promise<RegularProofSplitResult> {
  if (entry.kind !== "regular-split") {
    throw new Error(
      `proof operation ${entry.operationId} is not a regular split`,
    );
  }
  if (entry.state === "completed") {
    return {
      send: (entry.resultProofs?.send ?? []).map(normalizeProof),
      keep: (entry.resultProofs?.keep ?? []).map(normalizeProof),
      spent: entry.inputs.map(normalizeProof),
    };
  }
  if (entry.state === "failed") {
    throw new Error(
      `proof operation ${entry.operationId} previously failed: ${entry.lastError ?? "unknown error"}`,
    );
  }
  if (!wallet.checkProofsStates) {
    throw new Error(
      "Cashu wallet adapter does not support proof-state recovery checks",
    );
  }

  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  );
  let completed: { send: Proof[]; keep: Proof[] };
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await restoreOutputGroups(mintUrl, entry.outputs);
    completed = {
      send: (restored.send ?? []).map(normalizeProof),
      keep: [...(restored.keep ?? []), ...readUnselectedProofs(entry)].map(
        normalizeProof,
      ),
    };
  } else if (allStates(states, CheckStateEnum.UNSPENT)) {
    if (!wallet.completeSwap) {
      throw new Error(
        "Cashu wallet adapter does not support prepared split completion",
      );
    }
    const result = await wallet.completeSwap(entryToSwapPreview(entry));
    completed = {
      send: result.send.map(normalizeProof),
      keep: result.keep.map(normalizeProof),
    };
  } else {
    throw new Error(
      `Proof operation ${entry.operationId} is still pending at the mint`,
    );
  }

  await proofOperationStore.markProofOperationCompleted(
    entry.operationId,
    completed,
  );
  return { ...completed, spent: entry.inputs.map(normalizeProof) };
}

export async function restoreOutputGroups(
  mintUrl: string,
  outputs: Record<string, StoredOutputData[]>,
): Promise<Record<string, Proof[]>> {
  const mint = new CashuMint(mintUrl);
  const rows = Object.entries(deserializeCtfOutputGroups(outputs)).flatMap(
    ([group, groupOutputs]) =>
      groupOutputs.map((output, index) => ({ group, index, output })),
  );
  if (rows.length === 0) return {};

  const response = await mint.restore({
    outputs: rows.map((row) => toWireBlindedMessage(row.output.blindedMessage)),
  });
  if (response.signatures.length !== response.outputs.length) {
    throw new Error(
      "Mint restore response had mismatched output/signature counts",
    );
  }
  const signaturesByOutput = new Map<string, SerializedBlindedSignature>();
  response.outputs.forEach((output, index) => {
    signaturesByOutput.set(
      blindedMessageKey(output),
      response.signatures[index],
    );
  });

  const keysets = new Map<string, MintKeys>();
  const getKeyset = async (keysetId: string): Promise<MintKeys> => {
    const cached = keysets.get(keysetId);
    if (cached) return cached;
    const keysetResponse = await mint.getKeys(keysetId);
    const keyset = keysetResponse.keysets.find(
      (candidate) => candidate.id === keysetId,
    );
    if (!keyset)
      throw new Error(`Mint did not return keys for keyset ${keysetId}`);
    keysets.set(keysetId, keyset);
    return keyset;
  };

  const restored: Record<string, Proof[]> = {};
  for (const row of rows) {
    const signature = signaturesByOutput.get(
      blindedMessageKey(row.output.blindedMessage),
    );
    if (!signature) {
      throw new Error(
        `Mint restore did not return signature for output ${row.group}[${row.index}]`,
      );
    }
    const keyset = await getKeyset(row.output.blindedMessage.id);
    const proof = normalizeProof(
      row.output.toProof(
        { ...signature, amount: row.output.blindedMessage.amount },
        keyset,
      ),
    );
    restored[row.group] = [...(restored[row.group] ?? []), proof];
  }
  return normalizeProofGroups(restored);
}

export function resolveMintOutcomeSetKey(
  engineOutcomeSetId: string,
  outcomeCollectionKeysets: Record<string, string>,
  branch: "lock" | "keep",
): string {
  const engineSet = parseOutcomeSetToComparableSet(engineOutcomeSetId);
  const matches = Object.keys(outcomeCollectionKeysets).filter((mintKey) =>
    outcomeSetsEqual(engineSet, parseOutcomeSetToComparableSet(mintKey)),
  );
  if (matches.length !== 1) {
    throw new Error(
      `CTF split ${branch} outcome ${engineOutcomeSetId} matched ${matches.length} mint keyset-map keys; expected exactly one`,
    );
  }
  return matches[0];
}

export function resolveComplementaryOutcomeLegs(
  lockOutcomeSetId: string,
  keepOutcomeSetId: string,
  outcomeCollectionKeysets: Record<string, string>,
): ComplementaryOutcomeLegResolution {
  const rootCollections = Object.keys(outcomeCollectionKeysets);
  const rootCollectionSets = buildRootCollectionSets(rootCollections);

  const lockSet = parseOutcomeSetToComparableSet(lockOutcomeSetId);
  const keepSet = parseOutcomeSetToComparableSet(keepOutcomeSetId);
  const lockCollections = resolveRootOutcomeCollections(
    lockOutcomeSetId,
    lockSet,
    rootCollectionSets,
    "lock",
  );
  const keepCollections = resolveRootOutcomeCollections(
    keepOutcomeSetId,
    keepSet,
    rootCollectionSets,
    "keep",
  );

  const seen = new Set<string>();
  for (const collection of lockCollections) seen.add(collection);
  for (const collection of keepCollections) {
    if (seen.has(collection)) {
      throw new Error(
        `CTF split lock and keep outcomes overlap on primitive collection ${collection}`,
      );
    }
    seen.add(collection);
  }
  if (seen.size !== rootCollections.length) {
    const missing = rootCollections.filter(
      (collection) => !seen.has(collection),
    );
    throw new Error(
      `CTF split lock and keep outcomes do not cover the full primitive outcome set; missing ${missing.join("|")}`,
    );
  }

  return {
    resolvedLockOutcomeSetId:
      canonicalizeOutcomeSetCollections(lockCollections),
    resolvedKeepOutcomeSetId:
      canonicalizeOutcomeSetCollections(keepCollections),
    lockCollections,
    keepCollections,
  };
}

export function requireOutcomeProofs(
  proofsByCollection: Record<string, Proof[]>,
  outcomeSetId: string,
  operationId: string,
): Proof[] {
  const proofs = proofsByCollection[outcomeSetId];
  if (!proofs || proofs.length === 0) {
    throw new Error(
      `CTF split ${operationId} did not return proofs for outcome ${outcomeSetId}`,
    );
  }
  return proofs;
}

export function requireOutcomeProofsForCollections(
  proofsByCollection: Record<string, Proof[]>,
  collections: string[],
  operationId: string,
): Proof[] {
  return collections.flatMap((collection) =>
    requireOutcomeProofs(proofsByCollection, collection, operationId),
  );
}

export function selectRootPartitionKeysets(
  condition: CtfConditionInfo,
  selection?: CtfRootPartitionSelection,
  conditionalKeysets: CtfConditionalKeysetInfo[] = [],
): Record<string, string> {
  const baseAsset = requireMarketBaseAsset(
    selection?.baseAsset ?? condition.collateral ?? "sat",
    "CTF condition collateral",
  );
  const rootKeysets = normalizeRootConditionKeysets(
    condition.condition_id,
    condition.keysets,
    conditionalKeysets,
    baseAsset,
  );

  if (!selection) {
    if (Object.keys(rootKeysets).length < 2) {
      throw new Error(
        `Expected at least two root ${baseAsset} CTF keysets for condition ${condition.condition_id}, found ${Object.keys(rootKeysets).length}`,
      );
    }
    return rootKeysets;
  }

  const selected = selectKeysetsMatchingSelection(rootKeysets, selection);
  if (Object.keys(selected).length < 2) {
    throw new Error(
      `Expected root ${baseAsset} CTF keysets for condition ${condition.condition_id} matching lock ${selection.lockOutcomeSetId} and keep ${selection.keepOutcomeSetId}, found ${Object.keys(selected).length} of ${Object.keys(rootKeysets).length}`,
    );
  }
  return selected;
}

function selectKeysetsMatchingSelection(
  keysets: Record<string, string>,
  selection: CtfRootPartitionSelection,
): Record<string, string> {
  const lockSet = parseOutcomeSetToComparableSet(selection.lockOutcomeSetId);
  const keepSet = parseOutcomeSetToComparableSet(selection.keepOutcomeSetId);
  const exact = Object.fromEntries(
    Object.entries(keysets).filter(([collection]) => {
      const collectionSet = parseOutcomeSetToComparableSet(collection);
      return (
        outcomeSetsEqual(collectionSet, lockSet) ||
        outcomeSetsEqual(collectionSet, keepSet)
      );
    }),
  );
  if (Object.keys(exact).length === 2) return exact;

  const targetSet = new Set([...lockSet, ...keepSet]);
  const expanded = new Map<string, string>();
  const covered = new Set<string>();
  for (const [collection, keysetId] of Object.entries(keysets)) {
    const collectionSet = parseOutcomeSetToComparableSet(collection);
    if (![...collectionSet].every((outcome) => targetSet.has(outcome))) {
      continue;
    }
    expanded.set(collection, keysetId);
    for (const outcome of collectionSet) covered.add(outcome);
  }

  return outcomeSetsEqual(covered, targetSet) ? Object.fromEntries(expanded) : exact;
}

function normalizeRootConditionKeysets(
  conditionId: string,
  keysets: Record<string, string>,
  conditionalKeysets: CtfConditionalKeysetInfo[],
  baseAsset: MarketBaseAsset,
): Record<string, string> {
  const lookup = buildOutcomeCollectionKeysetLookup(
    conditionId,
    keysets,
    conditionalKeysets,
    baseAsset,
  );
  const normalized = new Map<string, string>();
  for (const collection of Object.keys(keysets)) {
    const keysetId = lookup.get(collection);
    if (keysetId) normalized.set(collection, keysetId);
  }

  for (const [collection, keysetId] of Object.entries(keysets)) {
    if (isOutcomeCollectionId(collection)) {
      const keyset = conditionalKeysets.find(
        (candidate) =>
          sameConditionId(candidate.condition_id, conditionId) &&
          conditionalKeysetMatchesUnit(candidate, baseAsset) &&
          candidate.outcome_collection_id === collection,
      );
      if (keyset?.outcome_collection) {
        normalized.set(keyset.outcome_collection, keysetId);
      }
    } else {
      normalized.set(collection, keysetId);
    }
  }

  return Object.fromEntries(normalized);
}

export function preferAtomicRootPartitionKeysets(
  outcomeCollectionKeysets: Record<string, string>,
): Record<string, string> {
  const atomic = Object.fromEntries(
    Object.entries(outcomeCollectionKeysets).filter(
      ([collection]) => !collection.includes("|"),
    ),
  );
  return Object.keys(atomic).length >= 2 ? atomic : outcomeCollectionKeysets;
}

function buildOutcomeCollectionKeysetLookup(
  conditionId: string,
  keysets: Record<string, string>,
  conditionalKeysets: CtfConditionalKeysetInfo[],
  baseAsset: MarketBaseAsset,
): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [collection, keysetId] of Object.entries(keysets)) {
    lookup.set(collection, keysetId);
  }
  const conditionKeysetIds = new Set(Object.values(keysets));
  for (const keyset of conditionalKeysets) {
    if (!sameConditionId(keyset.condition_id, conditionId)) continue;
    if (!conditionalKeysetMatchesUnit(keyset, baseAsset)) continue;
    const keysetId =
      keysets[keyset.outcome_collection] ??
      keysets[keyset.outcome_collection_id] ??
      keyset.id;
    if (!conditionKeysetIds.has(keysetId)) continue;
    for (const collection of [
      keyset.outcome_collection,
      keyset.outcome_collection_id,
    ]) {
      if (collection) lookup.set(collection, keysetId);
    }
  }
  return lookup;
}

function conditionalKeysetMatchesUnit(
  keyset: CtfConditionalKeysetInfo,
  baseAsset: MarketBaseAsset,
): boolean {
  // Legacy mint keysets without unit metadata predate multi-collateral support
  // and are treated as sat-only.
  if (keyset.unit == null) return baseAsset === "sat";
  return isCollateralUnitOf(keyset.unit, baseAsset);
}

function requireMarketBaseAsset(
  value: CtfCollateralBaseAsset,
  context: string,
): MarketBaseAsset {
  if (value == null) return "sat";
  const parsed = parseMarketBaseAsset(value);
  if (!parsed) {
    throw new Error(`${context} must be one of: sat, usd, jpy`);
  }
  return parsed;
}

function requirePositiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateKeysetUnit(
  keyset: Pick<MintKeys, "id" | "unit">,
  expectedBaseAsset: MarketBaseAsset,
  context: string,
): void {
  if (keyset.unit == null) {
    if (expectedBaseAsset === "sat") return;
    throw new Error(`${context} is missing unit metadata for ${expectedBaseAsset}`);
  }
  if (!isCollateralUnitOf(keyset.unit, expectedBaseAsset)) {
    const parsed = parseMarketBaseAsset(keyset.unit);
    if (!parsed) {
      throw new Error(`${context} has unsupported unit ${keyset.unit}`);
    }
    throw new Error(`${context} unit mismatch: expected ${expectedBaseAsset}, got ${parsed}`);
  }
}

function isOutcomeCollectionId(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

function sameConditionId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validateSplitInput(
  conditionId: string,
  inputs: Proof[],
  outcomeCollectionKeysets: Record<string, string>,
  amountSubunits: number,
): void {
  if (!/^[0-9a-fA-F]{64}$/.test(conditionId)) {
    throw new Error(
      "conditionId must be a 64-character hex string for CTF split",
    );
  }
  if (!Number.isSafeInteger(amountSubunits) || amountSubunits <= 0) {
    throw new Error("amountSubunits must be a positive safe integer");
  }
  if (inputs.length === 0)
    throw new Error("CTF split requires collateral proofs");
  const collections = Object.keys(outcomeCollectionKeysets);
  if (collections.length < 2) {
    throw new Error(
      "CTF split requires at least two outcome collection keysets",
    );
  }
  for (const collection of collections) {
    if (!collection)
      throw new Error("CTF split outcome collection key cannot be empty");
    if (!outcomeCollectionKeysets[collection]) {
      throw new Error(
        `CTF split keyset id is missing for outcome collection ${collection}`,
      );
    }
  }
}

async function validateInputBalance(
  inputs: Proof[],
  amountSubunits: number,
  getKeys: (keysetId: string) => Promise<MintKeys>,
  expectedBaseAsset: MarketBaseAsset | null = null,
): Promise<void> {
  const inputFeePpkByKeyset: Record<string, number> = {};
  for (const proof of inputs) {
    const keyset = await getKeys(proof.id);
    if (expectedBaseAsset) {
      validateKeysetUnit(
        keyset,
        expectedBaseAsset,
        `CTF split input proof keyset ${proof.id}`,
      );
    }
    inputFeePpkByKeyset[proof.id] = keyset.input_fee_ppk ?? 0;
  }

  const inputFeeSats = computeInputFeeSatsForProofs(
    inputs,
    inputFeePpkByKeyset,
  );
  const inputAmountSubunits = inputs.reduce(
    (acc, proof) => acc + amountToNumber(proof.amount),
    0,
  );
  const netInputSats = inputAmountSubunits - inputFeeSats;

  if (netInputSats !== amountSubunits) {
    throw new Error(
      `CTF split inputs net ${netInputSats} sats after ${inputFeeSats} sats input fee, expected ${amountSubunits}`,
    );
  }
}

async function resolveInputFeePpkByProofKeyset(
  mint: CashuMint,
  proofs: readonly Pick<Proof, "id">[],
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const keysetId of [...new Set(proofs.map((proof) => proof.id))]) {
    if (!keysetId) throw new Error("Input proof is missing keyset id");
    const response = await mint.getKeys(keysetId);
    const keyset = response.keysets.find(
      (candidate) => candidate.id === keysetId,
    );
    if (!keyset) {
      throw new Error(`Mint did not return keys for keyset ${keysetId}`);
    }
    result[keysetId] = keyset.input_fee_ppk ?? 0;
  }
  return result;
}

function ctfInputFeeForGrossAmount(
  keyset: CtfGrossInputPlanningKeyset,
  grossAmountSubunits: number,
): number {
  const outputProofCount = splitAmount(
    Amount.from(grossAmountSubunits),
    keyset.keys,
  ).length;
  return Math.ceil((outputProofCount * keyset.input_fee_ppk) / 1_000);
}

function validateOutputs(
  collection: string,
  keysetId: string,
  amountSubunits: number,
  outputs: CtfSplitOutputData[],
): void {
  if (outputs.length === 0) {
    throw new Error(
      `No blinded outputs generated for outcome collection ${collection}`,
    );
  }
  const total = outputs.reduce(
    (acc, output) => acc + amountToNumber(output.blindedMessage.amount),
    0,
  );
  if (total !== amountSubunits) {
    throw new Error(
      `CTF split outputs for outcome collection ${collection} total ${total}, expected ${amountSubunits}`,
    );
  }
  const mismatched = outputs.find(
    (output) => output.blindedMessage.id !== keysetId,
  );
  if (mismatched) {
    throw new Error(
      `CTF split output for outcome collection ${collection} used keyset ${mismatched.blindedMessage.id}, expected ${keysetId}`,
    );
  }
}

function validateSignature(
  collection: string,
  output: SerializedBlindedMessage,
  signature: SerializedBlindedSignature,
): void {
  if (signature.id !== output.id) {
    throw new Error(
      `CTF split signature for outcome collection ${collection} used keyset ${signature.id}, expected ${output.id}`,
    );
  }
  if (amountToNumber(signature.amount) !== amountToNumber(output.amount)) {
    throw new Error(
      `CTF split signature for outcome collection ${collection} amount ${signature.amount}, expected ${output.amount}`,
    );
  }
}

export function serializeOutputDataArray(
  outputs: Array<Pick<CtfSplitOutputData, "blindedMessage" | "blindingFactor" | "secret">>,
): StoredOutputData[] {
  return outputs.map((output) => ({
    blindedMessage: {
      amount: amountToNumber(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor.toString(16),
    secret: bytesToHex(output.secret),
  }));
}

function toWireBlindedMessage(
  output: SerializedBlindedMessage,
): SerializedBlindedMessage {
  return {
    ...output,
    amount: amountToNumber(output.amount),
  } as unknown as SerializedBlindedMessage;
}

export function normalizeProof(proof: Proof): Proof {
  return {
    ...proof,
    amount: amountToNumber(proof.amount) as never,
  };
}

export function normalizeProofArray(proofs: readonly Proof[]): Proof[] {
  return proofs.map(normalizeProof);
}

export function normalizeProofGroups(
  groups: Record<string, Proof[]>,
): Record<string, Proof[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, proofs]) => [
      group,
      proofs.map(normalizeProof),
    ]),
  );
}

function flattenProofs(proofsByCollection: Record<string, Proof[]>): Proof[] {
  return Object.values(proofsByCollection).flatMap((proofs) => proofs);
}

function deserializeCtfOutputGroups(
  groups: Record<string, StoredOutputData[]>,
): Record<string, CtfSplitOutputData[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, outputs]) => [
      group,
      outputs.map(
        (output) =>
          new RegularOutputData(
            {
              ...output.blindedMessage,
              amount: Amount.from(output.blindedMessage.amount),
            },
            BigInt(`0x${output.blindingFactor}`),
            hexToBytes(output.secret),
          ),
      ),
    ]),
  );
}

export function deserializeOutputGroups(
  groups: Record<string, StoredOutputData[]>,
): Record<string, RegularOutputData[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, outputs]) => [
      group,
      outputs.map(
        (output) =>
          new RegularOutputData(
            {
              ...output.blindedMessage,
              amount: Amount.from(output.blindedMessage.amount),
            },
            BigInt(`0x${output.blindingFactor}`),
            hexToBytes(output.secret),
          ),
      ),
    ]),
  );
}

export function entryToSwapPreview(entry: CtfProofOperationRecord): SwapPreview {
  const metadata = entry.metadata as {
    amount?: unknown;
    fees?: unknown;
    keysetId?: unknown;
    unselectedProofs?: unknown;
  };
  if (
    !Number.isSafeInteger(metadata.amount) ||
    !Number.isSafeInteger(metadata.fees) ||
    typeof metadata.keysetId !== "string"
  ) {
    throw new Error(
      `proof operation ${entry.operationId} is missing regular split metadata`,
    );
  }
  const amount = metadata.amount as number;
  const fees = metadata.fees as number;
  const keysetId = metadata.keysetId;
  const outputs = deserializeOutputGroups(entry.outputs);
  return {
    amount: Amount.from(amount),
    fees: Amount.from(fees),
    keysetId,
    inputs: entry.inputs.map(normalizeProof),
    sendOutputs: outputs.send ?? [],
    keepOutputs: outputs.keep ?? [],
    unselectedProofs: Array.isArray(metadata.unselectedProofs)
      ? structuredClone(metadata.unselectedProofs as Proof[])
      : [],
  };
}

export function readUnselectedProofs(entry: CtfProofOperationRecord): Proof[] {
  const metadata = entry.metadata as { unselectedProofs?: unknown };
  return Array.isArray(metadata.unselectedProofs)
    ? (metadata.unselectedProofs as Proof[]).map(normalizeProof)
    : [];
}

function defaultMakeOutputs(input: {
  amountSubunits: number;
  keyset: MintKeys;
}): CtfSplitOutputData[] {
  return RegularOutputData.createRandomData(
    Amount.from(input.amountSubunits),
    input.keyset,
  );
}

function parseOutcomeSetToComparableSet(outcomeSetId: string): Set<string> {
  const elements = parseOutcomeSetId(outcomeSetId);
  if (elements.length === 0) {
    throw new Error("CTF split outcome-set id cannot be empty");
  }
  return new Set(elements.map(comparableOutcome));
}

function parseOutcomeSetId(outcomeSetId: string): string[] {
  return outcomeSetId
    .split("|")
    .map((outcome) => outcome.trim())
    .filter(Boolean);
}

function buildRootCollectionSets(
  rootCollections: string[],
): Array<{ collection: string; outcomes: Set<string> }> {
  const seenPrimitive = new Map<string, string>();
  return rootCollections.map((collection) => {
    const outcomes = parseOutcomeSetToComparableSet(collection);
    for (const primitive of outcomes) {
      const existing = seenPrimitive.get(primitive);
      if (existing) {
        throw new Error(
          `CTF split root outcome collection ${collection} overlaps primitive outcome ${primitive} with ${existing}`,
        );
      }
      seenPrimitive.set(primitive, collection);
    }
    return { collection, outcomes };
  });
}

function resolveRootOutcomeCollections(
  outcomeSetId: string,
  outcomeSet: Set<string>,
  rootCollectionSets: Array<{ collection: string; outcomes: Set<string> }>,
  branch: "lock" | "keep",
): string[] {
  const collections: string[] = [];
  const covered = new Set<string>();
  for (const { collection, outcomes } of rootCollectionSets) {
    if (!setIsSubset(outcomes, outcomeSet)) continue;
    collections.push(collection);
    for (const primitive of outcomes) covered.add(primitive);
  }
  if (!outcomeSetsEqual(covered, outcomeSet)) {
    const missing = [...outcomeSet]
      .filter((primitive) => !covered.has(primitive))
      .join("|");
    throw new Error(
      `CTF split ${branch} outcome ${outcomeSetId} contains primitive ${missing} with no mint root keyset`,
    );
  }
  return collections;
}

function setIsSubset(candidate: Set<string>, container: Set<string>): boolean {
  for (const value of candidate) {
    if (!container.has(value)) return false;
  }
  return true;
}

function canonicalizeOutcomeSetCollections(collections: string[]): string {
  return collections.flatMap(parseOutcomeSetId).sort().join("|");
}

function comparableOutcome(outcome: string): string {
  return outcome.trim();
}

function outcomeSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function blindedMessageKey(output: SerializedBlindedMessage): string {
  return `${output.id}:${output.B_}`;
}

export function allStates(states: ProofState[], expected: string): boolean {
  return states.length > 0 && states.every((state) => state.state === expected);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have an even length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
