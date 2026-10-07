import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineClientError } from "@bitcaster/client-sdk/engineClient";
import type {
  PreviewFokOrderCapacityRequest,
  PreviewFokOrderCapacityResponse,
  PreviewFokOrderRequest,
  PreviewFokOrderResponse,
} from "@bitcaster/client-sdk/fokOrderPreview";
import {
  useFokOrderCapacityPreview,
  type FokOrderCapacityPreviewClient,
} from "../useFokOrderCapacityPreview";
import { useFokOrderPreview, type FokOrderPreviewClient } from "../useFokOrderPreview";
import { clearFokPreviewCooldownsForTests } from "../fokPreviewCooldown";

const request: PreviewFokOrderCapacityRequest = {
  marketId: "capacity-condition-Yes",
  side: "Buy",
  tokenSide: "Outcome",
};

const executableCapacity: PreviewFokOrderCapacityResponse = {
  status: "ready",
  referencePrice: 500,
  effectiveLimitPrice: 700,
  maxFaceAmountSubunits: 1_000,
  quotePaymentSubunits: 500,
  worstPrice: 500,
  priceDenominator: 1_000,
  previewRevision: "revision-1",
};

const emptyCapacity: PreviewFokOrderCapacityResponse = {
  status: "ready",
  referencePrice: null,
  effectiveLimitPrice: null,
  maxFaceAmountSubunits: 0,
  quotePaymentSubunits: 0,
  worstPrice: null,
  priceDenominator: 1_000,
  previewRevision: "revision-2",
};

const unavailableCapacity: PreviewFokOrderCapacityResponse = {
  status: "temporarily_unavailable",
  referencePrice: null,
  effectiveLimitPrice: null,
  maxFaceAmountSubunits: null,
  quotePaymentSubunits: null,
  worstPrice: null,
  priceDenominator: null,
  previewRevision: null,
};

const exactRequest: PreviewFokOrderRequest = {
  ...request,
  price: 700,
  faceAmountSubunits: 1_000,
};

