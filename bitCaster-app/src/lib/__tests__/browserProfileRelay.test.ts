import { expect, it, vi } from "vitest";
import { queryBrowserProfileRelay } from "../browserProfileRelay";

it("does not create a socket for an already cancelled profile read", async () => {
  const controller = new AbortController();
  controller.abort();
  const socket = vi.fn();
  await expect(
    queryBrowserProfileRelay("wss://example.com", { kinds: [0] }, vi.fn(), {
      signal: controller.signal,
      requireCurrent: () => {},
      websocketImplementation: socket as unknown as typeof WebSocket,
    }),
  ).rejects.toThrow("incomplete");
  expect(socket).not.toHaveBeenCalled();
});
