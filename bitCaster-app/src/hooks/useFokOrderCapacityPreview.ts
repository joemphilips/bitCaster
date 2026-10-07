import { useCallback } from "react";
import type {
  PreviewFokOrderCapacityRequest,
  PreviewFokOrderCapacityResponse,
} from "@bitcaster/client-sdk/fokOrderPreview";
import { cooldownConditionForMarketId } from "./fokPreviewCooldown";
import {
  mapFokPreviewError,
  useFokPreviewRequest,
  type FokPreviewRequestState,
  type FokPreviewStatus,
  type UseFokPreviewRequestResult,
} from "./useFokPreviewRequest";

export interface FokOrderCapacityPreviewClient {
  previewFokOrderCapacity(
    request: PreviewFokOrderCapacityRequest,
    signal?: AbortSignal,
  ): Promise<PreviewFokOrderCapacityResponse>;
}

export type FokOrderCapacityPreviewStatus = FokPreviewStatus;
export interface FokOrderCapacityPreviewState extends FokPreviewRequestState<PreviewFokOrderCapacityResponse> {}

export interface UseFokOrderCapacityPreviewOptions {
  client: FokOrderCapacityPreviewClient;
  request: PreviewFokOrderCapacityRequest | null;
  invalidationKey?: string | number | null;
  debounceMs?: number;
}

export interface UseFokOrderCapacityPreviewResult extends UseFokPreviewRequestResult<PreviewFokOrderCapacityResponse> {}

function capacityRequestKey(request: PreviewFokOrderCapacityRequest): string {
  return [request.marketId, request.side, request.tokenSide, request.price ?? "auto"].join(
    "\u0000",
  );
}

function snapshotCapacityRequest(
  request: PreviewFokOrderCapacityRequest,
): PreviewFokOrderCapacityRequest {
  return {
    marketId: request.marketId,
    side: request.side,
    tokenSide: request.tokenSide,
    ...(request.price === undefined ? {} : { price: request.price }),
  };
}

export function useFokOrderCapacityPreview({
  client,
  request,
  invalidationKey = null,
  debounceMs = 0,
}: UseFokOrderCapacityPreviewOptions): UseFokOrderCapacityPreviewResult {
  const preview = useCallback(
    (requestSnapshot: PreviewFokOrderCapacityRequest, signal?: AbortSignal) =>
      client.previewFokOrderCapacity(requestSnapshot, signal),
    [client],
  );
  const requestKey = request === null ? null : capacityRequestKey(request);
  const cooldownConditionId =
    request === null ? null : cooldownConditionForMarketId(request.marketId);

  return useFokPreviewRequest<PreviewFokOrderCapacityRequest, PreviewFokOrderCapacityResponse>({
    request,
    requestKey,
    cooldownConditionId,
    invalidationKey,
    debounceMs,
    snapshotRequest: snapshotCapacityRequest,
    preview,
    mapError: mapFokPreviewError,
  });
}
