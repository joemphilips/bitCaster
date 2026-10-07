import { describe, expect, it, vi } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { withWalletProfileLock } from "../walletProfileLock";

const scopeId = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: "11".repeat(32),
});

describe("wallet profile Web Lock", () => {
  it("serializes funded work under the exact wallet scope", async () => {
    const action = vi.fn(async () => "complete");
    const request = vi.fn(async (_name, _options, callback) => callback({} as Lock));

    await expect(
      withWalletProfileLock(scopeId, action, { request } as unknown as LockManager),
    ).resolves.toBe("complete");
    expect(request).toHaveBeenCalledWith(
      `bitcaster:wallet-profile:${scopeId}`,
      { mode: "exclusive" },
      action,
    );
    expect(action).toHaveBeenCalledOnce();
  });

  it("fails closed when Web Locks are unavailable", async () => {
    await expect(withWalletProfileLock(scopeId, async () => undefined, undefined)).rejects.toThrow(
      /cannot safely lock/,
    );
  });

  it("cancels a queued profile-lock request without entering its callback", async () => {
    const controller = new AbortController();
    const action = vi.fn(async () => "complete");
    const request = vi.fn(
      (_name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) =>
        new Promise<unknown>((resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Lock request was aborted", "AbortError")),
            { once: true },
          );
          if (options.signal?.aborted) {
            reject(new DOMException("Lock request was aborted", "AbortError"));
          } else if (options.signal === undefined) {
            void Promise.resolve(callback({} as Lock)).then(resolve, reject);
          }
        }),
    );
    const pending = withWalletProfileLock(
      scopeId,
      action,
      { request } as unknown as LockManager,
      controller.signal,
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledWith(
      `bitcaster:wallet-profile:${scopeId}`,
      { mode: "exclusive", signal: controller.signal },
      action,
    );
    expect(action).not.toHaveBeenCalled();
  });
});
