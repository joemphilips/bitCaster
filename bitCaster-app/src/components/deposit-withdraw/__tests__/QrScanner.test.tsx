import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const qrScannerMock = vi.hoisted(() => {
  const instances: Array<{
    callback: (result: { data: string }) => void;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];

  class MockQrScanner {
    readonly start = vi.fn();
    readonly stop = vi.fn();
    readonly destroy = vi.fn();

    constructor(
      _video: HTMLVideoElement,
      readonly callback: (result: { data: string }) => void,
    ) {
      instances.push(this);
    }
  }

  return { instances, MockQrScanner };
});

const nut16Mock = vi.hoisted(() => {
  const sessions: Array<{
    receive: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
  }> = [];

  class MockNut16UrDecoderSession {
    readonly receive = vi.fn();
    readonly expire = vi.fn();

    constructor() {
      sessions.push(this);
    }
  }

  return { sessions, MockNut16UrDecoderSession };
});

vi.mock("qr-scanner", () => ({ default: qrScannerMock.MockQrScanner }));
vi.mock("@bitcaster/client-sdk/nut16Qr", () => ({
  Nut16UrDecoderSession: nut16Mock.MockNut16UrDecoderSession,
}));

import { QrScannerView } from "../QrScanner";

function latestScanner() {
  const scanner = qrScannerMock.instances.at(-1);
  if (!scanner) throw new Error("Expected a QR scanner instance");
  return scanner;
}

function latestDecoder() {
  const decoder = nut16Mock.sessions.at(-1);
  if (!decoder) throw new Error("Expected a NUT-16 decoder instance");
  return decoder;
}

function scan(data: string) {
  act(() => {
    latestScanner().callback({ data });
  });
}

afterEach(() => {
  cleanup();
  qrScannerMock.instances.length = 0;
  nut16Mock.sessions.length = 0;
  vi.useRealTimers();
});

describe("QrScannerView", () => {
  it("starts the camera scanner and destroys it on cleanup", () => {
    const { unmount } = render(<QrScannerView onDecode={vi.fn()} onClose={vi.fn()} />);
    const scanner = latestScanner();

    expect(scanner.start).toHaveBeenCalledOnce();

    unmount();

    expect(scanner.destroy).toHaveBeenCalledOnce();
  });

  it("hands an ordinary static token to the caller once", () => {
    const onDecode = vi.fn();
    render(<QrScannerView onDecode={onDecode} onClose={vi.fn()} />);
    const scanner = latestScanner();

    scan("  cashuB-static-token  ");
    scan("cashuB-second-token");

    expect(scanner.stop).toHaveBeenCalledOnce();
    expect(onDecode).toHaveBeenCalledTimes(1);
    expect(onDecode).toHaveBeenCalledWith("cashuB-static-token");
    expect(nut16Mock.sessions[0]?.receive).not.toHaveBeenCalled();
  });

  it("shows animated progress and hands off the exact completed token once", () => {
    const onDecode = vi.fn();
    render(<QrScannerView onDecode={onDecode} onClose={vi.fn()} />);
    const scanner = latestScanner();
    const decoder = latestDecoder();
    const completedToken = "cashuB-completed-token-exact";
    decoder.receive
      .mockReturnValueOnce({ status: "accepted", progress: 0.5 })
      .mockReturnValueOnce({ status: "complete", progress: 1, token: completedToken });

    scan("ur:bytes/1-2/first-frame");
    expect(screen.getByText("50%")).toBeInTheDocument();

    scan("ur:bytes/2-2/second-frame");
    scan("ur:bytes/2-2/second-frame");

    expect(scanner.stop).toHaveBeenCalledOnce();
    expect(onDecode).toHaveBeenCalledTimes(1);
    expect(onDecode).toHaveBeenCalledWith(completedToken);
    expect(decoder.receive).toHaveBeenCalledTimes(2);
  });

  it("stops and reports a rejected animated QR sequence", () => {
    const onDecode = vi.fn();
    render(<QrScannerView onDecode={onDecode} onClose={vi.fn()} />);
    const scanner = latestScanner();
    latestDecoder().receive.mockReturnValue({
      status: "rejected",
      progress: 0.25,
      code: "corrupt_fragment",
    });

    scan("ur:bytes/1-2/corrupt-frame");

    expect(scanner.stop).toHaveBeenCalledOnce();
    expect(onDecode).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The animated QR code is invalid or incomplete.",
    );
  });

  it("stops the scanner when a no-frame session expires and destroys it on cleanup", () => {
    vi.useFakeTimers();
    const { unmount } = render(<QrScannerView onDecode={vi.fn()} onClose={vi.fn()} />);
    const scanner = latestScanner();
    latestDecoder().expire.mockReturnValue({
      status: "rejected",
      progress: 0,
      code: "session_timeout",
    });

    act(() => {
      vi.advanceTimersByTime(120_001);
    });

    expect(scanner.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The animated QR scan timed out. Close and scan again.",
    );

    unmount();
    expect(scanner.destroy).toHaveBeenCalledOnce();
  });

  it("allows only one active camera scanner", () => {
    render(<QrScannerView onDecode={vi.fn()} onClose={vi.fn()} />);
    render(<QrScannerView onDecode={vi.fn()} onClose={vi.fn()} />);

    expect(qrScannerMock.instances).toHaveLength(1);
    expect(latestScanner().start).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Another QR scan is already active.");
  });
});
