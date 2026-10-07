import { vi } from "vitest";
import {
  useCreatorMarketsStore,
  type CreatorDocumentLocks,
  type StoredCreatorMarket,
} from "@/stores/creatorMarkets";

/** Unit fixtures explicitly provide the unavailable browser Web Locks API. */
export function installCreatorDocumentLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  const locks: CreatorDocumentLocks = {
    request: (_name, callback) => {
      const result = tail.then(callback);
      tail = result.catch(() => {});
      return result;
    },
  };
  vi.stubGlobal(
    "navigator",
    new Proxy(navigator, {
      get: (target, property) =>
        property === "locks" ? locks : Reflect.get(target, property, target),
    }),
  );
  return locks;
}

export async function seedCreatorMarkets(input: { markets: StoredCreatorMarket[] }) {
  await useCreatorMarketsStore.getState().clear();
  await useCreatorMarketsStore.getState().mergeRemoteMarkets(input.markets);
}
