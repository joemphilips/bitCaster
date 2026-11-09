import type { TFunction } from "i18next";
import {
  MAX_MARKET_TITLE_CHARACTERS,
  MAX_MARKET_TITLE_UTF8_BYTES,
  MAX_MARKET_DESCRIPTION_CHARACTERS,
  MAX_MARKET_DESCRIPTION_UTF8_BYTES,
  MAX_MARKET_CREATION_MINT_TAGS_JSON_BYTES,
  inspectNewMarketCreationText,
} from "@bitcaster/client-sdk/marketCreationLimits";

/** Presentation only: the SDK owns validation and its limits. */
export function marketCreationTextError(
  t: TFunction,
  field: "title" | "description",
  issue: ReturnType<typeof inspectNewMarketCreationText>["title"]["issue"],
): string | null {
  switch (issue) {
    case null:
      return null;
    case "required":
      return t(`marketCreation.${field}Required`);
    case "invalid-unicode":
      return t(`marketCreation.${field}InvalidUnicode`);
    case "too-long":
    case "too-many-bytes":
      return t(`marketCreation.${field}TooLong`, {
        maxCharacters:
          field === "title" ? MAX_MARKET_TITLE_CHARACTERS : MAX_MARKET_DESCRIPTION_CHARACTERS,
        maxBytes:
          field === "title" ? MAX_MARKET_TITLE_UTF8_BYTES : MAX_MARKET_DESCRIPTION_UTF8_BYTES,
      });
    default: {
      const unexpected: never = issue;
      throw new Error(`Unsupported market text issue: ${unexpected}`);
    }
  }
}

export function marketCreationTagsError(
  t: TFunction,
  issue: NonNullable<ReturnType<typeof inspectNewMarketCreationText>["mintTagsIssue"]>,
): string {
  switch (issue) {
    case "invalid-unicode":
      return t("marketCreation.tagsInvalidUnicode");
    case "too-large":
      return t("marketCreation.tagsTooLarge", {
        maxBytes: MAX_MARKET_CREATION_MINT_TAGS_JSON_BYTES,
      });
    default: {
      const unexpected: never = issue;
      throw new Error(`Unsupported market tags issue: ${unexpected}`);
    }
  }
}
