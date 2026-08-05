interface BrowserStorageManager {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

let activation: string | null = null;

/** Requests best-effort browser storage persistence once after wallet activation. */
export function requestBrowserWalletStoragePersistence(
  activationId: string,
  storage: BrowserStorageManager | undefined = globalThis.navigator?.storage,
): void {
  if (activation === activationId || storage === undefined) return;
  activation = activationId;
  void requestPersistence(storage);
}

async function requestPersistence(storage: BrowserStorageManager): Promise<void> {
  try {
    if (!(await storage.persisted())) await storage.persist();
  } catch {
    // Browser storage persistence is optional and must not block wallet use.
  }
}

export function resetBrowserWalletStoragePersistenceForTest(): void {
  activation = null;
}
