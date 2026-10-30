import Dexie, { type Table } from "dexie";
import {
  MAX_MARKET_CREATION_THUMBNAIL_BYTES,
  snapshotMarketCreationThumbnail,
} from "@bitcaster/client-sdk";

type RetainedDraftImage = NonNullable<ReturnType<typeof snapshotMarketCreationThumbnail>>;

export class DraftImageRetentionError extends Error {
  constructor(
    readonly code: "missing" | "unavailable" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "DraftImageRetentionError";
  }
}

function retentionError(error: unknown): DraftImageRetentionError {
  return error instanceof DraftImageRetentionError
    ? error
    : new DraftImageRetentionError("unavailable", "Draft image storage is unavailable.");
}

interface DraftImageRow {
  slot: "current";
  selectionId: string;
  thumbnail: RetainedDraftImage;
}

/** A wizard draft exists before wallet setup. It must not follow the active wallet database. */
export class MarketDraftImageStore extends Dexie {
  private images!: Table<DraftImageRow, string>;
  private pending = new Map<string, Promise<void>>();

  constructor(name = "bitcaster-market-draft-images") {
    super(name);
    this.version(1).stores({ images: "&slot" });
  }

  retain(selectionId: string, file: File, isCurrent: () => boolean): Promise<void> {
    const operation = this.write(selectionId, file, isCurrent).catch((error: unknown) => {
      throw retentionError(error);
    });
    this.pending.set(selectionId, operation);
    void operation.finally(() => this.pending.delete(selectionId)).catch(() => {});
    return operation;
  }

  private async write(selectionId: string, file: File, isCurrent: () => boolean) {
    if (file.size === 0 || file.size > MAX_MARKET_CREATION_THUMBNAIL_BYTES)
      throw new DraftImageRetentionError("invalid", "Market thumbnail must contain at most 5 MiB.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type.toLowerCase()))
      throw new DraftImageRetentionError(
        "invalid",
        "Market thumbnail must be a JPEG, PNG, or WebP image.",
      );
    const thumbnail = snapshotMarketCreationThumbnail({
      data: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      contentType: file.type,
    })!;
    if (!isCurrent()) return;
    await this.transaction("rw", this.images, async () => {
      if (!isCurrent()) return;
      await this.images.put({ slot: "current", selectionId, thumbnail });
      // A newer selection or discard may have occurred while IndexedDB was writing.
      if (!isCurrent()) await this.images.delete("current");
    });
  }

  async read(selectionId: string): Promise<RetainedDraftImage> {
    try {
      await this.pending.get(selectionId);
      const row = await this.images.get("current");
      if (!row || row.selectionId !== selectionId)
        throw new DraftImageRetentionError("missing", "Market thumbnail is not retained.");
      return snapshotMarketCreationThumbnail(row.thumbnail)!;
    } catch (error) {
      throw retentionError(error);
    }
  }

  async remove(selectionId: string): Promise<void> {
    await this.pending.get(selectionId)?.catch(() => {});
    await this.transaction("rw", this.images, async () => {
      if ((await this.images.get("current"))?.selectionId === selectionId)
        await this.images.delete("current");
    });
  }
}

export const marketDraftImages = new MarketDraftImageStore();
