import { afterEach, expect, it, vi } from "vitest";
import {
  requestBrowserWalletStoragePersistence,
  resetBrowserWalletStoragePersistenceForTest,
} from "../browserWalletStoragePersistence";

afterEach(() => {
  resetBrowserWalletStoragePersistenceForTest();
  vi.restoreAllMocks();
});

it("does nothing when the Persistence API is unsupported", async () => {
  requestBrowserWalletStoragePersistence("wallet-a", undefined);
  await Promise.resolve();
});

it("does not request persistence when the browser has already granted it", async () => {
  const storage = { persisted: vi.fn().mockResolvedValue(true), persist: vi.fn() };
  requestBrowserWalletStoragePersistence("wallet-a", storage);
  await vi.waitFor(() => expect(storage.persisted).toHaveBeenCalledOnce());
  expect(storage.persist).not.toHaveBeenCalled();
});

it("requests persistence once per wallet activation and ignores a denial", async () => {
  const storage = {
    persisted: vi.fn().mockResolvedValue(false),
    persist: vi.fn().mockResolvedValue(false),
  };
  requestBrowserWalletStoragePersistence("wallet-a", storage);
  requestBrowserWalletStoragePersistence("wallet-a", storage);
  await vi.waitFor(() => expect(storage.persist).toHaveBeenCalledOnce());
  expect(storage.persisted).toHaveBeenCalledOnce();
});

it("requests persistence again for a later wallet activation", async () => {
  const storage = {
    persisted: vi.fn().mockResolvedValue(false),
    persist: vi.fn().mockResolvedValue(true),
  };
  requestBrowserWalletStoragePersistence("wallet-a", storage);
  await vi.waitFor(() => expect(storage.persist).toHaveBeenCalledOnce());
  requestBrowserWalletStoragePersistence("wallet-b", storage);
  await vi.waitFor(() => expect(storage.persist).toHaveBeenCalledTimes(2));
});
