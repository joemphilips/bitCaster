/*
 * Browser wallet probes used by the private market-creation E2E harness.
 *
 * This file is test-only. The private harness reads it and evaluates the
 * named functions in the active browser wallet context.
 */

async function withActiveBrowserWalletDatabase(operation) {
  const activeWalletDatabaseNames = (await indexedDB.databases())
    .map((database) => database.name)
    .filter(
      (name) =>
        typeof name === "string" &&
        name.startsWith("bitcaster-wallet-") &&
        name !== "bitcaster-wallet-uninitialized",
    );
  if (activeWalletDatabaseNames.length !== 1) {
    throw new Error(
      `Expected exactly one active browser wallet database; found ${JSON.stringify(activeWalletDatabaseNames)}.`,
    );
  }

  const request = indexedDB.open(activeWalletDatabaseNames[0]);
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await operation(db);
  } finally {
    db.close();
  }
}

async function evaluateInActiveBrowserWalletDatabase(operation, argument) {
  return await withActiveBrowserWalletDatabase((db) => operation(db, argument));
}

async function readOrdinaryMsatSnapshot(db, mintUrl) {
  const readAll = async (storeName) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  };
  const normalizeMint = (value) => {
    try {
      return new URL(value).toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  };
  const targetMint = normalizeMint(mintUrl);
  const [desiredAssets, receipts, custodyProofs, legacyProofs] = await Promise.all([
    readAll("encryptedWalletBackupV2DesiredAssets"),
    readAll("encryptedWalletBackupV2WalletAssetReceipts"),
    readAll("custodyProofs"),
    readAll("proofs"),
  ]);
  const desired = desiredAssets.find(
    (row) =>
      normalizeMint(row.mintUrl) === targetMint &&
      row.unit === "msat" &&
      row.assetIdentity === "cashu:ordinary",
  );
  const receipt =
    desired === undefined
      ? undefined
      : receipts.find(
          (value) =>
            value.scopeId === desired.scopeId &&
            value.localAssetKey === desired.localAssetKey &&
            value.custodyRevision === desired.custodyRevision,
        );
  const canonical = custodyProofs.filter(
    (proof) =>
      desired !== undefined &&
      proof.scopeId === desired.scopeId &&
      normalizeMint(proof.normalizedMint) === targetMint &&
      proof.unit === "msat" &&
      proof.assetKind === "regular",
  );
  const legacy = legacyProofs.filter(
    (proof) =>
      normalizeMint(proof.mintUrl) === targetMint &&
      proof.unit === "msat" &&
      proof.baseAsset === "sat" &&
      !proof.conditionId &&
      !proof.condition_id &&
      !proof.outcomeCollection &&
      !proof.outcome_collection,
  );
  return { desired, receipt, canonical, legacy };
}

async function readOrdinaryMsatAssetState({ mintUrl }) {
  return await withActiveBrowserWalletDatabase(async (db) => {
    const { desired, receipt, canonical, legacy } = await readOrdinaryMsatSnapshot(db, mintUrl);
    return {
      backupReady:
        desired !== undefined &&
        desired.desiredAction === "replace" &&
        desired.syncState === "acknowledged" &&
        desired.activeProofCount > 0 &&
        receipt !== undefined &&
        typeof receipt.assetLocator === "string" &&
        receipt.assetLocator.length > 0,
      scopeId: desired?.scopeId ?? null,
      assetLocator: receipt?.assetLocator ?? null,
      selectableCanonicalProofCount: canonical.filter(
        (proof) => proof.selectability === "selectable",
      ).length,
      selectableCanonicalAvailableSubunits: canonical
        .filter((proof) => proof.selectability === "selectable")
        .reduce((total, proof) => total + Number(proof.amount || 0), 0),
      unreservedLegacyProofCount: legacy.filter((proof) => !proof.reservedBy).length,
      unreservedLegacyAvailableSubunits: legacy
        .filter((proof) => !proof.reservedBy)
        .reduce((total, proof) => total + Number(proof.amount || 0), 0),
    };
  });
}

async function evictOrdinaryMsatProofBodies({ mintUrl }) {
  return await withActiveBrowserWalletDatabase(async (db) => {
    const { desired } = await readOrdinaryMsatSnapshot(db, mintUrl);
    if (desired === undefined) throw new Error("ordinary msat backup desired asset is absent");

    const [quotaCleanup, seedHandoff, proofDatabase, walletProfile] = await Promise.all([
      import("/src/lib/browserEncryptedWalletBackupV2QuotaCleanup.ts"),
      import("/src/lib/browserEncryptedWalletBackupV2SeedHandoff.ts"),
      import("/src/stores/proof-db.ts"),
      import("/src/lib/browserWalletProfile.ts"),
    ]);
    const quotaDatabase = proofDatabase.db;
    if (quotaDatabase.name !== walletProfile.browserWalletDatabaseName(desired.scopeId)) {
      throw new Error("ordinary msat quota cleanup database is not the active wallet database");
    }
    const eligible = await seedHandoff.listBrowserEncryptedWalletBackupV2CacheRemovalEligibleAssets(
      {
        database: quotaDatabase,
        scopeId: desired.scopeId,
        isCurrentProfile: () =>
          quotaDatabase.name === walletProfile.browserWalletDatabaseName(desired.scopeId),
      },
    );
    const targetCandidate = eligible.find(
      (candidate) => candidate.desired.localAssetKey === desired.localAssetKey,
    );
    if (targetCandidate === undefined) {
      throw new Error("ordinary msat backup cache is not eligible for quota eviction");
    }
    const protectedLocalAssetKeys = eligible
      .map((candidate) => candidate.desired.localAssetKey)
      .filter((localAssetKey) => localAssetKey !== desired.localAssetKey);
    let writeAttempts = 0;
    const quotaResult = await quotaCleanup.retryBrowserEncryptedWalletBackupV2QuotaWrite({
      database: quotaDatabase,
      scopeId: desired.scopeId,
      isCurrentProfile: () =>
        quotaDatabase.name === walletProfile.browserWalletDatabaseName(desired.scopeId),
      protectedLocalAssetKeys,
      write: async () => {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          throw new DOMException("E2E quota cleanup trigger", "QuotaExceededError");
        }
        return true;
      },
    });
    if (
      writeAttempts !== 2 ||
      quotaResult.result !== true ||
      quotaResult.evictedLocalAssetKey !== desired.localAssetKey
    ) {
      throw new Error("ordinary msat quota eviction did not remove the exact target cache");
    }
    const verifyTx = db.transaction(["custodyProofs", "custodyProofBackupAuthorities"], "readonly");
    const read = (store, key) =>
      new Promise((resolve, reject) => {
        const request = verifyTx.objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const [remainingCandidateProofs, remainingCandidateAuthorities] = await Promise.all([
      Promise.all(
        targetCandidate.proofs.map((proof) =>
          read("custodyProofs", [proof.scopeId, proof.proofId]),
        ),
      ),
      Promise.all(
        targetCandidate.proofs.map((proof) =>
          read("custodyProofBackupAuthorities", [proof.scopeId, proof.proofId]),
        ),
      ),
    ]);
    return {
      remainingCandidateProofCount: remainingCandidateProofs.filter((value) => value !== undefined)
        .length,
      remainingCandidateProofAuthorityCount: remainingCandidateAuthorities.filter(
        (value) => value !== undefined,
      ).length,
    };
  });
}
