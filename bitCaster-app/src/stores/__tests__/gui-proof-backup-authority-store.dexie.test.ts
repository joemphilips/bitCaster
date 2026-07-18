import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount } from "@cashu/cashu-ts";
import {
  canonicalKeysetId,
  canonicalSecpPoint,
} from "../../test/cashu-proof-fixtures";
import {
  addProofs,
  BitcasterDB,
  configureGuiWalletIdProvider,
  db,
  getBoundedUnitProofsForAmountUnderLock,
  getConditionCtfProofs,
  getOutcomeProofs,
  getProofs,
  getReservedProofs,
  prepareStoredProofForWrite,
  removeProofs,
  replaceProofs,
  tryReserveProofs,
  type StoredProofRow,
} from "../proof-db";
import {
  commitGuiProofWithBackupAuthority as commitProofAuthorityUnderLock,
  getGuiRetainedCtfProofs,
  getGuiSelectableOutcomeProofs,
  getGuiSelectableProofsForAmount,
} from "../gui-proof-backup-authority-store";
import { withGuiWalletLock } from "../gui-wallet-lock";
import type { GuiProofBackupAuthorityRow } from "../gui-encrypted-wallet-backup-records";

const WALLET_ID = "ab".repeat(32);
const KEYSET_ID = canonicalKeysetId(1);
const PROOF_COMMITMENT = "11".repeat(32);
const CONDITION_ID = "66".repeat(32);
const COLLECTION_ID = "77".repeat(32);
const MINT_URL = "https://mint.example";
let database: BitcasterDB;

beforeEach(async () => {
  configureGuiWalletIdProvider(() => WALLET_ID);
  installImmediateWebLocks();
  db.close();
  database = new BitcasterDB();
  await database.delete();
  await database.open();
});

afterEach(async () => {
  delete (navigator as { locks?: LockManager }).locks;
  db.close();
  database.close();
  await database.delete();
});

