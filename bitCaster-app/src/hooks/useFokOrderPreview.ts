import { useCallback, useEffect, useRef, useState } from "react";
import { EngineClientError } from "@bitcaster/client-sdk/engineClient";
import type {
  PreviewFokOrderRequest,
  PreviewFokOrderResponse,
} from "@bitcaster/client-sdk/fokOrderPreview";

export interface FokOrderPreviewClient {
  previewFokOrder(
    request: PreviewFokOrderRequest,
    signal?: AbortSignal,
  ): Promise<PreviewFokOrderResponse>;
}

export type FokOrderPreviewStatus = "idle" | "loading" | "ready" | "error";

export interface FokOrderPreviewState {
  status: FokOrderPreviewStatus;
  requestKey: string | null;
  response: PreviewFokOrderResponse | null;
  error: string | null;
  retryAfterSeconds: number | null;
}

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

export interface UseFokOrderPreviewResult extends FokOrderPreviewState {
  refresh: () => void;
}

interface InternalFokOrderPreviewState extends FokOrderPreviewState {
  inputIdentity: string | null;
}

const IDLE_STATE: InternalFokOrderPreviewState = {
  status: "idle",
  requestKey: null,
  response: null,
  error: null,
  retryAfterSeconds: null,
  inputIdentity: null,
};

function previewRequestKey(request: PreviewFokOrderRequest): string {
  return [
    request.marketId,
    request.side,
    request.tokenSide,
    request.price,
    request.faceAmountSubunits,
  ].join("\u0000");
}

function snapshotPreviewRequest(
  request: PreviewFokOrderRequest | null,
): PreviewFokOrderRequest | null {
  if (request === null) return null;
  return {
    marketId: request.marketId,
    side: request.side,
    tokenSide: request.tokenSide,
    price: request.price,
    faceAmountSubunits: request.faceAmountSubunits,
  };
}

function normalizedDebounceMs(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), 250);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function mapPreviewError(
  error: unknown,
): Pick<FokOrderPreviewState, "error" | "retryAfterSeconds"> {
  if (error instanceof EngineClientError && error.status === 429) {
    return {
      error: "Preview is temporarily rate limited.",
      retryAfterSeconds: error.retryAfterSeconds ?? null,
    };
  }
  if (error instanceof EngineClientError && error.status >= 400 && error.status < 500) {
    return {
      error: "Preview request was rejected.",
      retryAfterSeconds: null,
    };
  }
  return {
    error: "Preview is temporarily unavailable.",
    retryAfterSeconds: null,
  };
}

export function useFokOrderPreview({
  client,
  request,
  invalidationKey = null,
  debounceMs = 0,
}: UseFokOrderPreviewOptions): UseFokOrderPreviewResult {
  const marketId = request?.marketId ?? null;
  const side = request?.side ?? null;
  const tokenSide = request?.tokenSide ?? null;
  const price = request?.price ?? null;
  const faceAmountSubunits = request?.faceAmountSubunits ?? null;
  const requestSnapshot = snapshotPreviewRequest(request);
  const requestKey = requestSnapshot === null ? null : previewRequestKey(requestSnapshot);
  const delayMs = normalizedDebounceMs(debounceMs);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<InternalFokOrderPreviewState>(IDLE_STATE);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const inputIdentity =
    requestKey === null
      ? null
      : `${requestKey}\u0000${typeof invalidationKey}:${String(invalidationKey)}\u0000${refreshVersion}`;

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    if (requestSnapshot === null || requestKey === null || inputIdentity === null) {
      setState(IDLE_STATE);
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () =>
      mountedRef.current && generationRef.current === generation && !controller.signal.aborted;

    setState({
      status: "loading",
      requestKey,
      response: null,
      error: null,
      retryAfterSeconds: null,
      inputIdentity,
    });

    const run = async () => {
      try {
        const response = await client.previewFokOrder(requestSnapshot, controller.signal);
        if (!isCurrent()) return;
        setState({
          status: "ready",
          requestKey,
          response,
          error: null,
          retryAfterSeconds: null,
          inputIdentity,
        });
      } catch (error) {
        if (!isCurrent() || controller.signal.aborted || isAbortError(error)) return;
        setState({
          status: "error",
          requestKey,
          response: null,
          ...mapPreviewError(error),
          inputIdentity,
        });
      }
    };

    const timer = delayMs > 0 ? setTimeout(() => void run(), delayMs) : undefined;
    if (timer === undefined) void run();

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [
    client,
    delayMs,
    faceAmountSubunits,
    inputIdentity,
    marketId,
    price,
    requestKey,
    side,
    tokenSide,
  ]);

  if (state.inputIdentity !== inputIdentity) {
    return {
      status: requestKey === null ? "idle" : "loading",
      requestKey,
      response: null,
      error: null,
      retryAfterSeconds: null,
      refresh,
    };
  }
  const { inputIdentity: _inputIdentity, ...publicState } = state;
  return { ...publicState, refresh };
}
