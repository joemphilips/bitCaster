import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QRCodeSVG } from "qrcode.react";
import { selectNut16QrPresentation } from "@bitcaster/client-sdk/nut16Qr";
import { TokenDisplay } from "../TokenDisplay";

describe("NUT-16 static QR capacity", () => {
  it("accepts the 1,024 UTF-8 byte static boundary at QR level L", () => {
    const token = "cashuB" + "a".repeat(1_018);

    expect(new TextEncoder().encode(token)).toHaveLength(1_024);
    expect(selectNut16QrPresentation({ token, proofCount: 2 }).kind).toBe("static");
    expect(() => render(<QRCodeSVG value={token} size={256} level="L" />)).not.toThrow();
  });

  it("renders the first UR frame instead of a large animated token", () => {
    const token = "cashuB" + "a".repeat(61_000);

    expect(selectNut16QrPresentation({ token, proofCount: 3 }).kind).toBe("animated");
    expect(() =>
      render(<TokenDisplay token={token} amountSats={500} proofCount={3} />),
    ).not.toThrow();
  });
});
