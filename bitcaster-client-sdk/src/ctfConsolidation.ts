import type {
  CtfConvertRequest,
  Proof,
  SerializedBlindedMessage,
} from "@cashu/cashu-ts";
import {
  amountToNumber,
  computeInputFeeSatsForProofs,
} from "./proofSelection.ts";
import { canonicalizeOutcomeSet, parseOutcomeSetId } from "./outcomeSets.ts";

export const COLLATERAL_COLLECTION = "*";

export type CtfConsolidationStrategy = "t1" | "t2" | "t3";

export type CtfConsolidationNoopReason =
  | "market-not-pending"
  | "invalid-market"
  | "no-matching-inputs"
  | "input-fee-floor-zero"
  | "insufficient-outcome-floor"
  | "net-collateral-nonpositive"
  | "collateral-top-up-mismatch"
  | "missing-output-keyset"
  | "unsupported-residual"
  | "unsupported-parent";

export interface CtfConsolidationOutputFactoryInput {
  collection: string;
  amountSats: number;
  keysetId: string;
}

export interface CtfConsolidationParams {
  conditionId: string;
  parentCollectionId?: string;
  outcomes: string[];
  marketStatus: string;
  strategy: CtfConsolidationStrategy;
  proofsByCollection: Record<string, Proof[]>;
  inputFeePpkByKeyset: Record<string, number>;
  outputKeysetByCollection: Record<string, string>;
  makeOutputs(input: CtfConsolidationOutputFactoryInput): SerializedBlindedMessage[];
}

export interface CtfConsolidationPlan {
  kind: "plan";
  strategy: CtfConsolidationStrategy;
  feeSats: number;
  collateralOutputSats: number;
  inputPayoff: Record<string, number>;
  outputPayoff: Record<string, number>;
  request: CtfConvertRequest;
}

export interface CtfConsolidationNoop {
  kind: "noop";
  strategy: CtfConsolidationStrategy;
  reason: CtfConsolidationNoopReason;
  feeSats?: number;
  inputPayoff?: Record<string, number>;
}

export type CtfConsolidationResult =
  | CtfConsolidationPlan
  | CtfConsolidationNoop;

interface NormalizedMarket {
  outcomes: string[];
  outcomeSet: Set<string>;
  proofsByCollection: Record<string, Proof[]>;
}

interface OutputAmount {
  collection: string;
  amountSats: number;
}

interface CandidateOutput {
  collection: string;
  vector: number[];
}

export function planCtfConsolidation(
  params: CtfConsolidationParams,
): CtfConsolidationResult {
  if (params.marketStatus !== "pending") {
    return noop(params.strategy, "market-not-pending");
  }
  if (params.parentCollectionId?.trim()) {
    return noop(params.strategy, "unsupported-parent");
  }

  const market = normalizeMarket(params.outcomes, params.proofsByCollection);
  if (!market || !params.conditionId) {
    return noop(params.strategy, "invalid-market");
  }

  switch (params.strategy) {
    case "t1":
      return planT1(params, market);
    case "t2":
      return planT2(params, market);
    case "t3":
      return planT3(params, market);
  }
}

export function computeConvertFeeSats(
  proofs: readonly Proof[],
  inputFeePpkByKeyset: Record<string, number>,
): number {
  return computeInputFeeSatsForProofs(proofs, inputFeePpkByKeyset);
}

export function payoffVector(
  outcomes: readonly string[],
  proofsByCollection: Record<string, readonly Proof[]>,
): Record<string, number> {
  const vector = Object.fromEntries(outcomes.map((outcome) => [outcome, 0]));
  for (const [collection, proofs] of Object.entries(proofsByCollection)) {
    const amount = sumProofs(proofs);
    if (amount === 0) continue;
    const support =
      collection === COLLATERAL_COLLECTION
        ? outcomes
        : parseOutcomeSetId(collection);
    for (const outcome of support) {
      if (outcome in vector) vector[outcome] += amount;
    }
  }
  return vector;
}

