export type EncodedConditionalCatalogueCheckpoint = string | Uint8Array;

export function encodeBoundedConditionalCheckpoint(
  value: unknown,
  maximumBytes: number,
): string {
  const encoded = JSON.stringify(value);
  requireBoundedCheckpointText(encoded, maximumBytes);
  return encoded;
}

export function parseBoundedConditionalCheckpoint(
  value: EncodedConditionalCatalogueCheckpoint,
  maximumBytes: number,
): unknown {
  let text: string;
  if (typeof value === "string") {
    requireBoundedCheckpointText(value, maximumBytes);
    text = value;
  } else if (value instanceof Uint8Array) {
    const byteLength = actualUint8ArrayByteLength(value);
    if (byteLength > maximumBytes) {
      throw new Error(
        "conditional recovery raw checkpoint exceeded its encoded byte bound",
      );
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      throw new Error("conditional recovery raw checkpoint is not valid UTF-8");
    }
  } else {
    throw new Error(
      "conditional recovery raw checkpoint must be encoded text or bytes",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("conditional recovery raw checkpoint JSON is invalid");
  }
}

function requireBoundedCheckpointText(
  value: string,
  maximumBytes: number,
): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("conditional recovery checkpoint byte bound is invalid");
  }
  if (value.length > maximumBytes) {
    throw new Error(
      "conditional recovery raw checkpoint exceeded its encoded byte bound",
    );
  }
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) byteLength += 1;
    else if (codeUnit <= 0x7ff) byteLength += 2;
    else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      byteLength += 4;
      index += 1;
    } else byteLength += 3;
    if (byteLength > maximumBytes) {
      throw new Error(
        "conditional recovery raw checkpoint exceeded its encoded byte bound",
      );
    }
  }
}

function actualUint8ArrayByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const getter = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    "byteLength",
  )?.get;
  if (getter === undefined) {
    throw new Error("conditional recovery byte boundary is unavailable");
  }
  try {
    return getter.call(value) as number;
  } catch {
    throw new Error(
      "conditional recovery raw checkpoint byte container is invalid",
    );
  }
}