describe("GUI proof backup authority", () => {
  it("installs only the dormant proof-authority schema with strict indexes", () => {
    expect(database.verno).toBe(22);
    expect(database.proofBackupAuthorities.schema.primKey.keyPath).toEqual([
      "walletId",
      "proofId",
    ]);
    expect(
      database.proofBackupAuthorities.schema.indexes.map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining([
        "[walletId+mintUrl+unit+spendDisposition+amount+proofId]",
        "[walletId+mintUrl+conditionId+outcomeCollection+spendDisposition+proofId]",
      ]),
    );
    expect(database.proofs.schema.indexes.map(({ name }) => name)).toContain(
      "[walletId+mintUrl+unit+proofClass+selectability+amount+proofId]",
    );
    expect(database.tables.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["backupCurrentHeads", "backupProofReceipts"]),
    );
  });

  it("clears undeployed version-21 wallet rows during schema upgrade", async () => {
    database.close();
    await database.delete();
    const legacy = new Dexie("bitcaster");
    legacy.version(21).stores({ proofs: "proofId, walletId" });
    await legacy.open();
    await legacy.table("proofs").put(ordinaryProof("legacy-row", 8));
    legacy.close();

    database = new BitcasterDB();
    await database.open();

    expect(await database.proofs.count()).toBe(0);
    expect(await database.proofBackupAuthorities.count()).toBe(0);
  });

  it("atomically stores the NUT-13 locator and selects through the typed authority index", async () => {
    const proof = ordinaryProof("ordinary", 8);
    const authority = activeAuthority(proof);

    await commitProofAuthority(
      { proof, authority, effectiveNowUnixSeconds: 100 },
      database,
    );
    await commitProofAuthority(
      { proof, authority, effectiveNowUnixSeconds: 100 },
      database,
    );

    const proofScan = vi.spyOn(database.proofs, "toArray");
    const selected = await getGuiSelectableProofsForAmount({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      unit: "sat",
      minimumAmount: 8,
      effectiveNowUnixSeconds: 100,
      limit: 16,
      database,
    });
    expect(selected.map(({ proofId }) => proofId)).toEqual([proof.proofId]);
    expect(await getProofs(MINT_URL, { includeReserved: true })).toEqual([]);
    await expect(addProofs([proof])).rejects.toThrow(
      /requires an atomic authority transition/i,
    );
    await expect(replaceProofs([], [proof])).rejects.toThrow(
      /requires an atomic authority transition/i,
    );
    expect(proofScan).not.toHaveBeenCalled();
    expect(
      await database.proofBackupAuthorities.get([WALLET_ID, proof.proofId]),
    ).toMatchObject({
      derivationLocator: {
        kind: "nut13",
        keysetId: KEYSET_ID,
        counter: 7,
      },
      spendDisposition: "active-selectable",
    });
  });

  it("never selects a proof whose one-to-one authority is missing", async () => {
    const proof = ordinaryProof("orphan", 8);
    await database.proofs.put(proof);

    const selected = await getGuiSelectableProofsForAmount({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      unit: "sat",
      minimumAmount: 1,
      effectiveNowUnixSeconds: 100,
      limit: 16,
      database,
    });

    expect(selected).toEqual([]);
    expect(await database.proofs.get(proof.proofId)).toBeDefined();
  });

  it("scans past more than 256 governed legacy rows to find an ungoverned proof", async () => {
    const governed = Array.from({ length: 257 }, (_, index) =>
      ordinaryProof(`governed-high-${index}`, 64),
    );
    const ungoverned = ordinaryProof("legacy-low", 1);
    await database.proofs.bulkPut([...governed, ungoverned]);
    await database.proofBackupAuthorities.bulkPut(
      governed.map((proof) => activeAuthority(proof)),
    );

    const selected = await withGuiWalletLock(
      WALLET_ID,
      () => WALLET_ID,
      (lock) =>
        getBoundedUnitProofsForAmountUnderLock(lock, MINT_URL, {
          unit: "sat",
          minimumAmount: 1,
        }),
    );

    expect(selected.map(({ proofId }) => proofId)).toEqual([
      ungoverned.proofId,
    ]);
  });

  it("keeps active reserved authority out of the legacy reserved selector", async () => {
    const proof = reservedOrdinaryProof("reserved-governed", 8, "operation-1");
    const authority = activeAuthority(proof, {
      spendDisposition: "active-reserved",
    });
    await commitProofAuthority(
      { proof, authority, effectiveNowUnixSeconds: 100 },
      database,
    );

    expect(await getReservedProofs("operation-1")).toEqual([]);
    expect(await database.proofs.get(proof.proofId)).toBeDefined();
  });

  it("scopes dormant authority by wallet and keeps the commitment immutable", async () => {
    const proof = ordinaryProof("wallet-scoped", 8);
    const foreignWalletId = "cd".repeat(32);
    await database.proofs.put(proof);
    await database.proofBackupAuthorities.put({
      ...activeAuthority(proof),
      walletId: foreignWalletId,
    });

    expect((await getProofs(MINT_URL)).map(({ proofId }) => proofId)).toEqual([
      proof.proofId,
    ]);
    const authority = activeAuthority(proof);
    await commitProofAuthority(
      { proof, authority, effectiveNowUnixSeconds: 100 },
      database,
    );
    const changedCommitment = "ef".repeat(32);
    await expect(
      commitProofAuthority(
        {
          proof,
          authority: activeAuthority(proof, {
            revision: 1,
            proofCommitment: changedCommitment,
            storageClassification: storageClassification(proof.proofId, {
              proofCommitment: changedCommitment,
            }),
          }),
          effectiveNowUnixSeconds: 100,
        },
        database,
      ),
    ).rejects.toThrow(/commitment is immutable/i);
  });

  it("rolls back the proof body when its locator conflicts with the output keyset", async () => {
    const proof = ordinaryProof("conflict", 8);
    const authority = activeAuthority(proof, {
      derivationLocator: { kind: "nut13", keysetId: "foreign", counter: 7 },
    });

    await expect(
      commitProofAuthority(
        { proof, authority, effectiveNowUnixSeconds: 100 },
        database,
      ),
    ).rejects.toThrow(/conflicts with proof body/i);
    expect(await database.proofs.count()).toBe(0);
    expect(await database.proofBackupAuthorities.count()).toBe(0);
  });

  it("cannot recreate authenticated remote deletion authority structurally", async () => {
    const proof = ordinaryProof("remote-authority", 8);
    const authority = activeAuthority(proof, {
      storageClassification: storageClassification(proof.proofId, {
        storageClass: "remotely-backed-deterministic-proof",
        pinReasons: [],
        backupBinding: {
          snapshotId: "aa".repeat(32),
          chunkDigest: "bb".repeat(32),
          proofCommitment: PROOF_COMMITMENT,
        },
      }),
    });

    await expect(
      commitProofAuthority(
        { proof, authority, effectiveNowUnixSeconds: 100 },
        database,
      ),
    ).rejects.toThrow(/requires an SDK store callback/i);
    expect(await database.proofs.count()).toBe(0);
  });

  it("keeps expired and verified-losing CTF proofs visible and nonselectable", async () => {
    const expired = ctfProof("expired");
    const losing = ctfProof("losing");
    await commitProofAuthority(
      {
        proof: expired,
        authority: retainedAuthority(expired, "recorded-ctf-expiry-passed"),
        effectiveNowUnixSeconds: 500,
      },
      database,
    );
    await commitProofAuthority(
      {
        proof: losing,
        authority: retainedAuthority(losing, "verified-losing-outcome"),
        effectiveNowUnixSeconds: 200,
      },
      database,
    );

    const selectable = await getGuiSelectableOutcomeProofs({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
      effectiveNowUnixSeconds: 500,
      cursor: null,
      limit: 256,
      database,
    });
    const retained = await getGuiRetainedCtfProofs({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
      effectiveNowUnixSeconds: 500,
      cursor: null,
      limit: 256,
      database,
    });

    expect(selectable).toEqual({ proofs: [], nextCursor: null });
    expect(retained.proofs.map(({ secret }) => secret).sort()).toEqual([
      "expired",
      "losing",
    ]);
    expect(await database.proofs.count()).toBe(2);
  });

  it("fails closed through every legacy CTF selector and reservation path", async () => {
    const proof = ctfProof("legacy-retained");
    await commitProofAuthority(
      {
        proof,
        authority: retainedAuthority(proof, "recorded-ctf-expiry-passed"),
        effectiveNowUnixSeconds: 500,
      },
      database,
    );

    expect(await getProofs(MINT_URL, { includeReserved: true })).toEqual([]);
    expect(
      await getOutcomeProofs(MINT_URL, CONDITION_ID, "YES", {
        includeReserved: true,
      }),
    ).toEqual([]);
    expect(
      await getConditionCtfProofs(MINT_URL, CONDITION_ID, {
        includeReserved: true,
      }),
    ).toEqual([]);
    await expect(tryReserveProofs([proof], "operation-1")).resolves.toBe(false);
    await expect(removeProofs([proof])).rejects.toThrow(
      /requires an atomic authority transition/i,
    );
    expect(await database.proofs.get(proof.proofId)).toBeDefined();
  });

  it("rejects invalid selector keys before querying IndexedDB", async () => {
    const authorityQuery = vi.spyOn(database.proofBackupAuthorities, "where");

    await expect(
      getGuiSelectableOutcomeProofs({
        walletId: WALLET_ID,
        mintUrl: MINT_URL,
        conditionId: "not-a-condition-id",
        outcomeCollection: "YES",
        effectiveNowUnixSeconds: 100,
        cursor: null,
        limit: 256,
        database,
      }),
    ).rejects.toThrow(/condition id is invalid/i);
    await expect(
      getGuiSelectableProofsForAmount({
        walletId: WALLET_ID,
        mintUrl: MINT_URL,
        unit: "invalid",
        minimumAmount: 1,
        effectiveNowUnixSeconds: 100,
        limit: 1,
        database,
      }),
    ).rejects.toThrow(/selection unit is invalid/i);
    await expect(
      getGuiSelectableOutcomeProofs({
        walletId: WALLET_ID,
        mintUrl: MINT_URL,
        conditionId: CONDITION_ID,
        outcomeCollection: "YES",
        effectiveNowUnixSeconds: 100,
        cursor: null,
        limit: 257,
        database,
      }),
    ).rejects.toThrow(/page limit is invalid/i);
    await expect(
      getGuiSelectableProofsForAmount({
        walletId: WALLET_ID,
        mintUrl: MINT_URL,
        unit: "sat",
        minimumAmount: 1,
        effectiveNowUnixSeconds: -1,
        limit: 1,
        database,
      }),
    ).rejects.toThrow(/effective time is invalid/i);
    await expect(
      getGuiSelectableOutcomeProofs({
        walletId: WALLET_ID,
        mintUrl: MINT_URL,
        conditionId: CONDITION_ID,
        outcomeCollection: "YES",
        effectiveNowUnixSeconds: -1,
        cursor: null,
        limit: 1,
        database,
      }),
    ).rejects.toThrow(/effective time is invalid/i);
    expect(authorityQuery).not.toHaveBeenCalled();
  });

  it("revalidates active CTF expiry at selection time without deleting the proof", async () => {
    const proof = ctfProof("clock-bound");
    await commitProofAuthority(
      {
        proof,
        authority: activeCtfAuthority(proof),
        effectiveNowUnixSeconds: 200,
      },
      database,
    );

    const selected = await getGuiSelectableOutcomeProofs({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
      effectiveNowUnixSeconds: 300,
      cursor: null,
      limit: 256,
      database,
    });
    const retained = await getGuiRetainedCtfProofs({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
      effectiveNowUnixSeconds: 300,
      cursor: null,
      limit: 256,
      database,
    });

    expect(selected).toEqual({ proofs: [], nextCursor: null });
    expect(retained.proofs.map(({ proofId }) => proofId)).toEqual([
      proof.proofId,
    ]);
    expect(await database.proofs.get(proof.proofId)).toBeDefined();
  });

  it("does not let expired high-value authorities consume the valid result limit", async () => {
    const expired = ctfProof("expired-before-valid", 16);
    const valid = ordinaryProof("valid-after-expired", 4);
    await commitProofAuthority(
      {
        proof: expired,
        authority: activeCtfAuthority(expired),
        effectiveNowUnixSeconds: 200,
      },
      database,
    );
    await commitProofAuthority(
      {
        proof: valid,
        authority: activeAuthority(valid),
        effectiveNowUnixSeconds: 200,
      },
      database,
    );

    const selected = await getGuiSelectableProofsForAmount({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      unit: "sat",
      minimumAmount: 4,
      effectiveNowUnixSeconds: 400,
      limit: 1,
      database,
    });

    expect(selected.map(({ proofId }) => proofId)).toEqual([valid.proofId]);
  });

  it("finds a valid proof after more than 4096 expired authorities", async () => {
    const template = activeCtfAuthority(ctfProof("expired-template", 16));
    const expiredAuthorities = Array.from({ length: 4_101 }, (_, index) =>
      syntheticAuthority(template, index),
    );
    const valid = ordinaryProof("valid-after-4096", 4);
    await commitProofAuthority(
      {
        proof: valid,
        authority: activeAuthority(valid),
        effectiveNowUnixSeconds: 200,
      },
      database,
    );
    vi.spyOn(database.proofBackupAuthorities, "where").mockReturnValue({
      between: () =>
        fakeUntilCollection([...expiredAuthorities, activeAuthority(valid)]),
    } as never);

    const selected = await getGuiSelectableProofsForAmount({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      unit: "sat",
      minimumAmount: 4,
      effectiveNowUnixSeconds: 400,
      limit: 1,
      database,
    });

    expect(selected.map(({ proofId }) => proofId)).toEqual([valid.proofId]);
  });

  it("traverses more than 256 included proof bodies with a stable cursor", async () => {
    const proofs = Array.from({ length: 300 }, (_, index) =>
      ctfProof(`cursor-page-${index}`),
    );
    await database.proofs.bulkPut(proofs);
    await database.proofBackupAuthorities.bulkPut(
      proofs.map((proof) => activeCtfAuthority(proof)),
    );
    const bulkGet = vi.spyOn(database.proofs, "bulkGet");

    const first = await getGuiSelectableOutcomeProofs({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
      effectiveNowUnixSeconds: 200,
      cursor: null,
      limit: 256,
      database,
    });
    const second = await getGuiSelectableOutcomeProofs({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
      effectiveNowUnixSeconds: 200,
      cursor: first.nextCursor,
      limit: 256,
      database,
    });

    expect(first.proofs).toHaveLength(256);
    expect(first.nextCursor).not.toBeNull();
    expect(second.proofs).toHaveLength(44);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.proofs, ...second.proofs].map(({ proofId }) => proofId),
      ),
    ).toEqual(new Set(proofs.map(({ proofId }) => proofId)));
    expect(
      bulkGet.mock.calls.every(([proofIds]) => proofIds.length <= 256),
    ).toBe(true);
  });

  it("keyset-scans 10000+ expired outcome authorities without accumulating results", async () => {
    const template = activeCtfAuthority(ctfProof("paged-template"));
    const authorities = Array.from({ length: 10_001 }, (_, index) =>
      syntheticAuthority(template, index),
    );
    const scan = installKeysetAuthorityQuery(database, authorities);
    const bulkGet = vi.spyOn(database.proofs, "bulkGet");

    const selected = await getGuiSelectableOutcomeProofs({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
      effectiveNowUnixSeconds: 400,
      cursor: null,
      limit: 256,
      database,
    });

    expect(selected).toEqual({ proofs: [], nextCursor: null });
    expect(scan.calls()).toBeGreaterThan(39);
    expect(scan.maximumRows()).toBe(256);
    expect(bulkGet).toHaveBeenCalledWith([]);
  });

  it("keyset-scans 10000+ active audit authorities without accumulating results", async () => {
    const template = activeCtfAuthority(ctfProof("audit-page-template"));
    const authorities = Array.from({ length: 10_001 }, (_, index) =>
      syntheticAuthority(template, index),
    );
    const scan = installKeysetAuthorityQuery(database, authorities);
    const bulkGet = vi.spyOn(database.proofs, "bulkGet");

    const retained = await getGuiRetainedCtfProofs({
      walletId: WALLET_ID,
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
      effectiveNowUnixSeconds: 200,
      cursor: null,
      limit: 256,
      database,
    });

    expect(retained).toEqual({ proofs: [], nextCursor: null });
    expect(scan.calls()).toBeGreaterThan(39);
    expect(scan.maximumRows()).toBe(256);
    expect(bulkGet).toHaveBeenCalledWith([]);
  });

  it("never reverts terminal CTF authority by backdating effective time", async () => {
    const proof = ctfProof("terminal-monotonic");
    await commitProofAuthority(
      {
        proof,
        authority: retainedAuthority(proof, "verified-losing-outcome"),
        effectiveNowUnixSeconds: 400,
      },
      database,
    );

    await expect(
      commitProofAuthority(
        {
          proof,
          authority: {
            ...activeCtfAuthority(proof),
            revision: 1,
            updatedAtMs: 101,
          },
          effectiveNowUnixSeconds: 200,
        },
        database,
      ),
    ).rejects.toThrow(/terminal authority cannot be reverted/i);
  });
});

