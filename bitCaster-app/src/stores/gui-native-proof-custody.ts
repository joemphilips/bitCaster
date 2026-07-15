import type { Proof } from "@cashu/cashu-ts";
import { sameCashuProofArtifact } from "@bitcaster/client-sdk/proofSelection";
import {
  isCollateralUnitOf,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import {
  assertDurableWalletProofResultMatchesPlan,
  durableWalletPassthroughProofs,
  requireDurableWalletProofTransition,
  type DurableWalletResultProof,
  type DurableWalletProofTransition,
} from "@bitcaster/client-sdk/durableWalletProofTransition";
import { normalizeUrl } from "../lib/url";
import type { ActiveSwap } from "./activeSwaps";
import {
  locateStoredProofs,
  normalizeStoredProofForStorage,
  prepareStoredProofForWrite,
  type ProofOperationRecord,
  type StoredProof,
} from "./proof-db";

export interface GuiNativeProofDelta {
  walletId: string;
  deleteProofs: StoredProof[];
  nextProofs: StoredProof[];
  reservationOwner: string;
  reservationReleaseProofSecrets: string[];
}

export function reserveGuiNativeInputProofs(
  operationId: string,
  mintUrl: string,
  inputs: readonly DurableWalletResultProof[],
  storedProofs: readonly StoredProof[],
  walletId: string,
  parentReservationId?: string,
): StoredProof[] {
  return requireGuiNativeInputProofs(
    operationId,
    mintUrl,
    inputs,
    storedProofs,
    "available",
    walletId,
    parentReservationId,
  ).map((proof) => ({ ...proof, reservedBy: operationId }));
}

export function requireGuiNativeInputProofs(
  operationId: string,
  mintUrl: string,
  inputs: readonly DurableWalletResultProof[],
  storedProofs: readonly StoredProof[],
  reservation: "available" | "owned",
  walletId: string,
  parentReservationId?: string,
): StoredProof[] {
  const bySecret = new Map(storedProofs.map((proof) => [proof.secret, proof]));
  return inputs.map((input) => {
    const stored = bySecret.get(input.secret);
    const reservationMatches =
      reservation === "available"
        ? stored?.reservedBy === undefined ||
          stored.reservedBy === operationId ||
          stored.reservedBy === parentReservationId
        : stored?.reservedBy === operationId;
    if (
      !stored ||
      stored.walletId !== walletId ||
      !sameCashuProofArtifact(stored, input) ||
      normalizeUrl(stored.mintUrl) !== normalizeUrl(mintUrl) ||
      !reservationMatches
    ) {
      throw new Error(
        "GUI wallet operation input proof is foreign or reserved",
      );
    }
    return stored;
  });
}

export function requireGuiNativeProofInputAuthority(
  operation: ProofOperationRecord,
  storedProofs: readonly StoredProof[],
  policy: DurableWalletProofTransition,
  reservation: "available" | "owned",
  parentReservationId?: string,
): StoredProof[] {
  const authorityProofs = guiNativeProofAuthority(operation, policy);
  switch (policy.inputSource) {
    case "wallet":
      return requireGuiNativeInputProofs(
        operation.operationId,
        operation.mintUrl,
        authorityProofs,
        storedProofs,
        reservation,
        operation.walletId,
        parentReservationId,
      );
    case "external":
      if (
        storedProofs.some((stored) =>
          authorityProofs.some(({ secret }) => secret === stored.secret),
        )
      ) {
        throw new Error("External GUI operation references a wallet proof");
      }
      return [];
  }
}

export function guiNativeProofAuthority(
  operation: Pick<ProofOperationRecord, "inputs">,
  policy: DurableWalletProofTransition,
): DurableWalletResultProof[] {
  const authority = [
    ...operation.inputs,
    ...durableWalletPassthroughProofs(policy),
  ];
  if (
    new Set(authority.map(({ secret }) => secret)).size !== authority.length
  ) {
    throw new Error("GUI wallet operation proof authority contains duplicates");
  }
  return authority;
}

export async function prepareGuiNativeProofDelta(
  operation: ProofOperationRecord,
  resultProofs: Record<string, Proof[]>,
  swap: ActiveSwap,
): Promise<GuiNativeProofDelta> {
  const policy = requireDurableWalletProofTransition(
    operation.metadata,
    Object.keys(operation.outputs),
  );
  assertDurableWalletProofResultMatchesPlan(
    policy,
    operation.outputs,
    resultProofs,
  );
  const nextProofs = await prepareWalletResultProofs(
    operation,
    resultProofs,
    swap,
    policy,
  );
  assertUniqueProofSecrets(nextProofs);
  return {
    walletId: operation.walletId,
    deleteProofs:
      policy.inputSource === "wallet"
        ? locateStoredProofs(
            operation.inputs,
            operation.mintUrl,
            operation.metadata.unit,
          )
        : [],
    nextProofs,
    reservationOwner: operation.operationId,
    reservationReleaseProofSecrets:
      policy.inputSource === "wallet"
        ? durableWalletPassthroughProofs(policy).map(({ secret }) => secret)
        : [],
  };
}

export function finalizeGuiNativeProofDelta(
  draft: GuiNativeProofDelta,
  snapshotProofs: readonly StoredProof[],
): GuiNativeProofDelta {
  const now = Date.now();
  const bySecret = new Map(
    snapshotProofs.map((proof) => [proof.secret, proof]),
  );
  const deleted = new Set(draft.deleteProofs.map(({ secret }) => secret));
  const reservationRelease = new Set(draft.reservationReleaseProofSecrets);
  const nextProofs = draft.nextProofs.map((proof) => {
    if (deleted.has(proof.secret)) {
      throw new Error("GUI proof result reuses an input proof secret");
    }
    const existing = bySecret.get(proof.secret);
    if (!existing)
      return prepareStoredProofForWrite(proof, now, draft.walletId);
    if (reservationRelease.has(proof.secret)) {
      if (existing.reservedBy !== draft.reservationOwner) {
        throw new Error(
          "GUI proof passthrough has foreign reservation authority",
        );
      }
      assertSameStoredProofAuthority(
        { ...existing, reservedBy: proof.reservedBy },
        proof,
      );
    } else {
      assertSameStoredProofAuthority(existing, proof);
    }
    return normalizeStoredProofForStorage(
      {
        ...proof,
        receivedAt: existing.receivedAt ?? proof.receivedAt,
      },
      draft.walletId,
    );
  });
  return { ...draft, nextProofs };
}

export function assertSameStoredProofAuthority(
  existing: StoredProof,
  expected: StoredProof,
): void {
  if (
    existing.walletId !== expected.walletId ||
    !sameCashuProofArtifact(existing, expected) ||
    normalizeUrl(existing.mintUrl) !== normalizeUrl(expected.mintUrl) ||
    existing.unit !== expected.unit ||
    existing.baseAsset !== expected.baseAsset ||
    existing.conditionId !== expected.conditionId ||
    existing.outcomeCollection !== expected.outcomeCollection ||
    existing.marketId !== expected.marketId ||
    existing.reservedBy !== expected.reservedBy
  ) {
    throw new Error(
      "GUI proof result conflicts with existing wallet authority",
    );
  }
}

async function prepareWalletResultProofs(
  operation: ProofOperationRecord,
  resultProofs: Record<string, Proof[]>,
  swap: ActiveSwap,
  policy: DurableWalletProofTransition,
): Promise<StoredProof[]> {
  const groups = Object.entries(resultProofs).filter(
    ([label]) => policy.resultGroups[label]?.kind === "wallet",
  );
  const prepared = await Promise.all(
    groups.map(([label, proofs]) =>
      prepareWalletResultGroup(operation, swap, policy, label, proofs),
    ),
  );
  return prepared.flat();
}

async function prepareWalletResultGroup(
  operation: ProofOperationRecord,
  swap: ActiveSwap,
  policy: DurableWalletProofTransition,
  label: string,
  proofs: Proof[],
): Promise<StoredProof[]> {
  const disposition = policy.resultGroups[label];
  if (disposition?.kind !== "wallet") return [];
  if (disposition.asset === "conditional") {
    return storedConditionalResultProofs(
      operation,
      proofs,
      swap,
      disposition.reservedBy,
    );
  }
  const baseAsset = normalizeMarketBaseAsset(swap.baseAsset);
  const unit = parseCashuProofUnit(operation.metadata.unit);
  if (!unit || !isCollateralUnitOf(unit, baseAsset)) {
    throw new Error("GUI proof result has an invalid exact Cashu unit");
  }
  return proofs.map((proof) => ({
    ...proof,
    walletId: operation.walletId,
    mintUrl: operation.mintUrl,
    baseAsset,
    unit,
    ...(disposition.reservedBy === null
      ? {}
      : { reservedBy: disposition.reservedBy }),
  }));
}

function storedConditionalResultProofs(
  operation: ProofOperationRecord,
  proofs: Proof[],
  swap: ActiveSwap,
  reservedBy: string | null,
): StoredProof[] {
  const outcomeByKeyset = requireOutcomeMetadataByKeyset(operation);
  const conditionId = operationConditionId(operation);
  const baseAsset = normalizeMarketBaseAsset(swap.baseAsset);
  const unit = parseCashuProofUnit(operation.metadata.unit);
  if (!unit || !isCollateralUnitOf(unit, baseAsset)) {
    throw new Error("GUI proof result has an invalid exact Cashu unit");
  }
  return proofs.map((proof) => {
    const outcome = outcomeByKeyset[proof.id ?? ""];
    if (!outcome || outcome.conditionId !== conditionId) {
      throw new Error("GUI conditional result has no exact outcome metadata");
    }
    return {
      ...proof,
      walletId: operation.walletId,
      ...outcome,
      mintUrl: operation.mintUrl,
      baseAsset,
      unit,
      ...(reservedBy === null ? {} : { reservedBy }),
    };
  });
}

function requireOutcomeMetadataByKeyset(
  operation: ProofOperationRecord,
): Record<
  string,
  { conditionId: string; outcomeCollection: string; marketId: string }
> {
  const value = operation.metadata.outcomeByKeyset;
  if (!isRecord(value)) {
    throw new Error("GUI conditional operation has no outcome metadata");
  }
  return Object.fromEntries(
    Object.entries(value).map(([keysetId, item]) => {
      if (
        !keysetId ||
        !isRecord(item) ||
        typeof item.conditionId !== "string" ||
        !item.conditionId ||
        typeof item.outcomeCollection !== "string" ||
        !item.outcomeCollection ||
        item.marketId !== `${item.conditionId}-${item.outcomeCollection}`
      ) {
        throw new Error("GUI conditional outcome metadata is invalid");
      }
      return [
        keysetId,
        {
          conditionId: item.conditionId,
          outcomeCollection: item.outcomeCollection,
          marketId: item.marketId,
        },
      ];
    }),
  );
}

function operationConditionId(operation: ProofOperationRecord): string {
  const metadataConditionId = operation.metadata.conditionId;
  if (typeof metadataConditionId === "string" && metadataConditionId) {
    return metadataConditionId;
  }
  throw new Error("GUI conditional operation has no exact condition id");
}

function assertUniqueProofSecrets(proofs: readonly Proof[]): void {
  if (new Set(proofs.map(({ secret }) => secret)).size !== proofs.length) {
    throw new Error("GUI proof result contains a duplicate proof secret");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
