// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveConditionalKeysetId } from "@cashu/cashu-ts";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { deserializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { encryptedWalletBackupV2LocalAssetKey } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { BROWSER_D4_CONDITION } from "../../test/browserD4OracleFixture";
import { commitBrowserCtfTerminalOperation } from "../../test/browserCtfTerminalOperationFixture";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  createBrowserProofBackupAuthorityRow,
  requireBrowserLiveProofBackupAuthorityTableRow,
} from "../../stores/browser-proof-backup-authority";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import { decodeBrowserCustodyProofRow } from "../../stores/durable-custody-types";
import { BitcasterDB, storedProofFromCustodyRow, storedProofRow } from "../../stores/proof-db";
import {
  requireBrowserCtfVerifiedLosingProofAuthority,
  startBrowserCtfRemove,
  type BrowserCtfRemoveTarget,
} from "../browserCtfRemoveCoordinator";

const MINT = "https://mint.example";
const PUBLIC_KEY = `02${"22".repeat(32)}`;
const CONDITION_ID = BROWSER_D4_CONDITION;
const OUTCOME = "YES";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME,
});
const KEYSET = deriveConditionalKeysetId({
  keys: { "1": PUBLIC_KEY },
  unit: "msat",
  input_fee_ppk: 0,
  final_expiry: 2,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
});
const SEED = new Uint8Array(64).fill(19);
const databases: BitcasterDB[] = [];
const immediateLockManager = {
  request: (async (_name: string, _options: LockOptions, action: LockGrantedCallback<unknown>) =>
    action(null)) as LockManager["request"],
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

// The recovery index holds no proofs, so the removal of a verified losing
// token is local only (ADR-034 recovery index amendment, "Removal of a losing
// token"). It applies to a proof with or without a NUT-13 locator.
describe("browser CTF local removal coordinator", () => {
  it.each([false, true])(
    "removes verified losing proofs in one local transaction and replays after reload (derivation-backed: %s)",
    async (derivationBacked) => {
      const fixture = await createLocalFixture(2, false, { derivationBacked });
      const input = fixture.input(fixture.proofs.map(({ proofId }) => fixture.target(proofId)));

      await expect(startBrowserCtfRemove(input)).resolves.toEqual({ kind: "completed" });

      expect(await fixture.database.custodyProofs.count()).toBe(0);
      for (const proof of fixture.proofs) {
        expect(
          await fixture.database.proofs.get(storedProofFromCustodyRow(proof).secret),
        ).toBeUndefined();
        const marker = await fixture.database.custodyProofBackupAuthorities.get([
          fixture.scopeId,
          proof.proofId,
        ]);
        expect(marker).toMatchObject({
          recordKind: "completed-local-removal",
          scopeId: fixture.scopeId,
          proofId: proof.proofId,
          proofFingerprint: proof.proofFingerprint,
          proofRevision: proof.revision,
          localAssetKey: fixture.localAssetKey,
          completedAtMs: 3_000,
        });
        expect(marker).not.toHaveProperty("proofBody");
        expect(marker).not.toHaveProperty("secret");
      }

      fixture.database.close();
      const reloaded = new BitcasterDB(browserWalletDatabaseName(fixture.scopeId));
      databases.push(reloaded);
      await reloaded.open();
      await expect(startBrowserCtfRemove({ ...input, database: reloaded })).resolves.toEqual({
        kind: "completed",
      });
      await expect(
        startBrowserCtfRemove({
          ...input,
          database: reloaded,
          targets: [{ ...input.targets[0]!, proofRevision: input.targets[0]!.proofRevision + 1 }],
        }),
      ).rejects.toThrow();
    },
  );

  it("removes siblings from one terminal operation in separate confirmed actions", async () => {
    const fixture = await createLocalFixture(2, true);
    for (const proof of fixture.proofs) {
      await expect(
        startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
      ).resolves.toEqual({ kind: "completed" });
    }
    expect(await fixture.database.custodyProofs.count()).toBe(0);
  });

  it("does not remove a sibling that the caller did not confirm", async () => {
    const fixture = await createLocalFixture(2, true);
    const confirmed = fixture.proofs[0]!;
    const unconfirmed = fixture.proofs[1]!;

    await startBrowserCtfRemove(fixture.input([fixture.target(confirmed.proofId)]));

    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, confirmed.proofId]),
    ).toBeUndefined();
    expect(
      await fixture.database.custodyProofs.get([fixture.scopeId, unconfirmed.proofId]),
    ).toMatchObject({ revision: unconfirmed.revision, selectability: "verified-losing" });
  });

  it("rolls back the removal before deleting the proof", async () => {
    const fixture = await createLocalFixture();
    const proof = fixture.proofs[0]!;

    await expect(
      startBrowserCtfRemove({
        ...fixture.input([fixture.target(proof.proofId)]),
        fault: "before-commit",
      }),
    ).rejects.toThrow(/local removal commit fault/);
    expect(await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId])).toEqual(
      proof,
    );
    expect(await fixture.database.proofs.get(storedProofFromCustodyRow(proof).secret)).toEqual(
      expect.any(Object),
    );
    expect(
      await fixture.database.custodyProofBackupAuthorities.get([fixture.scopeId, proof.proofId]),
    ).not.toMatchObject({ recordKind: "completed-local-removal" });
  });

  it("refuses a reserved proof without deleting custody", async () => {
    const fixture = await createLocalFixture(1, false, { derivationBacked: true });
    const proof = fixture.proofs[0]!;
    await fixture.database.custodyReservations.put({
      scopeId: fixture.scopeId,
      proofId: proof.proofId,
      operationId: "01".repeat(32),
      reservationId: "02".repeat(32),
      inputPosition: 0,
    });

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).rejects.toThrow(/reservation/);
    expect(await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId])).toEqual(
      proof,
    );
  });

  it("refuses a proof that is not verified losing", async () => {
    const fixture = await createLocalFixture(1, false, { derivationBacked: true });
    const open = createBrowserCustodyProofRow({
      scopeId: fixture.scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: { id: KEYSET, amount: 1 as never, secret: "open-derivation-backed", C: PUBLIC_KEY },
      asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: OUTCOME },
      receivedAtMs: 900,
    });
    await fixture.database.custodyProofs.put(open);
    await fixture.database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(
        open,
        1_000,
        { schemaVersion: 1, kind: "nut13", keysetId: KEYSET, counter: 9 },
        "admission-open",
      ),
    );

    await expect(startBrowserCtfRemove(fixture.input([removeTarget(open)]))).rejects.toThrow(
      /local removal proof binding is foreign/,
    );
    expect(await fixture.database.custodyProofs.get([fixture.scopeId, open.proofId])).toMatchObject(
      { selectability: "selectable" },
    );
  });

  it.each(["missing-operation", "foreign-operation", "missing-rejection"] as const)(
    "retains custody with %s local terminal evidence",
    async (defect) => {
      const fixture = await createLocalFixture(2);
      const proof = fixture.proofs[0]!;
      const key = [fixture.scopeId, proof.proofId] as [string, string];
      const authority = requireBrowserLiveProofBackupAuthorityTableRow(
        await fixture.database.custodyProofBackupAuthorities.get(key),
        key,
      );
      if (authority === undefined || authority.backupState !== "local-only") {
        throw new Error("test local authority is missing");
      }
      switch (defect) {
        case "missing-operation":
          await fixture.database.custodyProofBackupAuthorities.put({
            ...authority,
            terminalOperationId: "missing-terminal-operation",
            terminalAuthority: {
              kind: "local-operation",
              operationId: "missing-terminal-operation",
            },
          });
          break;
        case "foreign-operation": {
          const siblingKey = [fixture.scopeId, fixture.proofs[1]!.proofId] as [string, string];
          const sibling = requireBrowserLiveProofBackupAuthorityTableRow(
            await fixture.database.custodyProofBackupAuthorities.get(siblingKey),
            siblingKey,
          );
          if (sibling === undefined) throw new Error("test sibling authority is missing");
          await fixture.database.custodyProofBackupAuthorities.put({
            ...authority,
            terminalOperationId: sibling.terminalOperationId,
            terminalAuthority: sibling.terminalAuthority,
          });
          break;
        }
        case "missing-rejection": {
          const operationId = authority.terminalOperationId!;
          const operation = await fixture.database.custodyOperations.get([
            fixture.scopeId,
            operationId,
          ]);
          const reference = operation?.record.operation.terminalMintRejection?.exactRejection;
          if (reference === undefined) throw new Error("test committed rejection is missing");
          await fixture.database.custodyArtifacts.delete([
            fixture.scopeId,
            operationId,
            reference.artifactId,
          ]);
          break;
        }
      }

      await expect(
        startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
      ).rejects.toThrow(
        {
          "missing-operation": /local terminal operation is missing/,
          "foreign-operation": /local terminal operation is foreign/,
          "missing-rejection": /artifact/,
        }[defect],
      );
      expect(await fixture.database.custodyProofs.get(key)).toEqual(proof);
    },
  );

  it("refuses a changed legacy cache without changing canonical custody", async () => {
    const fixture = await createLocalFixture();
    const proof = fixture.proofs[0]!;
    const cached = storedProofFromCustodyRow(proof);
    await fixture.database.proofs.put({ ...storedProofRow(cached), C: `02${"33".repeat(32)}` });

    await expect(
      startBrowserCtfRemove(fixture.input([fixture.target(proof.proofId)])),
    ).rejects.toThrow(/cache conflicts/);
    expect(await fixture.database.custodyProofs.get([fixture.scopeId, proof.proofId])).toEqual(
      proof,
    );
  });

  it("rejects duplicate and malformed caller proof tuples", async () => {
    const fixture = await createLocalFixture();
    const target = fixture.target(fixture.proofs[0]!.proofId);

    await expect(startBrowserCtfRemove(fixture.input([target, target]))).rejects.toThrow(
      /duplicated/,
    );
    await expect(
      startBrowserCtfRemove(fixture.input([{ ...target, proofFingerprint: "not-a-fingerprint" }])),
    ).rejects.toThrow(/proof tuple is invalid/);
    await expect(
      startBrowserCtfRemove(fixture.input(new Array<BrowserCtfRemoveTarget>(1))),
    ).rejects.toThrow(/proof tuple is invalid/);
    expect(await fixture.database.custodyProofs.count()).toBe(1);
  });

  it("checks the committed losing redeem before a claim treats a proof as terminal", async () => {
    const fixture = await createLocalFixture();
    const proof = fixture.proofs[0]!;

    await expect(
      requireBrowserCtfVerifiedLosingProofAuthority(fixture.database, proof),
    ).resolves.toBeUndefined();

    const key = [fixture.scopeId, proof.proofId] as [string, string];
    const authority = requireBrowserLiveProofBackupAuthorityTableRow(
      await fixture.database.custodyProofBackupAuthorities.get(key),
      key,
    );
    if (authority === undefined || authority.backupState !== "local-only") {
      throw new Error("test local authority is missing");
    }
    await fixture.database.custodyProofBackupAuthorities.put({
      ...authority,
      terminalOperationId: "missing-terminal-operation",
      terminalAuthority: { kind: "local-operation", operationId: "missing-terminal-operation" },
    });
    await expect(
      requireBrowserCtfVerifiedLosingProofAuthority(fixture.database, proof),
    ).rejects.toThrow(/local terminal operation is missing/);
  });
});