function planT1(
  params: CtfConsolidationParams,
  market: NormalizedMarket,
): CtfConsolidationResult {
  const singletonCollections = market.outcomes.filter(
    (outcome) => sumProofs(market.proofsByCollection[outcome] ?? []) > 0,
  );
  if (singletonCollections.length !== market.outcomes.length - 1) {
    return noop(params.strategy, "no-matching-inputs");
  }

  const singletonAmount = sumProofs(
    market.proofsByCollection[singletonCollections[0]] ?? [],
  );
  if (
    singletonAmount <= 0 ||
    singletonCollections.some(
      (collection) =>
        sumProofs(market.proofsByCollection[collection] ?? []) !==
        singletonAmount,
    )
  ) {
    return noop(params.strategy, "no-matching-inputs");
  }

  const availableCollateralProofs =
    market.proofsByCollection[COLLATERAL_COLLECTION] ?? [];
  if (availableCollateralProofs.length === 0) {
    return noop(params.strategy, "no-matching-inputs");
  }

  const inputProofsByCollection = Object.fromEntries(
    singletonCollections.map((collection) => [
      collection,
      market.proofsByCollection[collection] ?? [],
    ]),
  );
  const collateralProofs = selectCollateralTopUp(
    flattenProofs(inputProofsByCollection),
    availableCollateralProofs,
    params.inputFeePpkByKeyset,
  );
  if (!collateralProofs) {
    return noop(params.strategy, "collateral-top-up-mismatch");
  }
  inputProofsByCollection[COLLATERAL_COLLECTION] = collateralProofs;

  const selectedProofs = flattenProofs(inputProofsByCollection);
  const feeSats = computeConvertFeeSats(selectedProofs, params.inputFeePpkByKeyset);
  if (feeSats === 0) return noop(params.strategy, "input-fee-floor-zero");

  const inputPayoff = payoffVector(market.outcomes, inputProofsByCollection);
  if (!hasOutcomeFloor(inputPayoff, feeSats)) {
    return noop(params.strategy, "insufficient-outcome-floor", {
      feeSats,
      inputPayoff,
    });
  }

  const missingOutcome = market.outcomes.find(
    (outcome) => !singletonCollections.includes(outcome),
  );
  if (!missingOutcome) return noop(params.strategy, "no-matching-inputs");

  const complementCollection = canonicalizeOutcomeSet(
    market.outcomes.filter((outcome) => outcome !== missingOutcome),
  );
  return buildPlan(params, market, inputProofsByCollection, feeSats, [
    { collection: complementCollection, amountSats: singletonAmount },
  ]);
}

function planT2(
  params: CtfConsolidationParams,
  market: NormalizedMarket,
): CtfConsolidationResult {
  const complementCollections = Object.keys(market.proofsByCollection).filter(
    (collection) =>
      collection !== COLLATERAL_COLLECTION &&
      parseOutcomeSetId(collection).length === market.outcomes.length - 1 &&
      sumProofs(market.proofsByCollection[collection] ?? []) > 0,
  );
  if (complementCollections.length < 2) {
    return noop(params.strategy, "no-matching-inputs");
  }

  const inputProofsByCollection = Object.fromEntries(
    complementCollections.map((collection) => [
      collection,
      market.proofsByCollection[collection] ?? [],
    ]),
  );
  return planCollateralExtraction(params, market, inputProofsByCollection);
}

function planT3(
  params: CtfConsolidationParams,
  market: NormalizedMarket,
): CtfConsolidationResult {
  if (flattenProofs(market.proofsByCollection).length === 0) {
    return noop(params.strategy, "no-matching-inputs");
  }
  return planCollateralExtraction(params, market, market.proofsByCollection);
}

