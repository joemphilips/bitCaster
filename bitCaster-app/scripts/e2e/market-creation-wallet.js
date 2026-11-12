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
