import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMarketCatalogue } from "../marketCatalogueBatches";

afterEach(() => vi.unstubAllGlobals());

describe("loadMarketCatalogue cancellation", () => {
  const ids = Array.from({ length: 110 }, (_, i) => i.toString(16).padStart(64, "0"));

  it("retains the default caller behavior with bounded fifty-ID pages", async () => {
    const fetch = vi.fn(async (url: string, _options?: RequestInit) => {
      const query = new URL(url, "https://engine.test").searchParams;
      const batch = query.get("ids")!.split(",");
      expect(batch.length).toBeLessThanOrEqual(50);
      expect(query.get("page_size")).toBe(String(batch.length));
      return Response.json({
        markets: batch.map((conditionId) => ({ conditionId, finalOutcome: null })),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await loadMarketCatalogue(ids);
    expect(result.size).toBe(110);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][1]).toEqual({ headers: { Accept: "application/json" } });
  });

  it("aborts an in-flight page, preserves successful pages, and never starts later pages", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const secondPage = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ markets: ids.slice(0, 50).map((conditionId) => ({ conditionId })) }),
      )
      .mockImplementationOnce(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
            started();
          }),
      );
    vi.stubGlobal("fetch", fetch);
    const pending = loadMarketCatalogue(ids, { signal: controller.signal });
    await secondPage;
    controller.abort();
    const result = await pending;
    expect(result.size).toBe(50);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal).toBe(controller.signal);
  });

  it("does not fetch when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await loadMarketCatalogue(ids, { signal: controller.signal })).size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
