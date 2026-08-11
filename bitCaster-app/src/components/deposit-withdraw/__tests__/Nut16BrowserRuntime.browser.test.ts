import { describe, expect, it } from "vitest";

// This public testnet fixture is permanently spent. Never use an unspent
// bearer token as a source fixture.
const VALID_SPENT_TOKEN =
  "cashuBo2F0gaJhaUgBiEp0uy_F7mFwhKNhYRBhc3hAMGE3ZDg3OWY4ZGY2OTRkY2RiMjc5NGQ0YzQ3ZDNhMjI4ODk3YzBiNWQ0MjhkMTFkYmJlZDQ5N2JjYTEzMGUyYmFjWCEC6E46HGmFL4V0zCB44J5iA4tFstICSsuTnj_4caoMXXSjYWEQYXN4QDM0OWJiZGQ1YjMyNjVlZWFjYTA0MGUyNGExZGQ0MmNlNTUxMDIzYmEyOTE4MzliZmM2Yjg0ZWRiMTdlZDExMDJhY1ghA-XD2T9-GXjmTgeXfVa1Xj-HuAVvnzVINliMHhhFqD3ao2FhEGFzeEA0ZDhmYzEzMTQzNmMyNzBkNDNjYmZjMmRkMjQ3MTlhZDM5Yjc2MzJmZGFiNTJhMWY0ODk0Y2U5MGNiYTU4NjgwYWNYIQIhQapBCpm5NWU0uwjNHqQBoVAFF2PxGmo1l9NpV20fs6NhYQJhc3hAYmRjNDg3NjQyN2Y2YWZjZjlmNjg1ODllNjIxNTg5ODkwNDQ3NWRjODU2OGZjOTYyOWYzZTcxODQzZjQ5ZTk4NWFjWCED4y_imdNoYT_5Uy8C8HH90nzU7DXWEG7xZLXlFsn_27VhbXgbaHR0cHM6Ly90ZXN0bnV0LmNhc2h1LnNwYWNlYXVjc2F0";

describe("NUT-16 browser runtime", () => {
  it("round-trips a valid Cashu token in Chromium", async () => {
    expect(navigator.userAgent).toContain("HeadlessChrome");

    const { Nut16AnimatedQrEncoder, Nut16UrDecoderSession } =
      await import("@bitcaster/client-sdk/nut16Qr");
    const encoder = new Nut16AnimatedQrEncoder(VALID_SPENT_TOKEN, 4);
    const frames = Array.from({ length: 16 }, () => encoder.nextFrame());
    const decoder = new Nut16UrDecoderSession();
    let completed = false;

    for (const frame of frames.reverse()) {
      const result = decoder.receive(frame);
      if (result.status === "complete") {
        expect(result.token).toBe(VALID_SPENT_TOKEN);
        completed = true;
        break;
      }
    }

    expect(completed).toBe(true);
  });
});
