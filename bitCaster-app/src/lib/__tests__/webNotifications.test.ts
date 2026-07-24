import { afterEach, describe, expect, it, vi } from "vitest";
import { getNotificationPermission, showWebNotification } from "../webNotifications";

/**
 * Install a fake Notification constructor with a configurable static
 * `permission`. Returns a spy that records construction calls.
 */
function installNotification(permission: NotificationPermission) {
  const ctor = vi.fn() as unknown as typeof Notification;
  // The static `permission` field is read by the lib before constructing.
  (ctor as unknown as { permission: NotificationPermission }).permission = permission;
  vi.stubGlobal("Notification", ctor);
  return ctor as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showWebNotification permission gating", () => {
  it("fires a notification when permission is granted", () => {
    const ctor = installNotification("granted");
    const result = showWebNotification("Closed", { body: "Market closed" });
    expect(result).toBe(true);
    expect(ctor).toHaveBeenCalledWith("Closed", { body: "Market closed" });
  });

  it("does not fire when permission is default (not opted in / not granted)", () => {
    const ctor = installNotification("default");
    const result = showWebNotification("Closed");
    expect(result).toBe(false);
    expect(ctor).not.toHaveBeenCalled();
  });

  it("does not fire when permission is denied", () => {
    const ctor = installNotification("denied");
    expect(showWebNotification("Closed")).toBe(false);
    expect(ctor).not.toHaveBeenCalled();
  });

  it("reports unsupported when the Notification API is absent", () => {
    vi.stubGlobal("Notification", undefined);
    expect(getNotificationPermission()).toBe("unsupported");
    expect(showWebNotification("Closed")).toBe(false);
  });
});
