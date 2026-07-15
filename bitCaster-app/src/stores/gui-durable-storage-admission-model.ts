import {
  DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
  createDurablePreTradeStorageCapacityProfile,
  decodeDurableStorageAccountingState,
  type DurablePreTradeStorageCapacityProfile,
  type DurableStorageAccountingState,
} from "@bitcaster/client-sdk/durableStorageAdmission";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { requireFixedFullSpanUint8Array } from "./gui-durable-storage-binary";
import { GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS } from "./gui-durable-storage-artifacts";

export const GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID =
  "durable-storage-origin-accounting" as const;
export const GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID =
  "durable-storage-emergency-headroom" as const;
export const GUI_DURABLE_STORAGE_ACCOUNTING_LIMIT_BYTES = 64 * 1_024 * 1_024;
const GUI_DURABLE_STORAGE_HEADROOM_SCHEMA_VERSION = 1 as const;
const RANDOM_FILL_CHUNK_BYTES = 65_536;
export const GUI_PRE_TRADE_STORAGE_CAPACITY_PROFILE_ID =
  "gui-pre-trade-v1" as const;
const GUI_PRE_TRADE_STORAGE_CAPACITY = {
  tradeIntent: {
    artifactCount: 1,
    bytes: GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.swapIntents,
  },
  session: {
    artifactCount: 1,
    bytes: GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.swapSessions,
  },
  exactOperations: {
    artifactCount: 8,
    bytes: 8 * GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.proofOperations,
  },
  proofReferences: {
    artifactCount: 256,
    bytes: 256 * GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.proofs,
  },
  privateMaterial: { artifactCount: 8, bytes: 256 * 1_024 },
  ciphers: { artifactCount: 8, bytes: 2 * 1_024 * 1_024 },
  transitionOverhead: { artifactCount: 512, bytes: 512 * 1_024 },
} as const;

export interface GuiDurableStorageAccountingRow {
  recordId: typeof GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID;
  state: DurableStorageAccountingState;
}

export interface GuiDurableStorageHeadroomRow {
  schemaVersion: typeof GUI_DURABLE_STORAGE_HEADROOM_SCHEMA_VERSION;
  recordId: typeof GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID;
  targetBytes: typeof DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES;
  sha256: string;
  payload: Uint8Array;
}

export function durableStorageAccountingRow(
  state: DurableStorageAccountingState,
): GuiDurableStorageAccountingRow {
  const decoded = decodeDurableStorageAccountingState(state);
  if (
    decoded.accountingLimitBytes !== GUI_DURABLE_STORAGE_ACCOUNTING_LIMIT_BYTES
  ) {
    throw new Error("GUI durable storage accounting limit is invalid");
  }
  assertGuiAccountingCapacityProfiles(decoded);
  return {
    recordId: GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
    state: decoded,
  };
}

function assertGuiAccountingCapacityProfiles(
  state: DurableStorageAccountingState,
): void {
  for (const reservation of state.preTradeReservations) {
    assertGuiPreTradeStorageCapacityProfile(reservation.capacityProfile);
  }
  for (const reservation of state.reservations) {
    if (reservation.capacityProfile !== null) {
      assertGuiPreTradeStorageCapacityProfile(reservation.capacityProfile);
    }
  }
}

export function createGuiPreTradeStorageCapacityProfile(): DurablePreTradeStorageCapacityProfile {
  return createDurablePreTradeStorageCapacityProfile({
    profileId: GUI_PRE_TRADE_STORAGE_CAPACITY_PROFILE_ID,
    ...GUI_PRE_TRADE_STORAGE_CAPACITY,
  });
}

export function assertGuiPreTradeStorageCapacityProfile(
  profile: DurablePreTradeStorageCapacityProfile,
): void {
  if (
    profile.profileId !== GUI_PRE_TRADE_STORAGE_CAPACITY_PROFILE_ID ||
    !Object.entries(GUI_PRE_TRADE_STORAGE_CAPACITY).every(
      ([name, expected]) => {
        const actual =
          profile[name as keyof typeof GUI_PRE_TRADE_STORAGE_CAPACITY];
        return (
          actual.artifactCount === expected.artifactCount &&
          actual.bytes === expected.bytes
        );
      },
    )
  ) {
    throw new Error("GUI pre-trade storage capacity profile is invalid");
  }
}

export function decodeDurableStorageAccountingRow(
  value: unknown,
): GuiDurableStorageAccountingRow {
  const row = requireRecord(value, "GUI durable storage accounting row");
  requireFields(row, ["recordId", "state"]);
  if (row.recordId !== GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID) {
    throw new Error("GUI durable storage accounting row id is invalid");
  }
  return durableStorageAccountingRow(
    decodeDurableStorageAccountingState(row.state),
  );
}

export function createDurableStorageHeadroomRow(): GuiDurableStorageHeadroomRow {
  const payload = randomHeadroomBytes();
  return {
    schemaVersion: GUI_DURABLE_STORAGE_HEADROOM_SCHEMA_VERSION,
    recordId: GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID,
    targetBytes: DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
    sha256: bytesToHex(sha256(payload)),
    payload,
  };
}

export function decodeDurableStorageHeadroomRow(
  value: unknown,
): GuiDurableStorageHeadroomRow {
  const row = requireRecord(value, "GUI durable storage headroom row");
  requireFields(row, [
    "schemaVersion",
    "recordId",
    "targetBytes",
    "sha256",
    "payload",
  ]);
  let payload: Uint8Array;
  try {
    payload = requireFixedFullSpanUint8Array(
      row.payload,
      "GUI durable storage headroom payload",
      DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
    );
  } catch {
    throw new Error("GUI durable storage headroom row is invalid");
  }
  if (
    row.schemaVersion !== GUI_DURABLE_STORAGE_HEADROOM_SCHEMA_VERSION ||
    row.recordId !== GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID ||
    row.targetBytes !== DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES ||
    payload.byteLength !== DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES ||
    typeof row.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.sha256) ||
    bytesToHex(sha256(payload)) !== row.sha256
  ) {
    throw new Error("GUI durable storage headroom row is invalid");
  }
  return { ...row, payload } as GuiDurableStorageHeadroomRow;
}

function randomHeadroomBytes(): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random storage headroom generation is unavailable");
  }
  const payload = new Uint8Array(
    DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
  );
  for (
    let offset = 0;
    offset < payload.byteLength;
    offset += RANDOM_FILL_CHUNK_BYTES
  ) {
    globalThis.crypto.getRandomValues(
      payload.subarray(offset, offset + RANDOM_FILL_CHUNK_BYTES),
    );
  }
  return payload;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`GUI durable storage row is missing '${field}'`);
    }
  }
  if (Object.keys(value).some((field) => !fields.includes(field))) {
    throw new Error("GUI durable storage row has an unknown field");
  }
}
