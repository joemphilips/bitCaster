import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const nut16Mock = vi.hoisted(() => {
  const selectNut16QrPresentation = vi.fn();
  const nextFrame = vi.fn();
  const Nut16AnimatedQrEncoder = vi.fn(function () {
    return { nextFrame };
  });

  return { selectNut16QrPresentation, nextFrame, Nut16AnimatedQrEncoder };
});

vi.mock("@bitcaster/client-sdk/nut16Qr", () => nut16Mock);
vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <svg data-testid="token-qr" data-value={value} />,
}));

import { TokenDisplay } from "../TokenDisplay";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("TokenDisplay NUT-16 QR presentation", () => {
  it("uses static presentation without constructing an animated encoder", () => {
    nut16Mock.selectNut16QrPresentation.mockReturnValue({ kind: "static", encodedBytes: 12 });

    render(<TokenDisplay token="cashuB-static" amountSats={500} proofCount={2} />);

    expect(nut16Mock.selectNut16QrPresentation).toHaveBeenCalledWith({
      token: "cashuB-static",
      proofCount: 2,
    });
    expect(nut16Mock.Nut16AnimatedQrEncoder).not.toHaveBeenCalled();
    expect(screen.getByTestId("token-qr")).toHaveAttribute("data-value", "cashuB-static");
  });

  it("uses an animated encoder lazily and advances one frame per interval", () => {
    vi.useFakeTimers();
    nut16Mock.selectNut16QrPresentation.mockReturnValue({ kind: "animated", encodedBytes: 2_000 });
    nut16Mock.nextFrame
      .mockReturnValueOnce("ur:bytes/first")
      .mockReturnValueOnce("ur:bytes/second");

    render(<TokenDisplay token="cashuB-large" amountSats={500} proofCount={3} />);

    expect(nut16Mock.Nut16AnimatedQrEncoder).toHaveBeenCalledWith("cashuB-large", 3);
    expect(nut16Mock.nextFrame).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("token-qr")).toHaveAttribute("data-value", "ur:bytes/first");

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(nut16Mock.nextFrame).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("token-qr")).toHaveAttribute("data-value", "ur:bytes/second");
  });

  it("copies the full original token, not the animated frame", async () => {
    nut16Mock.selectNut16QrPresentation.mockReturnValue({ kind: "animated", encodedBytes: 2_000 });
    nut16Mock.nextFrame.mockReturnValue("ur:bytes/frame");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const token = "cashuB-complete-original-token";

    render(<TokenDisplay token={token} amountSats={500} proofCount={3} />);
    const buttons = screen.getAllByRole("button");
    await userEvent.click(buttons.at(-1)!);

    expect(writeText).toHaveBeenCalledWith(token);
  });

  it("clears the animated interval on cleanup", () => {
    vi.useFakeTimers();
    nut16Mock.selectNut16QrPresentation.mockReturnValue({ kind: "animated", encodedBytes: 2_000 });
    nut16Mock.nextFrame.mockReturnValue("ur:bytes/frame");
    const { unmount } = render(
      <TokenDisplay token="cashuB-large" amountSats={500} proofCount={3} />,
    );

    unmount();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(nut16Mock.nextFrame).toHaveBeenCalledTimes(1);
  });
});
