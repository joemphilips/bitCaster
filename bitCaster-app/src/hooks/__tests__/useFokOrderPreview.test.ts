import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineClientError } from "@bitcaster/client-sdk/engineClient";
import type {
  PreviewFokOrderRequest,
  PreviewFokOrderResponse,
} from "@bitcaster/client-sdk/fokOrderPreview";
import { useFokOrderPreview, type FokOrderPreviewClient } from "../useFokOrderPreview";

const request: PreviewFokOrderRequest = {
  marketId: "condition-Yes",
  side: "Buy",
  tokenSide: "Outcome",
  price: 999,
  faceAmountSubunits: 1_000,
};

const fillableResponse: PreviewFokOrderResponse = {
  fullFillAvailable: true,
  reason: "fillable",
  previewRevision: "revision-1",
  quotePaymentSubunits: 999,
  averagePrice: 999,
  worstPrice: 999,
  currentLatestTradePrice: 500,
  projectedFinalPrice: 510,
  priceDenominator: 1_000,
  subsidyMayHelp: false,
};

const nonfillableResponse: PreviewFokOrderResponse = {
  fullFillAvailable: false,
  reason: "insufficient_liquidity",
  previewRevision: "revision-2",
  quotePaymentSubunits: null,
  averagePrice: null,
  worstPrice: null,
  currentLatestTradePrice: 500,
  projectedFinalPrice: null,
  priceDenominator: 1_000,
  subsidyMayHelp: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("useFokOrderPreview", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays idle when no request is supplied", () => {
    const client: FokOrderPreviewClient = { previewFokOrder: vi.fn() };
    const { result } = renderHook(() => useFokOrderPreview({ client, request: null }));

    expect(result.current.status).toBe("idle");
    expect(result.current.response).toBeNull();
    expect(client.previewFokOrder).not.toHaveBeenCalled();
  });

  it("loads and preserves the authoritative response", async () => {
    vi.useFakeTimers();
    const client: FokOrderPreviewClient = {
      previewFokOrder: vi.fn().mockResolvedValue(fillableResponse),
    };
    const { result } = renderHook(() => useFokOrderPreview({ client, request, debounceMs: 20 }));

    expect(result.current.status).toBe("loading");
    expect(client.previewFokOrder).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(20);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.response).toBe(fillableResponse);
    expect(client.previewFokOrder).toHaveBeenCalledWith(request, expect.any(AbortSignal));
  });

  it("cancels and ignores a late response when request terms change", async () => {
    const first = deferred<PreviewFokOrderResponse>();
    const second = deferred<PreviewFokOrderResponse>();
    const client: FokOrderPreviewClient = {
      previewFokOrder: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const { result, rerender } = renderHook(
      ({ currentRequest }: { currentRequest: PreviewFokOrderRequest }) =>
        useFokOrderPreview({ client, request: currentRequest }),
      { initialProps: { currentRequest: request } },
    );

    await waitFor(() => expect(client.previewFokOrder).toHaveBeenCalledTimes(1));
    rerender({ currentRequest: { ...request } });
    expect(client.previewFokOrder).toHaveBeenCalledTimes(1);

    const firstSignal = vi.mocked(client.previewFokOrder).mock.calls[0]?.[1];
    const changedRequest = { ...request, price: 998 };
    rerender({ currentRequest: changedRequest });

    await waitFor(() => expect(client.previewFokOrder).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.status).toBe("loading");

    await act(async () => {
      first.resolve(fillableResponse);
      await Promise.resolve();
    });
    expect(result.current.status).toBe("loading");
    expect(result.current.response).toBeNull();

    await act(async () => {
      second.resolve(nonfillableResponse);
      await Promise.resolve();
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.response).toBe(nonfillableResponse);
  });

  it("keeps the request lifecycle working through StrictMode effect replay", async () => {
    const client: FokOrderPreviewClient = {
      previewFokOrder: vi.fn().mockResolvedValue(fillableResponse),
    };
    const { result } = renderHook(() => useFokOrderPreview({ client, request }), {
      wrapper: StrictMode,
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.response).toBe(fillableResponse);
  });

  it("reloads unchanged terms when the bounded invalidation key changes", async () => {
    const first = deferred<PreviewFokOrderResponse>();
    const second = deferred<PreviewFokOrderResponse>();
    const client: FokOrderPreviewClient = {
      previewFokOrder: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) =>
        useFokOrderPreview({ client, request, invalidationKey: identity }),
      { initialProps: { identity: "route-a" } },
    );

    await waitFor(() => expect(client.previewFokOrder).toHaveBeenCalledTimes(1));
    const firstSignal = vi.mocked(client.previewFokOrder).mock.calls[0]?.[1];
    rerender({ identity: "route-b" });

    await waitFor(() => expect(client.previewFokOrder).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.status).toBe("loading");

    await act(async () => {
      second.resolve(fillableResponse);
      await Promise.resolve();
    });
    expect(result.current.response).toBe(fillableResponse);
  });

  it("aborts an in-flight request on unmount and resets on null request", async () => {
    const pending = deferred<PreviewFokOrderResponse>();
    const resetPending = deferred<PreviewFokOrderResponse>();
    const client: FokOrderPreviewClient = {
      previewFokOrder: vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockReturnValueOnce(resetPending.promise),
    };
    const mounted = renderHook(() => useFokOrderPreview({ client, request }));

    await waitFor(() => expect(client.previewFokOrder).toHaveBeenCalledTimes(1));
    const mountedSignal = vi.mocked(client.previewFokOrder).mock.calls[0]?.[1];
    mounted.unmount();
    expect(mountedSignal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(fillableResponse);
      await Promise.resolve();
    });

    const initialProps: { currentRequest: PreviewFokOrderRequest | null } = {
      currentRequest: request,
    };
    const { result, rerender, unmount } = renderHook(
      ({ currentRequest }: { currentRequest: PreviewFokOrderRequest | null }) =>
        useFokOrderPreview({ client, request: currentRequest }),
      { initialProps },
    );

    await waitFor(() => expect(client.previewFokOrder).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(client.previewFokOrder).mock.calls[1]?.[1];
    rerender({ currentRequest: null });
    expect(result.current.status).toBe("idle");
    expect(signal?.aborted).toBe(true);

    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resetPending.resolve(fillableResponse);
      await Promise.resolve();
    });
  });

  it("preserves a nonfillable response instead of treating it as an error", async () => {
    const client: FokOrderPreviewClient = {
      previewFokOrder: vi.fn().mockResolvedValue(nonfillableResponse),
    };
    const { result } = renderHook(() => useFokOrderPreview({ client, request }));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.response).toBe(nonfillableResponse);
    expect(result.current.response?.reason).toBe("insufficient_liquidity");
    expect(result.current.error).toBeNull();
  });

  it("returns a coarse error and preserves Retry-After for 429", async () => {
    const client: FokOrderPreviewClient = {
      previewFokOrder: vi
        .fn()
        .mockRejectedValue(
          new EngineClientError(429, "private response detail", undefined, undefined, 17),
        ),
    };
    const { result } = renderHook(() => useFokOrderPreview({ client, request }));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Preview is temporarily rate limited.");
    expect(result.current.error).not.toContain("private response detail");
    expect(result.current.retryAfterSeconds).toBe(17);
    expect(result.current.response).toBeNull();
  });

  it("refreshes explicitly without changing request terms", async () => {
    const first = deferred<PreviewFokOrderResponse>();
    const second = deferred<PreviewFokOrderResponse>();
    const client: FokOrderPreviewClient = {
      previewFokOrder: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const { result } = renderHook(() => useFokOrderPreview({ client, request }));

    await waitFor(() => expect(client.previewFokOrder).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(fillableResponse);
      await Promise.resolve();
    });
    expect(result.current.response).toBe(fillableResponse);

    act(() => result.current.refresh());
    await waitFor(() => expect(client.previewFokOrder).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe("loading");
    expect(vi.mocked(client.previewFokOrder).mock.calls[1]?.[0]).toEqual(request);

    await act(async () => {
      second.resolve(nonfillableResponse);
      await Promise.resolve();
    });
    expect(result.current.response).toBe(nonfillableResponse);
  });
});
