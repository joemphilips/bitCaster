import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useBrowserOracleRecovery } from "../useBrowserOracleRecovery";
const driver = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("@/lib/browserOracleRecovery", () => ({ startBrowserOracleRecovery: driver.start }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("waits for identity rehydration, mounts one driver and cancels it on unmount", () => {
  driver.start.mockReturnValue(driver.stop);
  const hook = renderHook(({ ready }) => useBrowserOracleRecovery(ready), {
    initialProps: { ready: false },
  });
  expect(driver.start).not.toHaveBeenCalled();
  hook.rerender({ ready: true });
  expect(driver.start).toHaveBeenCalledTimes(1);
  hook.rerender({ ready: true });
  expect(driver.start).toHaveBeenCalledTimes(1);
  hook.unmount();
  expect(driver.stop).toHaveBeenCalledTimes(1);
});