function planCollateralExtraction(
  params: CtfConsolidationParams,
  market: NormalizedMarket,
  inputProofsByCollection: Record<string, Proof[]>,
): CtfConsolidationResult {
  const selectedProofs = flattenProofs(inputProofsByCollection);
  const feeSats = computeConvertFeeSats(
    selectedProofs,
    params.inputFeePpkByKeyset,
  );
  if (feeSats === 0) return noop(params.strategy, "input-fee-floor-zero");

  const inputPayoff = payoffVector(market.outcomes, inputProofsByCollection);
  if (!hasOutcomeFloor(inputPayoff, feeSats)) {
    return noop(params.strategy, "insufficient-outcome-floor", {
      feeSats,
      inputPayoff,
    });
  }

  const outputVector = subtractFee(inputPayoff, feeSats);
  const collateralOutputSats = Math.min(
    ...market.outcomes.map((outcome) => outputVector[outcome] ?? 0),
  );
  if (collateralOutputSats <= 0) {
    return noop(params.strategy, "net-collateral-nonpositive", {
      feeSats,
      inputPayoff,
    });
  }

  const residual = Object.fromEntries(
    market.outcomes.map((outcome) => [
      outcome,
      (outputVector[outcome] ?? 0) - collateralOutputSats,
    ]),
  );
  const residualOutputs = decomposeResidual(market.outcomes, residual);
  if (!residualOutputs) {
    return noop(params.strategy, "unsupported-residual", {
      feeSats,
      inputPayoff,
    });
  }

  return buildPlan(params, market, inputProofsByCollection, feeSats, [
    {
      collection: COLLATERAL_COLLECTION,
      amountSats: collateralOutputSats,
    },
    ...residualOutputs,
  ]);
}

function buildPlan(
  params: CtfConsolidationParams,
  market: NormalizedMarket,
  inputProofsByCollection: Record<string, Proof[]>,
  feeSats: number,
  outputs: OutputAmount[],
): CtfConsolidationResult {
  const requestOutputs: Record<string, SerializedBlindedMessage[]> = {};
  for (const output of outputs) {
    if (output.amountSats <= 0) continue;
    const keysetId = params.outputKeysetByCollection[output.collection];
    if (!keysetId) {
      return noop(params.strategy, "missing-output-keyset", {
        feeSats,
        inputPayoff: payoffVector(market.outcomes, inputProofsByCollection),
      });
    }
    const messages = params.makeOutputs({
      collection: output.collection,
      amountSats: output.amountSats,
      keysetId,
    });
    validateOutputMessages(output, keysetId, messages);
    requestOutputs[output.collection] = messages;
  }

  const inputPayoff = payoffVector(market.outcomes, inputProofsByCollection);
  const outputPayoff = payoffVectorFromOutputAmounts(market.outcomes, outputs);
  const expectedOutputPayoff = subtractFee(inputPayoff, feeSats);
  assertPayoffConservation(market.outcomes, outputPayoff, expectedOutputPayoff);

  return {
    kind: "plan",
    strategy: params.strategy,
    feeSats,
    collateralOutputSats: sumOutputAmount(
      outputs,
      COLLATERAL_COLLECTION,
    ),
    inputPayoff,
    outputPayoff,
    request: {
      condition_id: params.conditionId,
      inputs: inputProofsByCollection,
      outputs: requestOutputs,
    },
  };
}

function decomposeResidual(
  outcomes: readonly string[],
  residual: Record<string, number>,
): OutputAmount[] | null {
  const target = outcomes.map((outcome) => residual[outcome] ?? 0);
  if (target.every((amount) => amount === 0)) return [];

  const candidates = residualCandidates(outcomes);
  for (let size = 1; size <= outcomes.length; size += 1) {
    for (const subset of combinations(candidates, size)) {
      const solution = solveIndependentSubset(subset, target);
      if (!solution) continue;
      return subset.map((candidate, index) => ({
        collection: candidate.collection,
        amountSats: solution[index],
      }));
    }
  }

  return null;
}

function selectCollateralTopUp(
  fixedProofs: readonly Proof[],
  collateralProofs: readonly Proof[],
  inputFeePpkByKeyset: Record<string, number>,
): Proof[] | null {
  const maxFeeSats = computeConvertFeeSats(
    [...fixedProofs, ...collateralProofs],
    inputFeePpkByKeyset,
  );
  for (let target = 1; target <= maxFeeSats; target += 1) {
    const subset = findProofSubsetByAmount(collateralProofs, target);
    if (!subset) continue;
    const feeSats = computeConvertFeeSats(
      [...fixedProofs, ...subset],
      inputFeePpkByKeyset,
    );
    if (feeSats === target) return subset;
  }
  return null;
}

