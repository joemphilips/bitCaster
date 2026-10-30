import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeBrowserProfileImage } from "../browserNostrProfileMedia";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pngFile(width = 2000, height = 1000) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  const file = new File([bytes], "synthetic.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  return file;
}

function decode(width = 2000, height = 1000) {
  const close = vi.fn();
  const draw = vi.fn();
  const bitmap = { width, height, close };
  const create = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal("createImageBitmap", create);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
    callback({
      type: "image/png",
      size: 3,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as Blob),
  );
  return { close, draw, bitmap, create, toBlob };
}

describe("profile image browser normalization", () => {
  it("decodes, scales with aspect ratio, and sends only newly encoded pixels", async () => {
    const fixture = decode();
    const output = await normalizeBrowserProfileImage(pngFile(), new AbortController().signal);
    expect(output).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      type: "image/png",
      width: 1024,
      height: 512,
    });
    expect(fixture.draw).toHaveBeenCalledWith(fixture.bitmap, 0, 0, 1024, 512);
    expect(fixture.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it.each(["image/svg+xml", "text/plain"])("rejects %s without decoding", async (type) => {
    const fixture = decode();
    await expect(
      normalizeBrowserProfileImage(
        new File(["bad"], "file", { type }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-image" });
    expect(fixture.create).not.toHaveBeenCalled();
  });
  it("rejects oversized bytes before decoding", async () => {
    const fixture = decode();
    await expect(
      normalizeBrowserProfileImage(
        { type: "image/png", size: 5 * 1024 * 1024 + 1 } as File,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-image" });
    expect(fixture.create).not.toHaveBeenCalled();
  });
  it("rejects oversized header dimensions before decoding", async () => {
    const fixture = decode();
    await expect(
      normalizeBrowserProfileImage(pngFile(4001, 4000), new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-image" });
    expect(fixture.create).not.toHaveBeenCalled();
  });
  it("rejects oversized decoded images and releases the bitmap", async () => {
    const fixture = decode(4001, 4000);
    await expect(
      normalizeBrowserProfileImage(pngFile(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-image" });
    expect(fixture.draw).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("rejects undecodable content", async () => {
    const fixture = decode();
    fixture.create.mockRejectedValue(new Error("decode"));
    await expect(
      normalizeBrowserProfileImage(pngFile(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-image" });
  });
  it("rejects oversized normalized output", async () => {
    const fixture = decode();
    fixture.toBlob.mockImplementation((callback) =>
      callback({ type: "image/png", size: 5 * 1024 * 1024 + 1 } as Blob),
    );
    await expect(
      normalizeBrowserProfileImage(pngFile(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-image" });
    expect(fixture.close).toHaveBeenCalledOnce();
  });
  it("releases a decoded bitmap when cancellation arrives during decode", async () => {
    const fixture = decode();
    const controller = new AbortController();
    fixture.create.mockImplementation(async () => {
      controller.abort();
      return fixture.bitmap;
    });
    await expect(normalizeBrowserProfileImage(pngFile(), controller.signal)).rejects.toThrow();
    expect(fixture.draw).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});