async function commitProofAuthority(
  input: Parameters<typeof commitProofAuthorityUnderLock>[1],
  target: BitcasterDB,
): Promise<void> {
  await withGuiWalletLock(
    WALLET_ID,
    () => WALLET_ID,
    (lock) => commitProofAuthorityUnderLock(lock, input, target),
  );
}

function ordinaryProof(secret: string, amount: number): StoredProofRow {
  return prepareStoredProofForWrite(
    {
      id: KEYSET_ID,
      amount: Amount.from(amount),
      secret,
      C: canonicalSecpPoint(1),
      mintUrl: MINT_URL,
      unit: "sat",
      baseAsset: "sat",
    },
    100,
    WALLET_ID,
  );
}

function reservedOrdinaryProof(
  secret: string,
  amount: number,
  reservedBy: string,
): StoredProofRow {
  const proof = ordinaryProof(secret, amount);
  return prepareStoredProofForWrite(
    {
      ...proof,
      reservedBy,
      proofId: undefined,
      walletId: undefined,
      proofClass: undefined,
      selectability: undefined,
    },
    100,
    WALLET_ID,
  );
}

function installImmediateWebLocks(): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ) => callback(),
    },
  });
}

function ctfProof(secret: string, amount = 4): StoredProofRow {
  return prepareStoredProofForWrite(
    {
      id: KEYSET_ID,
      amount: Amount.from(amount),
      secret,
      C: canonicalSecpPoint(2),
      mintUrl: MINT_URL,
      unit: "sat",
      baseAsset: "sat",
      conditionId: CONDITION_ID,
      outcomeCollection: "YES",
      marketId: `${CONDITION_ID}-YES`,
    },
    100,
    WALLET_ID,
  );
}

