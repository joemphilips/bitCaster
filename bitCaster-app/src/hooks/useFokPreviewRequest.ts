import { useCallback, useEffect, useRef, useState } from "react";
import { EngineClientError } from "@bitcaster/client-sdk/engineClient";
import { cooldownDelayMs, recordCooldown } from "./fokPreviewCooldown";

export type FokPreviewStatus = "idle" | "loading" | "ready" | "error";

export interface FokPreviewRequestState<TResponse> {
  status: FokPreviewStatus;
  requestKey: string | null;
  response: TResponse | null;
  error: string | null;
  retryAfterSeconds: number | null;
}

export interface UseFokPreviewRequestResult<TResponse> extends FokPreviewRequestState<TResponse> {
  refresh: () => void;
}

export interface UseFokPreviewRequestOptions<TRequest, TResponse> {
  request: TRequest | null;
  requestKey: string | null;
  cooldownConditionId: string | null;
  invalidationKey?: string | number | null;
  debounceMs?: number;
  snapshotRequest: (request: TRequest) => TRequest;
  preview: (request: TRequest, signal?: AbortSignal) => Promise<TResponse>;
  mapError: (
    error: unknown,
  ) => Pick<FokPreviewRequestState<TResponse>, "error" | "retryAfterSeconds">;
}

interface InternalFokPreviewRequestState<TResponse> extends FokPreviewRequestState<TResponse> {
  inputIdentity: string | null;
}

const IDLE_STATE: InternalFokPreviewRequestState<never> = {
  status: "idle",
  requestKey: null,
  response: null,
  error: null,
  retryAfterSeconds: null,
  inputIdentity: null,
};

export function normalizedFokPreviewDebounceMs(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), 250);
}

export function isFokPreviewAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function mapFokPreviewError<TResponse>(
  error: unknown,
): Pick<FokPreviewRequestState<TResponse>, "error" | "retryAfterSeconds"> {
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

export function useFokPreviewRequest<TRequest, TResponse>({
  request,
  requestKey,
  cooldownConditionId,
  invalidationKey = null,
  debounceMs = 0,
  snapshotRequest,
  preview,
  mapError,
}: UseFokPreviewRequestOptions<TRequest, TResponse>): UseFokPreviewRequestResult<TResponse> {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<InternalFokPreviewRequestState<TResponse>>(
    IDLE_STATE as InternalFokPreviewRequestState<TResponse>,
  );
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const delayMs = normalizedFokPreviewDebounceMs(debounceMs);
  const invalidationIdentity = `${typeof invalidationKey}:${String(invalidationKey)}`;
  const inputIdentity =
    requestKey === null
      ? null
      : `${requestKey}\u0000${invalidationIdentity}\u0000${refreshVersion}`;

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

    if (request === null || requestKey === null || inputIdentity === null) {
      setState(IDLE_STATE as InternalFokPreviewRequestState<TResponse>);
      return;
    }

    const requestSnapshot = snapshotRequest(request);
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (waitMs: number) => {
      timer = setTimeout(() => {
        timer = undefined;
        void run();
      }, waitMs);
    };
    const run = async () => {
      if (!isCurrent()) return;
      const remainingCooldownMs = cooldownDelayMs(cooldownConditionId);
      if (remainingCooldownMs > 0) {
        schedule(remainingCooldownMs);
        return;
      }
      try {
        const response = await preview(requestSnapshot, controller.signal);
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
        if (!isCurrent() || controller.signal.aborted || isFokPreviewAbortError(error)) return;
        const mappedError = mapError(error);
        if (error instanceof EngineClientError && error.status === 429) {
          recordCooldown(cooldownConditionId, mappedError.retryAfterSeconds);
        }
        setState({
          status: "error",
          requestKey,
          response: null,
          ...mappedError,
          inputIdentity,
        });
      }
    };

    const waitMs = Math.max(delayMs, cooldownDelayMs(cooldownConditionId));
    if (waitMs > 0) schedule(waitMs);
    else void run();

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [cooldownConditionId, delayMs, inputIdentity, mapError, preview, requestKey, snapshotRequest]);

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
