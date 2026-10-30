import { getEventHash } from "nostr-tools/pure";
import {
  MAX_NOSTR_PROFILE_IMAGE_BYTES,
  NostrMediaUploadError,
  uploadNostrProfileImage,
  type NormalizedNostrProfileImage,
  type NostrProfileImageReceipt,
} from "@bitcaster/client-sdk/nostrMediaUpload";
import { readNostrProfileImageHeader } from "@bitcaster/client-sdk/nostrProfileImageHeader";
import type { NostrProfileImageType } from "@bitcaster/client-sdk/nostrMediaUpload";
import { awaitAbortable } from "@bitcaster/client-sdk/engineClient";
import { captureBrowserNostrProfileSelection } from "./browserNostrProfile";

export interface BrowserProfileImageReceipt extends NostrProfileImageReceipt {
  readonly signal: AbortSignal;
  requireCurrent(): void;
  dispose(): void;
}

/** Canvas creates fresh pixel output; original EXIF and other metadata never leave the browser. */
export async function normalizeBrowserProfileImage(
  file: File,
  signal: AbortSignal,
): Promise<NormalizedNostrProfileImage> {
  signal.throwIfAborted();
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size === 0 ||
    file.size > MAX_NOSTR_PROFILE_IMAGE_BYTES
  ) {
    throw new NostrMediaUploadError("invalid-image");
  }
  const sourceBytes = new Uint8Array(await awaitAbortable(file.arrayBuffer(), signal));
  readNostrProfileImageHeader(sourceBytes, file.type as NostrProfileImageType);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new NostrMediaUploadError("invalid-image");
  }
  try {
    signal.throwIfAborted();
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > 16_000_000) {
      throw new NostrMediaUploadError("invalid-image");
    }
    const scale = Math.min(1, 1024 / bitmap.width, 1024 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new NostrMediaUploadError("invalid-image");
    context.drawImage(bitmap, 0, 0, width, height);
    // PNG preserves transparency and is supported by every canvas implementation.
    const blob = await awaitAbortable(
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) =>
            result ? resolve(result) : reject(new NostrMediaUploadError("invalid-image")),
          "image/png",
        );
      }),
      signal,
    );
    if (blob.type !== "image/png" || blob.size === 0 || blob.size > MAX_NOSTR_PROFILE_IMAGE_BYTES) {
      throw new NostrMediaUploadError("invalid-image");
    }
    const bytes = new Uint8Array(await awaitAbortable(blob.arrayBuffer(), signal));
    signal.throwIfAborted();
    return { bytes, type: "image/png", width, height };
  } finally {
    bitmap.close();
  }
}

export async function uploadBrowserNostrProfileImage(
  file: File,
  signal: AbortSignal,
): Promise<BrowserProfileImageReceipt> {
  const selection = await captureBrowserNostrProfileSelection({}, signal);
  try {
    const image = await normalizeBrowserProfileImage(file, selection.signal);
    selection.requireCurrent();
    const receipt = await uploadNostrProfileImage({
      image,
      publicKeyHex: selection.publicKey,
      signal: selection.signal,
      signEvent: async (template) => {
        selection.requireCurrent();
        const unsigned = { ...template, pubkey: selection.publicKey };
        const sig = await awaitAbortable(selection.signer.sign(unsigned), selection.signal);
        selection.requireCurrent();
        return { ...unsigned, id: getEventHash(unsigned), sig };
      },
    });
    selection.requireCurrent();
    return {
      ...receipt,
      signal: selection.signal,
      requireCurrent: selection.requireCurrent,
      dispose: selection.dispose,
    };
  } catch (error) {
    selection.dispose();
    selection.requireCurrent();
    throw error;
  }
}
