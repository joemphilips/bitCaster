import {
  decodeDurableCustodyScopeId,
  decodeDurableCustodyScopeInput,
} from "@bitcaster/client-sdk/durableCustody";
import { BrowserDurableCustodyAdapter } from "./durable-custody-db";
import { db, type BitcasterDB } from "./proof-db";
import {
  decodeBrowserCustodyProofRow,
  type BrowserCustodyProofSelectability,
  type BrowserCustodyProofRow,
} from "./durable-custody-types";

const PORTFOLIO_SELECTABILITY = [
  "selectable",
  "locked",
  "verified-losing",
  "pending-removal",
] as const satisfies readonly Exclude<BrowserCustodyProofSelectability, "spent">[];

export type PortfolioCustodyProofSelectability = (typeof PORTFOLIO_SELECTABILITY)[number];

/**
 * Display-only metadata for one canonical custody proof.
 *
 * This projection deliberately does not include proof bodies, secrets, or any
 * action authority. Portfolio actions must re-read the canonical custody row
 * through their own selection and reservation owners.
 */
export interface PortfolioCustodyProofMetadata {
  readonly normalizedMint: string;
  readonly unit: BrowserCustodyProofRow["unit"];
  readonly assetKind: BrowserCustodyProofRow["assetKind"];
  readonly conditionId: string | null;
  readonly outcomeCollection: string | null;
  readonly baseAsset: BrowserCustodyProofRow["baseAsset"];
  readonly amount: number;
  readonly keysetId: string;
  readonly proofId: string;
  readonly revision: number;
  readonly selectability: PortfolioCustodyProofSelectability;
  readonly reservationOperationId: string | null;
  readonly receivedAtMs: number;
  readonly claimRecoveryPending: boolean;
}

/**
 * Read a metadata-only projection of the current wallet custody.
 *
 * The reader uses the scope/selectability/proof-id index and visits one row at
 * a time. It does not read the legacy `proofs` cache, desired assets, or
 * conditional keyset authorities. A missing canonical table is unavailable
 * authority and returns `null`; an available empty table returns `[]`.
 */
export async function readCanonicalPortfolioCustody(
  scopeId: string,
  database: BitcasterDB = db,
): Promise<readonly PortfolioCustodyProofMetadata[] | null> {
  const canonicalScopeId = decodeDurableCustodyScopeId(scopeId);
  if (database.custodyProofs === undefined) return null;

  const metadata: PortfolioCustodyProofMetadata[] = [];
  await database.transaction("r", [database.custodyProofs], async () => {
    for (const selectability of PORTFOLIO_SELECTABILITY) {
      const rows = database.custodyProofs
        .where("[scopeId+selectability+proofId]")
        .between(
          [canonicalScopeId, selectability, ""],
          [canonicalScopeId, selectability, "\uffff"],
          true,
          true,
        );
      await rows.each((rawRow) => {
        const row = decodeBrowserCustodyProofRow(rawRow);
        if (row.scopeId !== canonicalScopeId || row.selectability !== selectability) {
          throw new Error("Portfolio canonical custody proof scope or state is invalid");
        }
        metadata.push(toPortfolioCustodyProofMetadata(row));
      });
    }
  });

  metadata.sort(comparePortfolioCustodyProofMetadata);
  const adapter = new BrowserDurableCustodyAdapter(database);
  const scope = { ...decodeDurableCustodyScopeInput(canonicalScopeId), scopeId: canonicalScopeId };
  const redeemInputs = new Map<string, ReadonlySet<string>>();
  for (const row of metadata) {
    const operationId = row.reservationOperationId;
    if (row.selectability !== "locked" || operationId === null || redeemInputs.has(operationId))
      continue;
    const record = await adapter.readOperation(scope, operationId);
    redeemInputs.set(
      operationId,
      new Set(
        record?.operation.semanticKind === "ctf-redeem" &&
          record.operation.result.state !== "applied"
          ? record.operation.reservation.inputs.map(({ proofId }) => proofId)
          : [],
      ),
    );
  }
  return metadata.map((row) => ({
    ...row,
    claimRecoveryPending:
      row.reservationOperationId !== null &&
      (redeemInputs.get(row.reservationOperationId)?.has(row.proofId) ?? false),
  }));
}

function toPortfolioCustodyProofMetadata(
  row: BrowserCustodyProofRow,
): PortfolioCustodyProofMetadata {
  if (row.selectability === "spent") {
    throw new Error("spent canonical custody proof cannot enter Portfolio projection");
  }
  return {
    normalizedMint: row.normalizedMint,
    unit: row.unit,
    assetKind: row.assetKind,
    conditionId: row.conditionId,
    outcomeCollection: row.outcomeCollection,
    baseAsset: row.baseAsset,
    amount: row.amount,
    keysetId: row.keysetId,
    proofId: row.proofId,
    revision: row.revision,
    selectability: row.selectability,
    reservationOperationId: row.reservationOperationId,
    receivedAtMs: row.receivedAtMs,
    claimRecoveryPending: false,
  };
}

function comparePortfolioCustodyProofMetadata(
  left: PortfolioCustodyProofMetadata,
  right: PortfolioCustodyProofMetadata,
): number {
  return (
    left.normalizedMint.localeCompare(right.normalizedMint) ||
    (left.conditionId ?? "").localeCompare(right.conditionId ?? "") ||
    (left.outcomeCollection ?? "").localeCompare(right.outcomeCollection ?? "") ||
    left.baseAsset.localeCompare(right.baseAsset) ||
    left.unit.localeCompare(right.unit) ||
    left.proofId.localeCompare(right.proofId)
  );
}
