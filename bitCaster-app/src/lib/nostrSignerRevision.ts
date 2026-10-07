let revision = 0;
const subscribers = new Set<() => void>();

export function getNostrSignerRevision(): number {
  return revision;
}
export function subscribeToNostrSignerRevision(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
/** Installing a signer invalidates every captured private oracle admission. */
export function advanceNostrSignerRevision(): void {
  revision += 1;
  for (const listener of subscribers) listener();
}
