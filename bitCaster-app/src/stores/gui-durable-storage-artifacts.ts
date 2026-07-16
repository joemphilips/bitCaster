import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Amount } from "@cashu/cashu-ts";
import {
  DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX,
  createDurableStorageJsonArtifact,
  type DurableStorageArtifactReleaseAction,
  type DurableStorageArtifactRole,
  type DurableStoragePlannedArtifact,
} from "@bitcaster/client-sdk/durableStorageAdmission";
import {
  requireFixedArrayBuffer,
  requireFixedFullSpanUint8Array,
} from "./gui-durable-storage-binary";

const GUI_DEXIE_ARTIFACT_PREFIX = "gui-dexie:v1";
const ARTIFACT_NODE_LIMIT = 4_096;
const ARTIFACT_DEPTH_LIMIT = 64;
const ARTIFACT_KEY_BYTES_LIMIT = 1_024;
const ARTIFACT_STRING_CODE_UNITS_LIMIT =
  DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX;
const ARTIFACT_BIGINT_DECIMAL_DIGITS_LIMIT = 128;

export type GuiDurableStorageArtifactTable =
  | "swapSessions"
  | "swapIntents"
  | "pendingTrades"
  | "proofOperations"
  | "walletSendDeliveryPayloads"
  | "bearerSpendDeliveries"
  | "outgoingRecipientDeliveries"
  | "proofs"
  | "custodyScopes"
  | "custodyScopeStates"
  | "custodyOperations"
  | "custodySessionLinks"
  | "custodyProofReservations"
  | "walletCounters";

export type GuiDurableStorageArtifactKey = string | readonly [string, string];

export const GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS = {
  swapSessions: 128 * 1_024,
  swapIntents: 64 * 1_024,
  pendingTrades: 1 * 1_024 * 1_024,
  proofOperations: 256 * 1_024,
  walletSendDeliveryPayloads: 2 * 1_024 * 1_024,
  bearerSpendDeliveries: 8 * 1_024 * 1_024,
  outgoingRecipientDeliveries: 256 * 1_024,
  proofs: 8 * 1_024,
  custodyScopes: 4 * 1_024,
  custodyScopeStates: 16 * 1_024,
  custodyOperations: 16 * 1_024,
  custodySessionLinks: 4 * 1_024,
  custodyProofReservations: 1 * 1_024,
  walletCounters: 4 * 1_024,
} as const satisfies Record<GuiDurableStorageArtifactTable, number>;

export interface GuiDurableStoragePlannedRow {
  table: GuiDurableStorageArtifactTable;
  key: GuiDurableStorageArtifactKey;
  artifactRole: DurableStorageArtifactRole;
  row: unknown;
}

export function createGuiDurableStorageRowArtifact(
  input: GuiDurableStoragePlannedRow,
): Extract<DurableStoragePlannedArtifact, { encoding: "json-utf8" }> {
  assertTableRole(input.table, input.artifactRole);
  const artifactId = guiDurableStorageArtifactId(input.table, input.key);
  const artifact = createDurableStorageJsonArtifact({
    artifactId,
    artifactRole: input.artifactRole,
    value: encodeArtifactValue(input.row),
  });
  if (
    new TextEncoder().encode(artifact.encodedJson).byteLength >
    GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS[input.table]
  ) {
    throw new Error("GUI Dexie artifact exceeds its physical row limit");
  }
  return artifact;
}

export function assertGuiDurableStoragePlannedArtifact(
  artifact: DurableStoragePlannedArtifact,
): void {
  if (artifact.encoding !== "json-utf8") {
    throw new Error("GUI Dexie physical artifacts must use canonical JSON");
  }
  const table = tableFromArtifactId(artifact.artifactId);
  assertTableRole(table, artifact.artifactRole);
  assertPhysicalRowByteLimit(table, artifact.encodedJson);
}

