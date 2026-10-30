export interface CreatorDocumentLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Local oracle writes and creator handoff use one origin-wide lock. */
export async function withCreatorDocumentLock<T>(
  action: () => Promise<T>,
  getLockManager: () => CreatorDocumentLocks | undefined = () => globalThis.navigator?.locks,
): Promise<T> {
  const locks = getLockManager();
  if (!locks) throw new Error("Cross-tab creator locking is unavailable.");
  return locks.request("bitcaster-creator-markets", action);
}
