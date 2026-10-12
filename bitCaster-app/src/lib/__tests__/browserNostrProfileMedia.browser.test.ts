import { expect, it } from "vitest";
import { normalizeBrowserProfileImage } from "../browserNostrProfileMedia";

function pngChunk(name: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(name), 4);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

it("decodes a real image, strips source metadata, and bounds the output dimensions", async () => {
  const source = document.createElement("canvas");
  source.width = 2048;
  source.height = 4;
  source.getContext("2d")!.fillRect(0, 0, 2048, 4);
  const png = await new Promise<Blob>((resolve, reject) =>
    source.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Fixture PNG failed")))),
  );
  const original = new Uint8Array(await png.arrayBuffer());
  const marker = "PrivateFixtureMetadataNeverUpload";
  const metadata = pngChunk("tEXt", new TextEncoder().encode(`Comment\0${marker}`));
  // Insert a valid ancillary chunk before IEND. Use actual browser decoding.
  const withMetadata = new Uint8Array(original.length + metadata.length);
  withMetadata.set(original.subarray(0, -12));
  withMetadata.set(metadata, original.length - 12);
  withMetadata.set(original.subarray(-12), original.length - 12 + metadata.length);
  expect(new TextDecoder().decode(withMetadata).includes(marker)).toBe(true);
  const result = await normalizeBrowserProfileImage(
    new File([withMetadata], "avatar.png", { type: "image/png" }),
    new AbortController().signal,
  );
  expect(result.width).toBe(1024);
  expect(result.height).toBe(2);
  expect(new TextDecoder().decode(result.bytes).includes(marker)).toBe(false);
  const decoded = await createImageBitmap(
    new Blob([Uint8Array.from(result.bytes)], { type: result.type }),
  );
  try {
    expect(decoded.width).toBe(1024);
    expect(decoded.height).toBe(2);
  } finally {
    decoded.close();
  }
});