function activeAuthority(
  proof: StoredProofRow,
  overrides: Partial<GuiProofBackupAuthorityRow> = {},
): GuiProofBackupAuthorityRow {
  return {
    walletId: WALLET_ID,
    proofId: proof.proofId,
    mintUrl: MINT_URL,
    unit: "sat",
    amount: Number(proof.amount),
    proofKind: "ordinary",
    conditionId: null,
    outcomeCollection: null,
    finalExpiryUnixSeconds: null,
    spendDisposition: "active-selectable",
    nonselectableReason: null,
    derivationLocator: {
      kind: "nut13",
      keysetId: KEYSET_ID,
      counter: 7,
    },
    proofCommitment: PROOF_COMMITMENT,
    ctfMetadata: null,
    terminalEvidence: null,
    storageClassification: storageClassification(proof.proofId),
    revision: 0,
    updatedAtMs: 100,
    ...overrides,
  };
}

function retainedAuthority(
  proof: StoredProofRow,
  reason: "recorded-ctf-expiry-passed" | "verified-losing-outcome",
): GuiProofBackupAuthorityRow {
  const terminalEvidence =
    reason === "verified-losing-outcome"
      ? {
          reason,
          operationIdDigest: "88".repeat(32),
          requestDigest: "99".repeat(32),
          failureCode: 13015 as const,
          classifiedAt: 200,
        }
      : null;
  return {
    ...activeAuthority(proof),
    proofKind: "ctf",
    conditionId: CONDITION_ID,
    outcomeCollection: "YES",
    finalExpiryUnixSeconds: 300,
    spendDisposition: "retained-nonselectable",
    nonselectableReason: reason,
    ctfMetadata: {
      conditionId: CONDITION_ID,
      outcomeLabel: "YES",
      outcomeCollectionId: COLLECTION_ID,
      registeredAtUnixSeconds: 100,
      finalExpiryUnixSeconds: 300,
    },
    terminalEvidence,
    storageClassification: storageClassification(proof.proofId, {
      storageClass: "user-retained-nonselectable-ctf",
      pinReasons: [],
    }),
  };
}