export function assertGuiDurableStorageReleaseAction(
  action: DurableStorageArtifactReleaseAction,
): void {
  const table = tableFromArtifactId(action.artifactId);
  assertTableRole(table, action.artifactRole);
  if (action.artifactRole === "transaction-only-retained") {
    throw new Error("Transaction-only Dexie artifacts cannot be released");
  }
  const expected = retainedRole(action.artifactRole) ? "retain" : "delete";
  if (action.action !== expected) {
    throw new Error("GUI Dexie artifact release action is invalid");
  }
}

export function guiDurableStorageArtifactId(
  table: GuiDurableStorageArtifactTable,
  key: GuiDurableStorageArtifactKey,
): string {
  assertTableKey(table, key);
  const encodedKey = JSON.stringify(encodeArtifactValue(key));
  const digest = bytesToHex(sha256(new TextEncoder().encode(encodedKey)));
  return `${GUI_DEXIE_ARTIFACT_PREFIX}:${table}:${digest}`;
}

function tableFromArtifactId(
  artifactId: string,
): GuiDurableStorageArtifactTable {
  const match = /^gui-dexie:v1:([A-Za-z]+):([0-9a-f]{64})$/.exec(artifactId);
  if (!match) throw new Error("GUI Dexie artifact id is invalid");
  const table = match[1];
  if (!isArtifactTable(table)) {
    throw new Error("GUI Dexie artifact table is invalid");
  }
  return table;
}

function assertTableRole(
  table: GuiDurableStorageArtifactTable,
  role: DurableStorageArtifactRole,
): void {
  const allowed = TABLE_ROLES[table];
  if (!allowed.includes(role)) {
    throw new Error("GUI Dexie artifact role is invalid for its table");
  }
}

function assertPhysicalRowByteLimit(
  table: GuiDurableStorageArtifactTable,
  encodedJson: string,
): void {
  if (
    new TextEncoder().encode(encodedJson).byteLength >
    GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS[table]
  ) {
    throw new Error("GUI Dexie artifact exceeds its physical row limit");
  }
}

function assertTableKey(
  table: GuiDurableStorageArtifactTable,
  key: GuiDurableStorageArtifactKey,
): void {
  const requiresTuple =
    table === "proofOperations" ||
    table === "walletSendDeliveryPayloads" ||
    table === "bearerSpendDeliveries" ||
    table === "outgoingRecipientDeliveries" ||
    table === "walletCounters" ||
    table === "pendingTrades";
  const validTuple =
    Array.isArray(key) &&
    key.length === 2 &&
    Object.hasOwn(key, 0) &&
    Object.hasOwn(key, 1) &&
    validArtifactKeyPart(key[0]) &&
    validArtifactKeyPart(key[1]);
  const validString = validArtifactKeyPart(key);
  if ((requiresTuple && !validTuple) || (!requiresTuple && !validString)) {
    throw new Error("GUI Dexie artifact key is invalid for its table");
  }
}

const TABLE_ROLES: Record<
  GuiDurableStorageArtifactTable,
  readonly DurableStorageArtifactRole[]
> = {
  swapSessions: ["trade-session"],
  swapIntents: ["trade-intent"],
  pendingTrades: ["transaction-only-retained"],
  proofOperations: ["exact-operation"],
  walletSendDeliveryPayloads: ["private-material"],
  bearerSpendDeliveries: ["private-material"],
  outgoingRecipientDeliveries: ["operation-overhead"],
  proofs: ["proof-post-image", "transaction-only-retained"],
  custodyScopes: ["transaction-only-retained"],
  custodyScopeStates: ["transaction-only-retained"],
  custodyOperations: ["operation-overhead"],
  custodySessionLinks: ["operation-overhead"],
  custodyProofReservations: ["operation-overhead"],
  walletCounters: ["transaction-only-retained"],
};

function isArtifactTable(
  value: string,
): value is GuiDurableStorageArtifactTable {
  return Object.hasOwn(TABLE_ROLES, value);
}

function retainedRole(role: DurableStorageArtifactRole): boolean {
  return role === "proof-post-image";
}

function encodeArtifactValue(value: unknown): unknown {
  const budget = { nodes: 0 };
  return encodeArtifactNode(value, 0, budget);
}

