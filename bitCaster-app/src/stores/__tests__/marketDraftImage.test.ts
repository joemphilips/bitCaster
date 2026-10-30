import "fake-indexeddb/auto";
import { File } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { MarketDraftImageStore } from "../marketDraftImage";

const stores: MarketDraftImageStore[] = [];
function store(name = `draft-image-test-${crypto.randomUUID()}`) {
  const result = new MarketDraftImageStore(name);
  stores.push(result);
  return result;
}
function image(bytes = [0xff, 0xd8, 0xff, 0xd9], name = "original.jpg") {
  return new File([new Uint8Array(bytes)], name, {
    type: "image/jpeg",
  }) as unknown as globalThis.File;
}
afterEach(async () => {
  for (const item of stores.splice(0)) await item.delete();
});

describe("draft-owned image retention", () => {
  it("retains exact bytes, MIME and name across a cold read without a wallet database", async () => {
    const original = store();
    await original.retain("selection", image(), () => true);
    original.close();
    const reloaded = store(original.name);
    const retained = await reloaded.read("selection");
    expect(Array.from(retained.data)).toEqual([255, 216, 255, 217]);
    expect(retained.filename).toBe("original.jpg");
    expect(retained.contentType).toBe("image/jpeg");
  });

  it("does not let a late file read overwrite a newer selection", async () => {
    const db = store();
    let current = "first";
    let finish!: (value: ArrayBuffer) => void;
    const first = image([1], "first.jpg");
    Object.defineProperty(first, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    });
    const oldWrite = db.retain("first", first, () => current === "first");
    current = "second";
    await db.retain("second", image([2], "second.jpg"), () => current === "second");
    finish(new Uint8Array([1]).buffer);
    await oldWrite;
    expect((await db.read("second")).filename).toBe("second.jpg");
    await expect(db.read("first")).rejects.toThrow("not retained");
  });

  it("surfaces an IndexedDB failure and never treats missing selected bytes as no image", async () => {
    const db = store();
    db.table("images").hook("creating", () => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    await expect(db.retain("failed", image(), () => true)).rejects.toThrow();
    await expect(db.read("failed")).rejects.toThrow("not retained");
  });

  it("removal invalidates an in-flight selection", async () => {
    const db = store();
    let current = true;
    let finish!: (value: ArrayBuffer) => void;
    const file = image();
    Object.defineProperty(file, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    });
    const write = db.retain("pending", file, () => current);
    current = false;
    const removed = db.remove("pending");
    finish(new Uint8Array([1]).buffer);
    await Promise.all([write, removed]);
    await expect(db.read("pending")).rejects.toThrow("not retained");
  });

  it("cleanup cannot delete a replacement", async () => {
    const db = store();
    await db.retain("first", image(), () => true);
    await db.retain("second", image([2]), () => true);
    await db.remove("first");
    expect(Array.from((await db.read("second")).data)).toEqual([2]);
    await db.remove("second");
    await expect(db.read("second")).rejects.toThrow("not retained");
  });
});
