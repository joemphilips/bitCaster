import { useCallback } from "react";
import type {
  PreviewFokOrderRequest,
  PreviewFokOrderResponse,
} from "@bitcaster/client-sdk/fokOrderPreview";
import { cooldownConditionForMarketId } from "./fokPreviewCooldown";
import {
  mapFokPreviewError,
  useFokPreviewRequest,
  type FokPreviewRequestState,
  type FokPreviewStatus,
  type UseFokPreviewRequestResult,
} from "./useFokPreviewRequest";

export interface FokOrderPreviewClient {
  previewFokOrder(
    request: PreviewFokOrderRequest,
    signal?: AbortSignal,
  ): Promise<PreviewFokOrderResponse>;
}

export type FokOrderPreviewStatus = FokPreviewStatus;
export interface FokOrderPreviewState extends FokPreviewRequestState<PreviewFokOrderResponse> {}

export interface UseFokOrderPreviewOptions {
  client: FokOrderPreviewClient;
  request: PreviewFokOrderRequest | null;
  /**
   * A bounded caller-owned identity for route, authentication, or market
   * revision changes. It invalidates the same economic request without
   * making the hook depend on an object with unstable identity.
   */
  invalidationKey?: string | number | null;
  /** Optional short input debounce. The default is immediate. */
  debounceMs?: number;
}

export interface UseFokOrderPreviewResult extends UseFokPreviewRequestResult<PreviewFokOrderResponse> {}

function previewRequestKey(request: PreviewFokOrderRequest): string {
  return [
    request.marketId,
    request.side,
    request.tokenSide,
    request.price,
    request.faceAmountSubunits,
  ].join("\u0000");
}

function snapshotPreviewRequest(request: PreviewFokOrderRequest): PreviewFokOrderRequest {
  return {
    marketId: request.marketId,
    side: request.side,
    tokenSide: request.tokenSide,
    price: request.price,
    faceAmountSubunits: request.faceAmountSubunits,
  };
}

export function useFokOrderPreview({
  client,
  request,
  invalidationKey = null,
  debounceMs = 0,
}: UseFokOrderPreviewOptions): UseFokOrderPreviewResult {
  const preview = useCallback(
    (requestSnapshot: PreviewFokOrderRequest, signal?: AbortSignal) =>
      client.previewFokOrder(requestSnapshot, signal),
    [client],
  );
  const requestKey = request === null ? null : previewRequestKey(request);
  const cooldownConditionId =
    request === null ? null : cooldownConditionForMarketId(request.marketId);

  return useFokPreviewRequest<PreviewFokOrderRequest, PreviewFokOrderResponse>({
    request,
    requestKey,
    cooldownConditionId,
    invalidationKey,
    debounceMs,
    snapshotRequest: snapshotPreviewRequest,
    preview,
    mapError: mapFokPreviewError,
  });
}
