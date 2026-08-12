import type {
  DurableCustodyArtifactRow,
  DurableCustodyRecord,
  DurableCustodyScopeState,
} from "@bitcaster/client-sdk/durableCustody";
import {
  decodeCanonicalMintOrigin,
  decodeDurableCustodyScopeId,
} from "@bitcaster/client-sdk/durableCustody";
import {
  decodeDurableCustodyProofMaterialRecord,
  type DurableCustodyProofMaterialRecord,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";

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

/** Strictly decodes one authoritative browser custody proof row. */
export function decodeBrowserCustodyProofRow(value: unknown): BrowserCustodyProofRow {
  const row = proofRecord(value);
  const scopeId = decodeDurableCustodyScopeId(row.scopeId);
  const normalizedMint = decodeCanonicalMintOrigin(row.normalizedMint);
  const unit = proofUnit(row.unit);
  const asset = proofAsset(row, unit);
  const material = decodeDurableCustodyProofMaterialRecord({
    scopeId,
    normalizedMint,
    unit,
    proofId: proofText(row.proofId),
    keysetId: proofText(row.keysetId),
    amount: positiveInteger(row.amount),
    proofBody: proofBytes(row.proofBody),
    proofFingerprint: proofText(row.proofFingerprint),
    curve: proofCurve(row.curve),
    dleqPresence: proofDleqPresence(row.dleqPresence),
  }).record;
  const selectability = proofSelectability(row.selectability);
  const reservationOperationId =
    row.reservationOperationId === null ? null : proofText(row.reservationOperationId);
  if (
    (selectability === "locked") !== (reservationOperationId !== null) ||
    row.baseAsset !== "sat"
  ) {
    throw new Error("browser custody proof row is invalid");
  }
  return {
    scopeId,
    normalizedMint,
    unit,
    ...asset,
    baseAsset: "sat",
    ...material,
    revision: nonnegativeInteger(row.revision),
    selectability,
    reservationOperationId,
    receivedAtMs: nonnegativeInteger(row.receivedAtMs),
  };
}

function proofRecord(value: unknown): Record<string, unknown> {
  const fields =
    "amount,assetKind,baseAsset,conditionId,curve,dleqPresence,keysetId,normalizedMint,outcomeCollection,proofBody,proofFingerprint,proofId,receivedAtMs,reservationOperationId,revision,scopeId,selectability,unit";
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== fields
  ) {
    throw new Error("browser custody proof row is invalid");
  }
  return value as Record<string, unknown>;
}

function proofAsset(row: Record<string, unknown>, unit: BrowserCustodyProofUnit) {
  if (row.assetKind === "regular" && row.conditionId === null && row.outcomeCollection === null) {
    return { assetKind: "regular" as const, conditionId: null, outcomeCollection: null };
  }
  if (
    row.assetKind === "conditional" &&
    unit === "msat" &&
    typeof row.conditionId === "string" &&
    row.conditionId.length > 0 &&
    typeof row.outcomeCollection === "string" &&
    row.outcomeCollection.length > 0
  ) {
    return {
      assetKind: "conditional" as const,
      conditionId: row.conditionId,
      outcomeCollection: row.outcomeCollection,
    };
  }
  throw new Error("browser custody proof row is invalid");
}

function proofUnit(value: unknown): BrowserCustodyProofUnit {
  if (value === "sat" || value === "msat") return value;
  throw new Error("browser custody proof row is invalid");
}

function proofSelectability(value: unknown): BrowserCustodyProofSelectability {
  if (value === "selectable" || value === "locked" || value === "spent") return value;
  throw new Error("browser custody proof row is invalid");
}

function proofCurve(value: unknown): "secp256k1" | "bls12-381" {
  if (value === "secp256k1" || value === "bls12-381") return value;
  throw new Error("browser custody proof row is invalid");
}

function proofDleqPresence(value: unknown): "not-present" | "present" {
  if (value === "not-present" || value === "present") return value;
  throw new Error("browser custody proof row is invalid");
}

function proofText(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 * 1024) {
    throw new Error("browser custody proof row is invalid");
  }
  return value;
}

function proofBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) {
    throw new Error("browser custody proof row is invalid");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const integer = nonnegativeInteger(value);
  if (integer < 1) throw new Error("browser custody proof row is invalid");
  return integer;
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("browser custody proof row is invalid");
  }
  return value as number;
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
  readonly finalExpiryUnixSeconds: number | null;
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
  const finalExpiryUnixSeconds =
    row.finalExpiryUnixSeconds === null ? null : positiveInteger(row.finalExpiryUnixSeconds);
  if (
    (finalExpiryUnixSeconds !== null && finalExpiryUnixSeconds <= registeredAtUnixSeconds) ||
    integer("inputFeePpk") > 2_147_483_647
  )
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
