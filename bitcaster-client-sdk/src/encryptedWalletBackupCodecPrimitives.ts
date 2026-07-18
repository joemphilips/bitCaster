interface CodecOptions {
  readonly trimmedText?: boolean;
}

export function createEncryptedWalletBackupCodecPrimitives(
  prefix: string,
  options: CodecOptions = {},
) {
  const invalid = (label: string) => new Error(`${prefix} ${label} is invalid`);
  const invalidFields = (label: string) =>
    new Error(`${prefix} ${label} are invalid`);
  return Object.freeze({
    strictRecord: (value: unknown, fields: readonly string[], label: string) =>
      strictRecord(value, fields, label, invalid, invalidFields),
    exactKeys: (value: unknown, fields: readonly string[], label: string) =>
      exactKeys(value, fields, label, invalid, invalidFields),
    text: (value: unknown, max: number, label: string) =>
      boundedText(value, max, label, options.trimmedText === true, invalid),
    identifier: (value: unknown, label: string) =>
      identifier(value, label, options.trimmedText === true, invalid),
    lowerHex: (value: unknown, bytes: number, label: string) =>
      lowerHex(value, bytes, label, invalid),
    fingerprint: (value: unknown, label: string) =>
      lowerHex(value, 32, label, invalid),
    objectId: (value: unknown, label: string) =>
      lowerHex(value, 16, label, invalid),
    boundedInteger: (value: unknown, min: number, max: number, label: string) =>
      boundedInteger(value, min, max, label, invalid),
    nonNegative: (value: unknown, label: string) =>
      boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, label, invalid),
    positive: (value: unknown, label: string) =>
      boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, label, invalid),
    bytes: (value: unknown, min: number, max: number, label: string) =>
      boundedBytes(value, min, max, label, invalid),
  });
}

export function encryptedWalletBackupBytesFromHex(value: string) {
  return Uint8Array.from(
    value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
  );
}

export function encryptedWalletBackupBytesEqual(
  left: Uint8Array,
  right: Uint8Array,
) {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function strictRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
  invalid: (label: string) => Error,
  invalidFields: (label: string) => Error,
) {
  const row = requireObject(value, label, invalid);
  exactKeys(row, fields, `${label} fields`, invalid, invalidFields);
  return row;
}

function exactKeys(
  value: unknown,
  fields: readonly string[],
  label: string,
  invalid: (label: string) => Error,
  invalidFields: (label: string) => Error,
) {
  const row = requireObject(value, label, invalid);
  const keys = Object.keys(row).sort();
  const expected = [...fields].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  )
    throw invalidFields(label);
  return row;
}

function requireObject(
  value: unknown,
  label: string,
  invalid: (label: string) => Error,
) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid(label);
  return value as Record<string, unknown>;
}

function boundedText(
  value: unknown,
  max: number,
  label: string,
  trimmed: boolean,
  invalid: (label: string) => Error,
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    (trimmed && value.trim() !== value)
  )
    throw invalid(label);
  return value;
}

function identifier(
  value: unknown,
  label: string,
  trimmed: boolean,
  invalid: (label: string) => Error,
) {
  const result = boundedText(value, 128, label, trimmed, invalid);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) throw invalid(label);
  return result;
}

function lowerHex(
  value: unknown,
  bytes: number,
  label: string,
  invalid: (label: string) => Error,
) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)
  )
    throw invalid(label);
  return value;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  label: string,
  invalid: (label: string) => Error,
) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw invalid(label);
  return value as number;
}

function boundedBytes(
  value: unknown,
  min: number,
  max: number,
  label: string,
  invalid: (label: string) => Error,
) {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < min ||
    value.byteLength > max
  )
    throw invalid(label);
  return value;
}