function encodeArtifactNode(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): unknown {
  budget.nodes += 1;
  if (budget.nodes > ARTIFACT_NODE_LIMIT || depth > ARTIFACT_DEPTH_LIMIT) {
    throw new Error("GUI Dexie artifact structure exceeds the limit");
  }
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (typeof value === "string") {
    requireBoundedString(value, "GUI Dexie artifact string");
    return { type: "string", value };
  }
  if (typeof value === "boolean") {
    return { type: typeof value, value };
  }
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "bigint") {
    return encodeBigInt(value);
  }
  if (value instanceof Amount) {
    return encodeArtifactNode({ value: value.toBigInt() }, depth, budget);
  }
  if (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  ) {
    const bytes = requireFixedFullSpanUint8Array(
      value,
      "GUI Dexie artifact Uint8Array",
      DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX,
    );
    return { type: "uint8array", value: bytesToHex(bytes) };
  }
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    const buffer = requireFixedArrayBuffer(
      value,
      "GUI Dexie artifact ArrayBuffer",
      DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX,
    );
    return { type: "arraybuffer", value: bytesToHex(new Uint8Array(buffer)) };
  }
  if (Array.isArray(value)) {
    return encodeArtifactArray(value, depth, budget);
  }
  return encodeArtifactObject(value, depth, budget);
}

function encodeBigInt(value: bigint): unknown {
  const encoded = value.toString(10);
  const digits = encoded.startsWith("-") ? encoded.length - 1 : encoded.length;
  if (digits > ARTIFACT_BIGINT_DECIMAL_DIGITS_LIMIT) {
    throw new Error("GUI Dexie artifact bigint exceeds the limit");
  }
  return { type: "bigint", value: encoded };
}

function encodeNumber(value: number): unknown {
  if (!Number.isFinite(value)) {
    throw new Error("GUI Dexie artifact number is invalid");
  }
  if (Object.is(value, -0)) return { type: "number", value: "-0" };
  return { type: "number", value: value.toString() };
}

function encodeArtifactObject(
  value: object,
  depth: number,
  budget: { nodes: number },
): unknown {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("GUI Dexie artifact object is invalid");
  }
  const keys = requirePlainDataKeys(value);
  if (keys.length > ARTIFACT_NODE_LIMIT - budget.nodes) {
    throw new Error("GUI Dexie artifact structure exceeds the limit");
  }
  keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    requireBoundedString(
      key,
      "GUI Dexie artifact object key",
      ARTIFACT_KEY_BYTES_LIMIT,
    );
    entries.push([
      key,
      encodeArtifactNode(
        (value as Record<string, unknown>)[key],
        depth + 1,
        budget,
      ),
    ]);
  }
  return { type: "object", value: entries };
}

function encodeArtifactArray(
  value: unknown[],
  depth: number,
  budget: { nodes: number },
): unknown {
  if (value.length > ARTIFACT_NODE_LIMIT - budget.nodes) {
    throw new Error("GUI Dexie artifact structure exceeds the limit");
  }
  const encoded: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error("GUI Dexie artifact arrays must not be sparse");
    }
    encoded.push(encodeArtifactNode(value[index], depth + 1, budget));
  }
  if (Object.keys(value).length !== value.length) {
    throw new Error("GUI Dexie artifact array has an extra property");
  }
  return { type: "array", value: encoded };
}

function requirePlainDataKeys(value: object): string[] {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error("GUI Dexie artifact object has a symbol property");
  }
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  if (names.length !== keys.length) {
    throw new Error("GUI Dexie artifact object has a hidden property");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("GUI Dexie artifact object property is invalid");
    }
  }
  return keys;
}

function validArtifactKeyPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ARTIFACT_KEY_BYTES_LIMIT &&
    new TextEncoder().encode(value).byteLength <= ARTIFACT_KEY_BYTES_LIMIT
  );
}

function requireBoundedString(
  value: string,
  name: string,
  maximumCodeUnits = ARTIFACT_STRING_CODE_UNITS_LIMIT,
): void {
  if (value.length > maximumCodeUnits) {
    throw new Error(`${name} exceeds the limit`);
  }
}
