import type { Settings } from "./Settings";

type SettingsComponent = typeof Settings;

let loaded: SettingsComponent | null = null;
let pending: Promise<SettingsComponent> | null = null;

/**
 * Start or join the single load of the lazy Settings chunk. A failed load
 * clears the shared promise, so the next request can start a new load.
 */
export function loadSettingsComponent(): Promise<SettingsComponent> {
  pending ??= import("./Settings").then(
    (module) => {
      loaded = module.Settings;
      return module.Settings;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}

/** The Settings component when its chunk has already loaded, otherwise null. */
export function loadedSettingsComponent(): SettingsComponent | null {
  return loaded;
}

/**
 * Load the Settings chunk when the browser becomes idle after the shell
 * renders. Without this, the first Settings visit fetches and evaluates the
 * chunk on demand, while start-up and login work use the network and the main
 * thread. Return a function that cancels a load that has not started.
 */
export function scheduleSettingsPreload(
  load: () => Promise<unknown> = loadSettingsComponent,
): () => void {
  // A failed preload changes nothing. The Settings visit starts a new load.
  const run = () => void load().catch(() => {});
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run);
    return () => window.cancelIdleCallback(handle);
  }
  // Safari has no idle callback. A zero timer still runs after the first render.
  const handle = window.setTimeout(run, 0);
  return () => window.clearTimeout(handle);
}