function findProofSubsetByAmount(
  proofs: readonly Proof[],
  target: number,
): Proof[] | null {
  const byAmount = new Map<number, Proof[]>();
  byAmount.set(0, []);
  for (const proof of proofs) {
    const amount = amountToNumber(proof.amount);
    if (amount <= 0 || amount > target) continue;
    for (const [sum, selected] of [...byAmount.entries()]) {
      const next = sum + amount;
      if (next > target || byAmount.has(next)) continue;
      const nextSelected = [...selected, proof];
      if (next === target) return nextSelected;
      byAmount.set(next, nextSelected);
    }
  }
  return byAmount.get(target) ?? null;
}

function residualCandidates(outcomes: readonly string[]): CandidateOutput[] {
  const singletons = outcomes.map((outcome, index) => ({
    collection: outcome,
    vector: outcomes.map((_, candidateIndex) =>
      candidateIndex === index ? 1 : 0,
    ),
  }));
  const complements = outcomes.map((_, index) => ({
    collection: canonicalizeOutcomeSet(
      outcomes.filter((_, candidateIndex) => candidateIndex !== index),
    ),
    vector: outcomes.map((_, candidateIndex) =>
      candidateIndex === index ? 0 : 1,
    ),
  }));
  return [...singletons, ...complements];
}

function solveIndependentSubset(
  candidates: readonly CandidateOutput[],
  target: readonly number[],
): number[] | null {
  const matrix = target.map((_, rowIndex) =>
    candidates.map((candidate) => candidate.vector[rowIndex]),
  );
  const solution = solveFullColumnRank(matrix, target);
  if (!solution) return null;
  if (solution.some((amount) => amount <= 0)) return null;
  if (solution.some((amount) => !Number.isSafeInteger(amount))) return null;
  return solution;
}

function solveFullColumnRank(
  matrix: number[][],
  target: readonly number[],
): number[] | null {
  const rowCount = matrix.length;
  const columnCount = matrix[0]?.length ?? 0;
  if (columnCount === 0) return target.every((amount) => amount === 0) ? [] : null;
  if (columnCount > rowCount) return null;

  const augmented = matrix.map((row, rowIndex) => [
    ...row.map((value) => Number(value)),
    target[rowIndex],
  ]);
  const pivotRows: number[] = [];
  let pivotColumn = 0;

  for (let row = 0; row < rowCount && pivotColumn < columnCount; row += 1) {
    let pivot = row;
    while (
      pivot < rowCount &&
      Math.abs(augmented[pivot][pivotColumn] ?? 0) < 1e-9
    ) {
      pivot += 1;
    }
    if (pivot === rowCount) return null;
    [augmented[row], augmented[pivot]] = [augmented[pivot], augmented[row]];

    const divisor = augmented[row][pivotColumn];
    for (let column = pivotColumn; column <= columnCount; column += 1) {
      augmented[row][column] /= divisor;
    }
    for (let other = 0; other < rowCount; other += 1) {
      if (other === row) continue;
      const factor = augmented[other][pivotColumn];
      if (Math.abs(factor) < 1e-9) continue;
      for (let column = pivotColumn; column <= columnCount; column += 1) {
        augmented[other][column] -= factor * augmented[row][column];
      }
    }

    pivotRows.push(row);
    pivotColumn += 1;
  }

  if (pivotRows.length !== columnCount) return null;

  const solution = pivotRows.map((row) => {
    const rounded = Math.round(augmented[row][columnCount]);
    return Math.abs(augmented[row][columnCount] - rounded) < 1e-9
      ? rounded
      : Number.NaN;
  });
  if (solution.some((amount) => !Number.isFinite(amount))) return null;

  for (let row = 0; row < rowCount; row += 1) {
    const projected = solution.reduce(
      (sum, amount, column) => sum + amount * matrix[row][column],
      0,
    );
    if (projected !== target[row]) return null;
  }

  return solution;
}

function* combinations<T>(
  items: readonly T[],
  size: number,
  start = 0,
  prefix: T[] = [],
): Generator<T[]> {
  if (prefix.length === size) {
    yield [...prefix];
    return;
  }
  for (let index = start; index <= items.length - (size - prefix.length); index += 1) {
    prefix.push(items[index]);
    yield* combinations(items, size, index + 1, prefix);
    prefix.pop();
  }
}