function activeCtfAuthority(proof: StoredProofRow): GuiProofBackupAuthorityRow {
  return {
    ...activeAuthority(proof),
    proofKind: "ctf",
    conditionId: CONDITION_ID,
    outcomeCollection: "YES",
    finalExpiryUnixSeconds: 300,
    ctfMetadata: {
      conditionId: CONDITION_ID,
      outcomeLabel: "YES",
      outcomeCollectionId: COLLECTION_ID,
      registeredAtUnixSeconds: 100,
      finalExpiryUnixSeconds: 300,
    },
  };
}

function syntheticAuthority(
  template: GuiProofBackupAuthorityRow,
  index: number,
): GuiProofBackupAuthorityRow {
  const proofId = index.toString(16).padStart(64, "0");
  return {
    ...template,
    proofId,
    storageClassification: storageClassification(proofId),
  };
}

function fakeUntilCollection(values: readonly GuiProofBackupAuthorityRow[]) {
  let stop: (value: GuiProofBackupAuthorityRow) => boolean = () => false;
  const collection = {
    reverse: () => collection,
    until: (predicate: typeof stop) => {
      stop = predicate;
      return collection;
    },
    each: async () => {
      for (const value of values) {
        if (stop(value)) return;
      }
    },
  };
  return collection;
}

