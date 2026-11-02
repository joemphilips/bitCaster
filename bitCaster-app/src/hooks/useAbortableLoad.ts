import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "unavailable" };

const LOADING = { status: "loading" } as const;

/**
 * Load once for each key. A key change or unmount aborts the previous load,
 * and a late result from an aborted load never replaces the current state.
 */
export function useAbortableLoad<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
): Loadable<T> {
  const [state, setState] = useState<{ key: string; value: Loadable<T> } | null>(null);
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    const controller = new AbortController();
    const settle = (value: Loadable<T>) => {
      if (!controller.signal.aborted) setState({ key, value });
    };
    Promise.resolve()
      .then(() => loadRef.current(controller.signal))
      .then(
        (value) => settle({ status: "ready", value }),
        () => settle({ status: "unavailable" }),
      );
    return () => controller.abort();
  }, [key]);
  return state?.key === key ? state.value : LOADING;
}
