import { beforeEach, expect, it, vi } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { decryptSelfNip44 } from "@bitcaster/client-sdk/privateNip78";
import { fetchPrivateNip78Content, publishPrivateNip78 } from "../nip78Private";

const transport = vi.hoisted(() => ({
  publish: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@nostr-dev-kit/ndk", () => ({
  NDKPrivateKeySigner: class {},
  NDKEvent: class {
    kind?: number;
    tags?: string[][];
    content?: string;
    async publishReplaceable() {
      transport.publish({ kind: this.kind, tags: this.tags, content: this.content });
    }
  },
}));

vi.mock("../nostr", () => ({
  withTemporaryRelayNdk: async (
    _options: unknown,
    _signer: unknown,
    run: (ndk: { fetchEvent: typeof transport.fetch }) => Promise<unknown>,
  ) => run({ fetchEvent: transport.fetch }),
}));

beforeEach(() => vi.clearAllMocks());

it("publishes the shared encrypted envelope and reads it through the browser adapter", async () => {
  const key = "11".repeat(32);
  const publicKey = getPublicKey(hexToBytes(key));
  const plaintext = JSON.stringify({ items: [] });
  await publishPrivateNip78(key, "bitcaster:activity-log", plaintext);
  const event = transport.publish.mock.calls[0][0];
  expect(event.kind).toBe(30078);
  expect(event.tags).toEqual([
    ["d", "bitcaster:activity-log"],
    ["encrypted", "nip44"],
  ]);
  expect(decryptSelfNip44(key, publicKey, event.content)).toBe(plaintext);
  transport.fetch.mockResolvedValue(event);
  await expect(fetchPrivateNip78Content(publicKey, "bitcaster:activity-log", key)).resolves.toBe(
    plaintext,
  );
  expect(transport.fetch).toHaveBeenCalledWith({
    kinds: [30078],
    authors: [publicKey],
    "#d": ["bitcaster:activity-log"],
  });
});