function removeTarget(
  proof: ReturnType<typeof decodeBrowserCustodyProofRow>,
): BrowserCtfRemoveTarget {
  return {
    proofId: proof.proofId,
    proofFingerprint: proof.proofFingerprint,
    proofRevision: proof.revision,
  };
}

/** Verified losing proofs, each classified by a committed 13015 redeem operation. */
async function createLocalFixture(
  count = 1,
  sharedTerminalOperation = false,
  options: { readonly derivationBacked?: boolean } = {},
) {
  const walletId = deriveDurableCustodyWalletId(SEED);
  const scopeId = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId });
  const scope = { scopeKind: "wallet" as const, walletId, scopeId };
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  const adapter = new BrowserDurableCustodyAdapter(database);
  const owner = await adapter.claimScope(scope, {
    incarnationId: "browser-local-remove",
    observedAtMs: 1_000,
    leaseExpiresAtMs: 10_000,
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: MINT,
    unit: "msat",
    asset: {
      kind: "ctf",
      conditionId: CONDITION_ID,
      outcomeLabel: OUTCOME,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  const created = Array.from({ length: count }, (_, index) =>
    createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: KEYSET,
        amount: 1 as never,
        secret: `local-remove-secret-${index}`,
        C: PUBLIC_KEY,
      },
      asset: { kind: "conditional", conditionId: CONDITION_ID, outcomeCollection: OUTCOME },
      receivedAtMs: 900,
    }),
  );
  await database.custodyProofs.bulkPut(created);
  await database.custodyProofBackupAuthorities.bulkPut(
    created.map((proof, index) =>
      createBrowserProofBackupAuthorityRow(
        proof,
        1_000,
        options.derivationBacked
          ? { schemaVersion: 1, kind: "nut13", keysetId: KEYSET, counter: index }
          : null,
        `admission-local-${index}`,
      ),
    ),
  );
  await database.proofs.bulkPut(
    created.map((proof) => storedProofRow(storedProofFromCustodyRow(proof))),
  );
  await database.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: KEYSET,
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk: 0,
    conditionId: CONDITION_ID,
    outcomeCollection: OUTCOME,
    outcomeCollectionId: OUTCOME_COLLECTION_ID,
    registeredAtUnixSeconds: 1,
    finalExpiryUnixSeconds: 2,
    curve: "secp256k1",
  });
  const groups = sharedTerminalOperation ? [created] : created.map((proof) => [proof]);
  for (const [index, group] of groups.entries()) {
    await commitBrowserCtfTerminalOperation({
      adapter,
      database,
      scope,
      owner: { ...owner, observedAtMs: 1_500 + index * 100 },
      operationId: `ctf-redeem-local-remove-${index}`,
      mintUrl: MINT,
      proofs: group.map(proofFromRow),
      predecessorProofs: group,
      publicKey: PUBLIC_KEY,
      classifiedAtMs: 2_000 + index * 100,
    });
  }
  const classified = await database.custodyProofs.bulkGet(
    created.map((proof) => [scopeId, proof.proofId]),
  );
  if (classified.some((proof) => proof === undefined)) {
    throw new Error("test classified removal proof is missing");
  }
  const proofs = classified.map((proof) => decodeBrowserCustodyProofRow(proof));
  return {
    database,
    scopeId,
    localAssetKey: encryptedWalletBackupV2LocalAssetKey(asset),
    proofs,
    target: (proofId: string) => {
      const proof = proofs.find((candidate) => candidate.proofId === proofId);
      if (proof === undefined) throw new Error("test removal target is missing");
      return removeTarget(proof);
    },
    input: (targets: readonly BrowserCtfRemoveTarget[]) => ({
      database,
      scopeId,
      asset,
      targets,
      observedAtMs: 3_000,
      lockManager: immediateLockManager,
      isCurrentProfile: () => true,
    }),
  };
}

function proofFromRow(row: ReturnType<typeof createBrowserCustodyProofRow>) {
  const proof = deserializeDurableCustodyProofArtifact(
    JSON.parse(new TextDecoder().decode(row.proofBody)),
  );
  return {
    id: proof.id,
    amount: Number(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === undefined ? {} : { dleq: structuredClone(proof.dleq) }),
  } as never;
}