const exactResponse: PreviewFokOrderResponse = {
  fullFillAvailable: true,
  reason: "fillable",
  previewRevision: "revision-1",
  quotePaymentSubunits: 500,
  averagePrice: 500,
  worstPrice: 500,
  currentLatestTradePrice: 500,
  projectedFinalPrice: 500,
  priceDenominator: 1_000,
  subsidyMayHelp: false,
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

describe("useFokOrderCapacityPreview", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearFokPreviewCooldownsForTests();
  });

  it("preserves an omitted Auto price and reloads after the invalidation identity changes", async () => {
    const first = deferred<PreviewFokOrderCapacityResponse>();
    const second = deferred<PreviewFokOrderCapacityResponse>();
    const client: FokOrderCapacityPreviewClient = {
      previewFokOrderCapacity: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) =>
        useFokOrderCapacityPreview({ client, request, invalidationKey: identity }),
      { initialProps: { identity: "revision-a" } },
    );

    await waitFor(() => expect(client.previewFokOrderCapacity).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.previewFokOrderCapacity).mock.calls[0]?.[0]).toEqual(request);
    expect(vi.mocked(client.previewFokOrderCapacity).mock.calls[0]?.[0]).not.toHaveProperty(
      "price",
    );

    rerender({ identity: "revision-b" });
    await waitFor(() => expect(client.previewFokOrderCapacity).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe("loading");

    await act(async () => {
      second.resolve(executableCapacity);
      await Promise.resolve();
    });
    expect(result.current.response).toBe(executableCapacity);
  });

  it("hides stale capacity while a changed Custom limit replaces an aborted request", async () => {
    const first = deferred<PreviewFokOrderCapacityResponse>();
    const second = deferred<PreviewFokOrderCapacityResponse>();
    const client: FokOrderCapacityPreviewClient = {
      previewFokOrderCapacity: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const { result, rerender } = renderHook(
      ({ currentRequest }: { currentRequest: PreviewFokOrderCapacityRequest }) =>
        useFokOrderCapacityPreview({ client, request: currentRequest }),
      { initialProps: { currentRequest: request } },
    );

    await waitFor(() => expect(client.previewFokOrderCapacity).toHaveBeenCalledTimes(1));
    const firstSignal = vi.mocked(client.previewFokOrderCapacity).mock.calls[0]?.[1];
    rerender({ currentRequest: { ...request, price: 700 } });
    await waitFor(() => expect(client.previewFokOrderCapacity).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.response).toBeNull();

    await act(async () => {
      first.resolve(emptyCapacity);
      await Promise.resolve();
    });
    expect(result.current.response).toBeNull();

    await act(async () => {
      second.resolve(executableCapacity);
      await Promise.resolve();
    });
    expect(result.current.response).toBe(executableCapacity);
  });

  it("keeps zero executable capacity distinct from an unavailable snapshot", async () => {
    const client: FokOrderCapacityPreviewClient = {
      previewFokOrderCapacity: vi
        .fn()
        .mockResolvedValueOnce(emptyCapacity)
        .mockResolvedValueOnce(unavailableCapacity),
    };
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) =>
        useFokOrderCapacityPreview({ client, request, invalidationKey: identity }),
      { initialProps: { identity: "empty" } },
    );

    await waitFor(() => expect(result.current.response).toBe(emptyCapacity));
    expect(result.current.response?.maxFaceAmountSubunits).toBe(0);
    expect(result.current.response?.quotePaymentSubunits).toBe(0);

    rerender({ identity: "unavailable" });
    await waitFor(() => expect(result.current.response).toBe(unavailableCapacity));
    expect(result.current.response?.maxFaceAmountSubunits).toBeNull();
    expect(result.current.response?.quotePaymentSubunits).toBeNull();
  });

  it("shares a condition cooldown with the exact preview", async () => {
    vi.useFakeTimers();
    const capacityClient: FokOrderCapacityPreviewClient = {
      previewFokOrderCapacity: vi
        .fn()
        .mockRejectedValue(
          new EngineClientError(429, "private response detail", undefined, undefined, 3),
        ),
    };
    const exactClient: FokOrderPreviewClient = {
      previewFokOrder: vi.fn().mockResolvedValue(exactResponse),
    };
    const capacity = renderHook(() =>
      useFokOrderCapacityPreview({ client: capacityClient, request }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(capacity.result.current.error).toBe("Preview is temporarily rate limited.");

    const exact = renderHook(() =>
      useFokOrderPreview({ client: exactClient, request: exactRequest }),
    );
    expect(exactClient.previewFokOrder).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2_999);
      await Promise.resolve();
    });
    expect(exactClient.previewFokOrder).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(exactClient.previewFokOrder).toHaveBeenCalledTimes(1);
    expect(exact.result.current.response).toBe(exactResponse);
  });

  it("defers a queued capacity request when the exact preview starts a cooldown", async () => {
    vi.useFakeTimers();
    const capacityClient: FokOrderCapacityPreviewClient = {
      previewFokOrderCapacity: vi.fn().mockResolvedValue(executableCapacity),
    };
    const exactClient: FokOrderPreviewClient = {
      previewFokOrder: vi
        .fn()
        .mockRejectedValue(
          new EngineClientError(429, "private response detail", undefined, undefined, 3),
        ),
    };
    renderHook(() =>
      useFokOrderCapacityPreview({ client: capacityClient, request, debounceMs: 20 }),
    );
    renderHook(() => useFokOrderPreview({ client: exactClient, request: exactRequest }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(exactClient.previewFokOrder).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_999);
      await Promise.resolve();
    });
    expect(capacityClient.previewFokOrderCapacity).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(capacityClient.previewFokOrderCapacity).toHaveBeenCalledTimes(1);
  });

  it("does not poll an unchanged request and aborts it on unmount", async () => {
    vi.useFakeTimers();
    const pending = deferred<PreviewFokOrderCapacityResponse>();
    const client: FokOrderCapacityPreviewClient = {
      previewFokOrderCapacity: vi.fn().mockReturnValue(pending.promise),
    };
    const mounted = renderHook(() => useFokOrderCapacityPreview({ client, request }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(client.previewFokOrderCapacity).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(client.previewFokOrderCapacity).mock.calls[0]?.[1];

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(client.previewFokOrderCapacity).toHaveBeenCalledTimes(1);

    mounted.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
