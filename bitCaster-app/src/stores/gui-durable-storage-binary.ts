const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const ARRAY_BUFFER_RESIZABLE = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "resizable",
)?.get;
const ARRAY_BUFFER_MAX_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "maxByteLength",
)?.get;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const TYPED_ARRAY_BYTE_OFFSET = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;

export function requireFixedFullSpanUint8Array(
  value: unknown,
  name: string,
  maximumBytes?: number,
): Uint8Array {
  if (!hasNativeUint8ArrayBrand(value)) {
    throw new Error(`${name} must be a Uint8Array`);
  }
  const view = value as Uint8Array;
  const buffer = nativeGetter(TYPED_ARRAY_BUFFER, view, name) as ArrayBuffer;
  const byteOffset = nativeGetter(
    TYPED_ARRAY_BYTE_OFFSET,
    view,
    name,
  ) as number;
  const byteLength = nativeGetter(
    TYPED_ARRAY_BYTE_LENGTH,
    view,
    name,
  ) as number;
  const fixedBuffer = requireFixedArrayBuffer(buffer, name);
  if (byteOffset !== 0 || byteLength !== fixedBuffer.byteLength) {
    throw new Error(`${name} must own its full backing buffer`);
  }
  if (maximumBytes !== undefined && byteLength > maximumBytes) {
    throw new Error(`${name} exceeds the byte limit`);
  }
  return view;
}

export function requireFixedArrayBuffer(
  value: unknown,
  name: string,
  maximumBytes?: number,
): ArrayBuffer {
  if (ARRAY_BUFFER_BYTE_LENGTH === undefined) {
    throw new Error("Native ArrayBuffer validation is unavailable");
  }
  let byteLength: number;
  try {
    byteLength = ARRAY_BUFFER_BYTE_LENGTH.call(value);
  } catch {
    throw new Error(`${name} must be an ArrayBuffer`);
  }
  const buffer = value as ArrayBuffer;
  const resizable = ARRAY_BUFFER_RESIZABLE?.call(buffer) ?? false;
  const maxByteLength =
    ARRAY_BUFFER_MAX_BYTE_LENGTH?.call(buffer) ?? byteLength;
  if (resizable === true || maxByteLength !== byteLength) {
    throw new Error(`${name} must use a fixed ArrayBuffer`);
  }
  if (maximumBytes !== undefined && byteLength > maximumBytes) {
    throw new Error(`${name} exceeds the byte limit`);
  }
  return buffer;
}

function hasNativeUint8ArrayBrand(value: unknown): value is Uint8Array {
  if (TYPED_ARRAY_TAG === undefined) return value instanceof Uint8Array;
  try {
    return TYPED_ARRAY_TAG.call(value) === "Uint8Array";
  } catch {
    return false;
  }
}

function nativeGetter(
  getter: ((this: unknown) => unknown) | undefined,
  value: unknown,
  name: string,
): unknown {
  if (getter === undefined) {
    throw new Error("Native typed-array validation is unavailable");
  }
  try {
    return getter.call(value);
  } catch {
    throw new Error(`${name} must be a Uint8Array`);
  }
}
