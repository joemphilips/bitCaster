import { describe, expect, it, vi } from "vitest";
import { fetchOrderBook } from "@/lib/markets";
import { refreshOrderBook } from "@/lib/orderBookRefresh";
import type { OrderBook } from "@/types/market-detail";

vi.mock("@/lib/markets", () => ({ fetchOrderBook: vi.fn() }));

const emptyBook: OrderBook = { bids: [], asks: [], spread: 0 };

describe("order book refresh ownership", () => {
  it("coalesces reads for the same route owner and releases completed requests", async () => {
    let resolve!: (book: OrderBook) => void;
    vi.mocked(fetchOrderBook).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const owner = new AbortController();
    const first = refreshOrderBook("same-owner", owner.signal);
    expect(refreshOrderBook("same-owner", owner.signal)).toBe(first);
    resolve(emptyBook);
    await first;
    const next = refreshOrderBook("same-owner", owner.signal);
    expect(next).not.toBe(first);
    resolve(emptyBook);
    await next;
  });

  it("one route owner cannot cancel another owner's read or the hub repair", async () => {
    vi.mocked(fetchOrderBook).mockImplementation((_id, signal) =>
      signal
        ? new Promise((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            ),
          )
        : Promise.resolve(emptyBook),
    );
    const first = new AbortController();
    const second = new AbortController();
    const firstRead = expect(
      refreshOrderBook("separate-owner", first.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const secondRead = expect(
      refreshOrderBook("separate-owner", second.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const hubRead = refreshOrderBook("separate-owner");
    expect(refreshOrderBook("separate-owner")).toBe(hubRead);
    first.abort();
    await firstRead;
    expect(second.signal.aborted).toBe(false);
    await expect(hubRead).resolves.toEqual(emptyBook);
    second.abort();
    await secondRead;
  });
});
