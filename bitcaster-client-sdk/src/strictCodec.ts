export const STRICT_DECIMAL_TEXT_LIMIT = 128;

export function createStrictCodec(input: {
  errorPrefix: string;
  exactFieldsError: string;
}) {
  return {
    requireRecord(
      value: unknown,
      name: string,
    ): Record<string, unknown> {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${name} is invalid`);
      }
      return value as Record<string, unknown>;
    },
    requireExactFields(
      value: Record<string, unknown>,
      fields: readonly string[],
    ): void {
      if (
        Object.keys(value).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(value, field))
      ) {
        throw new Error(input.exactFieldsError);
      }
    },
    requireText(value: unknown, name: string, limit: number): string {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > limit
      ) {
        throw new Error(`${input.errorPrefix} ${name} is invalid`);
      }
      return value;
    },
    requirePositiveDecimal(value: unknown, name: string): string {
      if (
        typeof value !== "string" ||
        value.length > STRICT_DECIMAL_TEXT_LIMIT ||
        !/^[1-9][0-9]*$/.test(value)
      ) {
        throw new Error(`${input.errorPrefix} ${name} is invalid`);
      }
      return value;
    },
    requireNonNegativeDecimal(value: unknown, name: string): string {
      if (
        typeof value !== "string" ||
        value.length > STRICT_DECIMAL_TEXT_LIMIT ||
        !/^(0|[1-9][0-9]*)$/.test(value)
      ) {
        throw new Error(`${input.errorPrefix} ${name} is invalid`);
      }
      return value;
    },
  };
}
