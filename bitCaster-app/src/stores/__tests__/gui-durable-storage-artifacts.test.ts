import { describe, expect, it } from "vitest";
import type {
  DurableStorageArtifactReleaseAction,
  DurableStoragePlannedArtifact,
} from "@bitcaster/client-sdk/durableStorageAdmission";
import {
  DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX,
  createDurableStorageJsonArtifact,
} from "@bitcaster/client-sdk/durableStorageAdmission";
import {
  GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS,
  assertGuiDurableStoragePlannedArtifact,
  assertGuiDurableStorageReleaseAction,
  createGuiDurableStorageRowArtifact,
  guiDurableStorageArtifactId,
} from "../gui-durable-storage-artifacts";

describe("GUI durable-storage artifacts", () => {
  it("commits deterministic tagged rows independent of object key order", () => {
    const first = rowArtifact({
      walletId: "wallet-a",
      payload: { amount: 1, active: true },
    });
    const reordered = rowArtifact({
      payload: { active: true, amount: 1 },
      walletId: "wallet-a",
    });

    expect(first).toEqual(reordered);
    expect(first.artifactId).toBe(
      guiDurableStorageArtifactId("proofs", "proof-a"),
    );
  });

  it("distinguishes binary classes, undefined fields, and omitted fields", () => {
    const typed = rowArtifact({ value: new Uint8Array([1, 2]) });
    const buffer = rowArtifact({ value: new Uint8Array([1, 2]).buffer });
    const plain = rowArtifact({ value: { 0: 1, 1: 2 } });
    const presentUndefined = rowArtifact({ value: undefined });
    const omitted = rowArtifact({});

    expect(encodedJson(typed)).not.toBe(encodedJson(buffer));
    expect(encodedJson(typed)).not.toBe(encodedJson(plain));
    expect(encodedJson(presentUndefined)).not.toBe(encodedJson(omitted));
  });

  it("rejects hidden binary backing storage and oversized structures before encoding", () => {
    const backing = new ArrayBuffer(32);
    expect(() => rowArtifact({ value: new Uint8Array(backing, 8, 1) })).toThrow(
      "full backing buffer",
    );
    expect(() =>
      rowArtifact({
        value: new Uint8Array(DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX + 1),
      }),
    ).toThrow("exceeds the byte limit");
    expect(() => rowArtifact(new Array(4_097).fill(undefined))).toThrow(
      "structure exceeds the limit",
    );
    const sparse = new Array(2);
    sparse[0] = "wallet-a";
    expect(() =>
      guiDurableStorageArtifactId(
        "proofOperations",
        sparse as [string, string],
      ),
    ).toThrow("key is invalid");
  });

  it("uses native binary brands and bounds bigint values", () => {
    const fakeBuffer = Object.create(null);
    Object.defineProperty(fakeBuffer, Symbol.toStringTag, {
      value: "ArrayBuffer",
    });
    expect(() => rowArtifact({ value: fakeBuffer })).toThrow(
      "must be an ArrayBuffer",
    );

    const spoofedView = new Uint16Array([1]);
    Object.defineProperty(spoofedView, Symbol.toStringTag, {
      value: "Uint8Array",
    });
    expect(() => rowArtifact({ value: spoofedView })).toThrow();
    expect(() => rowArtifact({ value: 1n })).not.toThrow();
    expect(() => rowArtifact({ value: 10n ** 128n })).toThrow(
      "bigint exceeds the limit",
    );
  });

  it("enforces the named physical limit for each Dexie table", () => {
    expect(() =>
      rowArtifact({
        payload: "x".repeat(GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.proofs),
      }),
    ).toThrow("exceeds its physical row limit");
    expect(() =>
      createGuiDurableStorageRowArtifact({
        table: "custodyProofReservations",
        key: "proof-a",
        artifactRole: "operation-overhead",
        row: {
          payload: "x".repeat(
            GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.custodyProofReservations,
          ),
        },
      }),
    ).toThrow("exceeds its physical row limit");
  });

  it("rejects a generic SDK artifact that exceeds its named Dexie table limit", () => {
    const artifact = createDurableStorageJsonArtifact({
      artifactId: guiDurableStorageArtifactId("proofOperations", [
        "wallet-a",
        "operation-a",
      ]),
      artifactRole: "exact-operation",
      value: "x".repeat(
        GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.proofOperations,
      ),
    });

    expect(() => assertGuiDurableStoragePlannedArtifact(artifact)).toThrow(
      "exceeds its physical row limit",
    );
  });

  it("enforces the closed physical table, key, and role mapping", () => {
    expect(() =>
      createGuiDurableStorageRowArtifact({
        table: "proofs",
        key: "proof-a",
        artifactRole: "operation-overhead",
        row: { proofId: "proof-a" },
      }),
    ).toThrow("role is invalid");
    expect(() =>
      guiDurableStorageArtifactId("proofOperations", "operation-a"),
    ).toThrow("key is invalid");
    expect(() =>
      guiDurableStorageArtifactId("proofs", ["wallet-a", "proof-a"]),
    ).toThrow("key is invalid");

    expect(() =>
      assertGuiDurableStoragePlannedArtifact(
        plannedArtifact(
          guiDurableStorageArtifactId("proofs", "proof-a"),
          "operation-overhead",
        ),
      ),
    ).toThrow("role is invalid");
    expect(() =>
      assertGuiDurableStoragePlannedArtifact(
        plannedArtifact("gui-dexie:v1:unknown:" + "a".repeat(64), "cipher"),
      ),
    ).toThrow("table is invalid");
    expect(() =>
      assertGuiDurableStoragePlannedArtifact({
        artifactId: guiDurableStorageArtifactId("proofs", "proof-a"),
        artifactRole: "proof-post-image",
        encoding: "binary",
        bytes: new Uint8Array([1]),
      }),
    ).toThrow("must use canonical JSON");
  });

  it("accepts only SDK-compatible physical release actions", () => {
    expect(() =>
      assertGuiDurableStorageReleaseAction(
        releaseAction("proofs", "proof-a", "proof-post-image", "retain"),
      ),
    ).not.toThrow();
    expect(() =>
      assertGuiDurableStorageReleaseAction(
        releaseAction(
          "custodyOperations",
          "operation-a",
          "operation-overhead",
          "delete",
        ),
      ),
    ).not.toThrow();
    expect(() =>
      assertGuiDurableStorageReleaseAction(
        releaseAction("proofs", "proof-a", "proof-post-image", "delete"),
      ),
    ).toThrow("release action is invalid");
    expect(() =>
      assertGuiDurableStorageReleaseAction(
        releaseAction(
          "custodyOperations",
          "operation-a",
          "operation-overhead",
          "retain",
        ),
      ),
    ).toThrow("release action is invalid");
    expect(() =>
      assertGuiDurableStorageReleaseAction(
        releaseAction(
          "custodyScopeStates",
          "scope-a",
          "transaction-only-retained",
          "retain",
        ),
      ),
    ).toThrow("cannot be released");
    expect(() =>
      assertGuiDurableStorageReleaseAction(
        releaseAction(
          "custodyScopes",
          "scope-a",
          "transaction-only-retained",
          "retain",
        ),
      ),
    ).toThrow("cannot be released");
  });
});

function rowArtifact(row: unknown) {
  return createGuiDurableStorageRowArtifact({
    table: "proofs",
    key: "proof-a",
    artifactRole: "proof-post-image",
    row,
  });
}

function encodedJson(
  artifact: ReturnType<typeof createGuiDurableStorageRowArtifact>,
): string {
  return artifact.encodedJson;
}

function plannedArtifact(
  artifactId: string,
  artifactRole: DurableStoragePlannedArtifact["artifactRole"],
): DurableStoragePlannedArtifact {
  return {
    artifactId,
    artifactRole,
    encoding: "json-utf8",
    encodedJson: "{}",
  };
}

function releaseAction(
  table: Parameters<typeof guiDurableStorageArtifactId>[0],
  key: Parameters<typeof guiDurableStorageArtifactId>[1],
  artifactRole: DurableStorageArtifactReleaseAction["artifactRole"],
  action: DurableStorageArtifactReleaseAction["action"],
): DurableStorageArtifactReleaseAction {
  return {
    artifactId: guiDurableStorageArtifactId(table, key),
    artifactRole,
    action,
  };
}
