import type {
  DurableCustodyArtifactRow,
  DurableCustodyRecord,
  DurableCustodyScopeState,
} from "@bitcaster/client-sdk/durableCustody";
import { decodeDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import type { DurableCustodyProofMaterialRecord } from "@bitcaster/client-sdk/durableCustodyProofMaterial";

export type BrowserCustodyProofUnit = "sat" | "msat";
export type BrowserCustodyProofSelectability = "selectable" | "locked" | "spent";

export interface BrowserCustodyScopeRow {
  scopeId: string;
  state: DurableCustodyScopeState;
}

export interface BrowserCustodyOperationRow {
  scopeId: string;
  operationId: string;
  revision: number;
  operationState: DurableCustodyRecord["operation"]["state"];
  nextAttemptAtMs: number | null;
  estimatedBytes: number;
  record: DurableCustodyRecord;
}

export interface BrowserCustodyArtifactRow extends DurableCustodyArtifactRow {
  scopeId: string;
  operationId: string;
  artifactId: string;
}

export interface BrowserCustodyProofRow extends DurableCustodyProofMaterialRecord {
  scopeId: string;
  normalizedMint: string;
  unit: BrowserCustodyProofUnit;
  assetKind: "regular" | "conditional";
  conditionId: string | null;
  outcomeCollection: string | null;
  baseAsset: "sat";
  revision: number;
  selectability: BrowserCustodyProofSelectability;
  reservationOperationId: string | null;
  receivedAtMs: number;
}

/** Exact verified NUT-CTF keyset facts for one conditional proof admission. */
export interface BrowserCustodyConditionalKeysetAuthority {
  readonly schemaVersion: 1;
  readonly normalizedMint: string;
  readonly unit: BrowserCustodyProofUnit;
  readonly keysetId: string;
  readonly denominationPublicKeys: Readonly<Record<string, string>>;
  readonly inputFeePpk: number;
  readonly conditionId: string;
  readonly outcomeCollection: string;
  readonly outcomeCollectionId: string;
  readonly registeredAtUnixSeconds: number;
  readonly finalExpiryUnixSeconds: number;
  readonly curve: "secp256k1";
}

export interface BrowserCustodyConditionalKeysetRow extends BrowserCustodyConditionalKeysetAuthority {
  readonly scopeId: string;
}

export function decodeBrowserCustodyConditionalKeysetRow(
  value: unknown,
): BrowserCustodyConditionalKeysetRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("browser conditional keyset row is invalid");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 13 || !("scopeId" in row)) {
    throw new Error("browser conditional keyset row is invalid");
  }
  const { scopeId, ...authority } = row;
  return {
    scopeId: decodeDurableCustodyScopeId(scopeId),
    ...decodeBrowserCustodyConditionalKeysetAuthority(authority),
  };
}

export function decodeBrowserCustodyConditionalKeysetAuthority(
  value: unknown,
): BrowserCustodyConditionalKeysetAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("browser conditional keyset authority is invalid");
  }
  const row = value as Record<string, unknown>;
  const fields = [
    "schemaVersion",
    "normalizedMint",
    "unit",
    "keysetId",
    "denominationPublicKeys",
    "inputFeePpk",
    "conditionId",
    "outcomeCollection",
    "outcomeCollectionId",
    "registeredAtUnixSeconds",
    "finalExpiryUnixSeconds",
    "curve",
  ];
  if (
    row.schemaVersion !== 1 ||
    Object.keys(row).length !== fields.length ||
    fields.some((field) => !(field in row))
  ) {
    throw new Error("browser conditional keyset authority is invalid");
  }
  const text = (field: string, max = 512) => {
    const item = row[field];
    if (typeof item !== "string" || item.length < 1 || item.length > max)
      throw new Error("browser conditional keyset authority is invalid");
    return item;
  };
  if (row.unit !== "sat" && row.unit !== "msat")
    throw new Error("browser conditional keyset authority is invalid");
  if (row.curve !== "secp256k1" || !/^01[0-9a-f]{64}$/.test(text("keysetId", 66)))
    throw new Error("browser conditional keyset authority is invalid");
  if (
    !/^[0-9a-f]{64}$/.test(text("conditionId", 64)) ||
    !/^[0-9a-f]{64}$/.test(text("outcomeCollectionId", 64))
  )
    throw new Error("browser conditional keyset authority is invalid");
  const integer = (field: string) => {
    const item = row[field];
    if (!Number.isSafeInteger(item) || (item as number) < 0)
      throw new Error("browser conditional keyset authority is invalid");
    return item as number;
  };
  const keys = row.denominationPublicKeys;
  if (
    typeof keys !== "object" ||
    keys === null ||
    Array.isArray(keys) ||
    Object.keys(keys).length < 1 ||
    Object.keys(keys).length > 64
  )
    throw new Error("browser conditional keyset authority is invalid");
  const denominationPublicKeys: Record<string, string> = {};
  for (const [amount, key] of Object.entries(keys)) {
    if (
      !/^[1-9][0-9]{0,19}$/.test(amount) ||
      typeof key !== "string" ||
      !/^(?:02|03)[0-9a-f]{64}$/.test(key)
    )
      throw new Error("browser conditional keyset authority is invalid");
    denominationPublicKeys[amount] = key;
  }
  const registeredAtUnixSeconds = integer("registeredAtUnixSeconds");
  const finalExpiryUnixSeconds = integer("finalExpiryUnixSeconds");
  if (finalExpiryUnixSeconds <= registeredAtUnixSeconds || integer("inputFeePpk") > 2_147_483_647)
    throw new Error("browser conditional keyset authority is invalid");
  return {
    schemaVersion: 1,
    normalizedMint: text("normalizedMint"),
    unit: row.unit,
    keysetId: text("keysetId", 66),
    denominationPublicKeys,
    inputFeePpk: integer("inputFeePpk"),
    conditionId: text("conditionId", 64),
    outcomeCollection: text("outcomeCollection"),
    outcomeCollectionId: text("outcomeCollectionId", 64),
    registeredAtUnixSeconds,
    finalExpiryUnixSeconds,
    curve: "secp256k1",
  };
}

export interface BrowserCustodyReservationRow {
  scopeId: string;
  proofId: string;
  operationId: string;
  reservationId: string;
  inputPosition: number;
}

export interface BrowserCustodyActiveWorkRow {
  scopeId: string;
  operationId: string;
  nextAttemptAtMs: number;
  estimatedBytes: number;
}