function installKeysetAuthorityQuery(
  target: BitcasterDB,
  values: readonly GuiProofBackupAuthorityRow[],
) {
  const sorted = [...values].sort(compareAuthorityRows);
  let calls = 0;
  let maximumRows = 0;
  vi.spyOn(target.proofBackupAuthorities, "where").mockImplementation(
    () =>
      ({
        between: (
          lower: readonly unknown[],
          upper: readonly unknown[],
          includeLower = true,
          includeUpper = true,
        ) => ({
          limit: (limit: number) => ({
            toArray: async () => {
              calls += 1;
              const page = sorted
                .filter((authority) => {
                  const lowerComparison = compareAuthorityToIndex(
                    authority,
                    lower,
                  );
                  const upperComparison = compareAuthorityToIndex(
                    authority,
                    upper,
                  );
                  return (
                    (lowerComparison > 0 ||
                      (includeLower && lowerComparison === 0)) &&
                    (upperComparison < 0 ||
                      (includeUpper && upperComparison === 0))
                  );
                })
                .slice(0, limit);
              maximumRows = Math.max(maximumRows, page.length);
              return page;
            },
          }),
        }),
      }) as never,
  );
  return { calls: () => calls, maximumRows: () => maximumRows };
}

function compareAuthorityRows(
  left: GuiProofBackupAuthorityRow,
  right: GuiProofBackupAuthorityRow,
): number {
  return (
    left.spendDisposition.localeCompare(right.spendDisposition) ||
    left.proofId.localeCompare(right.proofId)
  );
}

function compareAuthorityToIndex(
  authority: GuiProofBackupAuthorityRow,
  index: readonly unknown[],
): number {
  const disposition = String(index.at(-2));
  const proofId = String(index.at(-1));
  return (
    authority.spendDisposition.localeCompare(disposition) ||
    authority.proofId.localeCompare(proofId)
  );
}

function storageClassification(
  proofId: string,
  overrides: Partial<GuiProofBackupAuthorityRow["storageClassification"]> = {},
): GuiProofBackupAuthorityRow["storageClassification"] {
  return {
    schemaVersion: 1,
    recordId: proofId,
    recordKind: "deterministic-proof",
    storageClass: "pinned-local-recovery-state",
    pinReasons: ["missing-current-backup-receipt"],
    proofCommitment: PROOF_COMMITMENT,
    backupBinding: null,
    purgeAfterMs: null,
    ...overrides,
  };
}