function normalizeMarket(
  rawOutcomes: readonly string[],
  rawProofsByCollection: Record<string, Proof[]>,
): NormalizedMarket | null {
  const outcomes = [...new Set(rawOutcomes.map((outcome) => outcome.trim()))]
    .filter(Boolean)
    .sort();
  if (outcomes.length < 2 || outcomes.length > 8) return null;

  const outcomeSet = new Set(outcomes);
  const proofsByCollection: Record<string, Proof[]> = {};
  for (const [rawCollection, proofs] of Object.entries(rawProofsByCollection)) {
    const collection =
      rawCollection === COLLATERAL_COLLECTION
        ? COLLATERAL_COLLECTION
        : canonicalizeOutcomeSet(parseOutcomeSetId(rawCollection));
    if (!collection || proofs.length === 0) continue;
    if (
      collection !== COLLATERAL_COLLECTION &&
      parseOutcomeSetId(collection).some((outcome) => !outcomeSet.has(outcome))
    ) {
      return null;
    }
    proofsByCollection[collection] = [
      ...(proofsByCollection[collection] ?? []),
      ...proofs,
    ];
  }

  return { outcomes, outcomeSet, proofsByCollection };
}

function hasOutcomeFloor(
  vector: Record<string, number>,
  feeSats: number,
): boolean {
  return Object.values(vector).every((amount) => amount >= feeSats);
}

function subtractFee(
  vector: Record<string, number>,
  feeSats: number,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(vector).map(([outcome, amount]) => [outcome, amount - feeSats]),
  );
}

function payoffVectorFromOutputAmounts(
  outcomes: readonly string[],
  outputs: readonly OutputAmount[],
): Record<string, number> {
  const proofsByCollection = Object.fromEntries(
    outputs.map((output) => [
      output.collection,
      [
        {
          id: "",
          amount: output.amountSats,
          secret: "",
          C: "",
        } as unknown as Proof,
      ],
    ]),
  );
  return payoffVector(outcomes, proofsByCollection);
}

function assertPayoffConservation(
  outcomes: readonly string[],
  actual: Record<string, number>,
  expected: Record<string, number>,
): void {
  for (const outcome of outcomes) {
    if (actual[outcome] !== expected[outcome]) {
      throw new Error(
        `CTF consolidation payoff mismatch for ${outcome}: output ${actual[outcome]}, expected ${expected[outcome]}`,
      );
    }
  }
}

function validateOutputMessages(
  output: OutputAmount,
  keysetId: string,
  messages: readonly SerializedBlindedMessage[],
): void {
  if (messages.length === 0) {
    throw new Error(
      `No blinded outputs generated for collection ${output.collection}`,
    );
  }
  const amount = messages.reduce(
    (sum, message) => sum + amountToNumber(message.amount),
    0,
  );
  if (amount !== output.amountSats) {
    throw new Error(
      `Blinded outputs for ${output.collection} total ${amount}, expected ${output.amountSats}`,
    );
  }
  if (messages.some((message) => message.id !== keysetId)) {
    throw new Error(
      `Blinded outputs for ${output.collection} must use keyset ${keysetId}`,
    );
  }
}

function flattenProofs(
  proofsByCollection: Record<string, readonly Proof[]>,
): Proof[] {
  return Object.values(proofsByCollection).flatMap((proofs) => [...proofs]);
}

function sumProofs(proofs: readonly Proof[]): number {
  return proofs.reduce(
    (sum, proof) => sum + amountToNumber(proof.amount),
    0,
  );
}

function sumOutputAmount(
  outputs: readonly OutputAmount[],
  collection: string,
): number {
  return outputs
    .filter((output) => output.collection === collection)
    .reduce((sum, output) => sum + output.amountSats, 0);
}

function noop(
  strategy: CtfConsolidationStrategy,
  reason: CtfConsolidationNoopReason,
  extra?: Pick<CtfConsolidationNoop, "feeSats" | "inputPayoff">,
): CtfConsolidationNoop {
  return { kind: "noop", strategy, reason, ...extra };
}
