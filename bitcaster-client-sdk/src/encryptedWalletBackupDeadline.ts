export class EncryptedWalletBackupDeadlineError extends Error {
  constructor() {
    super("encrypted backup cycle deadline exceeded");
    this.name = "EncryptedWalletBackupDeadlineError";
  }
}

export function requireEncryptedWalletBackupCycleSignal(
  callerSignal: AbortSignal,
): AbortSignal {
  return requireAbortSignal(callerSignal);
}

export function throwIfEncryptedWalletBackupCycleAborted(
  signal: AbortSignal,
): void {
  if (abortSignalIsAborted(requireAbortSignal(signal))) {
    throw new EncryptedWalletBackupDeadlineError();
  }
}

export function awaitEncryptedWalletBackupCycle<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const checked = requireAbortSignal(signal);
  if (abortSignalIsAborted(checked)) {
    return Promise.reject(new EncryptedWalletBackupDeadlineError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new EncryptedWalletBackupDeadlineError());
    ADD_EVENT_LISTENER.call(checked, "abort", abort, { once: true });
    promise.then(
      (value) => {
        REMOVE_EVENT_LISTENER.call(checked, "abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        REMOVE_EVENT_LISTENER.call(checked, "abort", abort);
        reject(error);
      },
    );
  });
}

export function requireEncryptedWalletBackupAbortSignal(
  value: unknown,
): Readonly<{ signal: AbortSignal; dispose(): void }> {
  return mirrorAbortSignal(requireAbortSignal(value));
}

const ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;

function abortSignalIsAborted(signal: AbortSignal): boolean {
  return ABORTED_GETTER?.call(signal) === true;
}

function requireAbortSignal(value: unknown): AbortSignal {
  if (typeof value !== "object" || value === null) {
    throw new Error("encrypted backup abort signal is invalid");
  }
  try {
    const aborted = ABORTED_GETTER?.call(value);
    if (typeof aborted !== "boolean")
      throw new Error("encrypted backup abort signal is invalid");
  } catch {
    throw new Error("encrypted backup abort signal is invalid");
  }
  return value as AbortSignal;
}

function mirrorAbortSignal(
  source: AbortSignal,
): Readonly<{ signal: AbortSignal; dispose(): void }> {
  const controller = new AbortController();
  let listening = false;
  const relay = (): void => {
    listening = false;
    controller.abort();
  };
  const dispose = (): void => {
    if (!listening) return;
    listening = false;
    REMOVE_EVENT_LISTENER.call(source, "abort", relay);
  };
  if (ABORTED_GETTER?.call(source) === true) {
    controller.abort();
  } else {
    ADD_EVENT_LISTENER.call(source, "abort", relay, { once: true });
    listening = true;
    if (ABORTED_GETTER?.call(source) === true) {
      dispose();
      controller.abort();
    }
  }
  return Object.freeze({ signal: controller.signal, dispose });
}
