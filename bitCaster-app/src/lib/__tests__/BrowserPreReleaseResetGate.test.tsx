import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrowserPreReleaseResetGate } from "../BrowserPreReleaseResetGate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("BrowserPreReleaseResetGate", () => {
  it("does not mount recovery workers until an already-reset profile is ready", async () => {
    const reset = deferred<boolean>();
    const recoveryWorker = vi.fn();
    function RecoveryWorker() {
      recoveryWorker();
      return <div>recovery worker</div>;
    }

    render(
      <BrowserPreReleaseResetGate reset={() => reset.promise}>
        <RecoveryWorker />
      </BrowserPreReleaseResetGate>,
    );
    expect(recoveryWorker).not.toHaveBeenCalled();

    await act(async () => reset.resolve(false));
    await waitFor(() => expect(recoveryWorker).toHaveBeenCalledOnce());
    expect(screen.getByText("recovery worker")).toBeInTheDocument();
  });

  it("does not mount recovery workers when the reset rejects", async () => {
    const recoveryWorker = vi.fn();
    function RecoveryWorker() {
      recoveryWorker();
      return null;
    }

    render(
      <BrowserPreReleaseResetGate reset={async () => Promise.reject(new Error("reset failed"))}>
        <RecoveryWorker />
      </BrowserPreReleaseResetGate>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("browser profile reset failed");
    expect(recoveryWorker).not.toHaveBeenCalled();
  });

  it("reloads after a successful reset before recovery workers mount", async () => {
    const reset = deferred<boolean>();
    const reload = vi.fn();
    const recoveryWorker = vi.fn();
    function RecoveryWorker() {
      recoveryWorker();
      return null;
    }

    render(
      <BrowserPreReleaseResetGate reset={() => reset.promise} reload={reload}>
        <RecoveryWorker />
      </BrowserPreReleaseResetGate>,
    );
    await act(async () => reset.resolve(true));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(recoveryWorker).not.toHaveBeenCalled();
  });
});
