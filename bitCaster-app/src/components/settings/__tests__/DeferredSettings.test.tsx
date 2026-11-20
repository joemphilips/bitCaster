import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredSettings } from "../DeferredSettings";
import { loadSettingsComponent, scheduleSettingsPreload } from "../settingsModule";
import type { SettingsProps } from "@/types/settings";

vi.mock("../Settings", () => ({
  Settings: () => <p>Settings body</p>,
}));

const props = {} as SettingsProps;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DeferredSettings", () => {
  it("renders the Settings body on the first render after a preload", async () => {
    await loadSettingsComponent();

    render(<DeferredSettings {...props} />);

    expect(screen.getByText("Settings body")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("scheduleSettingsPreload", () => {
  it("starts the load when the browser is idle", () => {
    let idle: (() => void) | undefined;
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        idle = callback;
        return 7;
      }),
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const load = vi.fn(() => Promise.resolve());

    scheduleSettingsPreload(load);
    expect(load).not.toHaveBeenCalled();
    idle?.();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("cancels the idle load when the shell unmounts first", () => {
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn(() => 7),
    );
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);

    scheduleSettingsPreload(vi.fn(() => Promise.resolve()))();

    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it("starts the load after a timer when the browser has no idle callback", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const load = vi.fn(() => Promise.resolve());

    scheduleSettingsPreload(load);
    expect(load).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();

    expect(load).toHaveBeenCalledTimes(1);
  });
});
