let profileAccessQueue: Promise<unknown> = Promise.resolve()

/**
 * Serializes each identity-preflight/open/close window in this process.
 * Cross-process exclusion remains the responsibility of the run lock and
 * custody-scope fence.
 */
export async function withProfileStorageAccess<T>(run: () => Promise<T> | T): Promise<T> {
  const next = profileAccessQueue.then(run, run)
  profileAccessQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}
