import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import ja from "../locales/ja.json";

type SupportedLocale = "en" | "ja";

const cardinalPluralCategories: Record<SupportedLocale, ReadonlySet<string>> = {
  en: new Set(new Intl.PluralRules("en").resolvedOptions().pluralCategories),
  ja: new Set(new Intl.PluralRules("ja").resolvedOptions().pluralCategories),
};

/**
 * Recursively flatten a translation catalogue object into a list of dotted
 * key paths. Sorting keeps test failure messages stable across runs and
 * makes diffs easy to read when a translator forgets a key.
 */
function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenKeys(value, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

/**
 * Returns the set of `{{name}}` interpolation tokens used in a translation
 * string.
 */
function extractPlaceholders(value: string): Set<string> {
  const tokens = new Set<string>();
  const re = /\{\{\s*([^}\s]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    tokens.add(match[1]);
  }
  return tokens;
}

function getPluralVariant(
  key: string,
  locale: SupportedLocale,
): { key: string; category: string } | undefined {
  const lastSeparator = key.lastIndexOf(".");
  const keyName = key.slice(lastSeparator + 1);
  const suffixSeparator = keyName.lastIndexOf("_");
  if (suffixSeparator <= 0) return undefined;

  const suffix = keyName.slice(suffixSeparator + 1);
  // i18next permits an explicit zero override outside Intl.PluralRules categories.
  if (suffix !== "zero" && !cardinalPluralCategories[locale].has(suffix)) return undefined;

  const prefix = lastSeparator < 0 ? "" : key.slice(0, lastSeparator + 1);
  return { key: `${prefix}${keyName.slice(0, suffixSeparator)}`, category: suffix };
}

function normalizePluralKey(key: string, locale: SupportedLocale): string {
  return getPluralVariant(key, locale)?.key ?? key;
}

function getPluralFamilyKeys(obj: object, locale: SupportedLocale): Set<string> {
  return new Set(
    flattenKeys(obj).flatMap((key) => {
      const variant = getPluralVariant(key, locale);
      return variant ? [variant.key] : [];
    }),
  );
}

function getLogicalKeys(obj: object, locale: SupportedLocale): Set<string> {
  return new Set(flattenKeys(obj).map((key) => normalizePluralKey(key, locale)));
}

function getIncompletePluralKeys(obj: object, locale: SupportedLocale): string[] {
  const families = new Map<string, { categories: Set<string>; hasBase: boolean }>();

  for (const key of flattenKeys(obj)) {
    const variant = getPluralVariant(key, locale);
    const logicalKey = variant?.key ?? key;
    const family = families.get(logicalKey) ?? {
      categories: new Set<string>(),
      hasBase: false,
    };
    if (variant) family.categories.add(variant.category);
    else family.hasBase = true;
    families.set(logicalKey, family);
  }

  const missing: string[] = [];
  for (const [logicalKey, family] of families) {
    if (family.hasBase || family.categories.size === 0) continue;
    for (const category of cardinalPluralCategories[locale]) {
      if (!family.categories.has(category)) missing.push(`${logicalKey}_${category}`);
    }
  }
  return missing.sort();
}

function getValueAt(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, segment) => {
    if (acc !== null && typeof acc === "object" && segment in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[segment];
    }
    return undefined;
  }, obj);
}

/**
 * Asserts every key in `a` exists in `b`. Returns the offending keys for the
 * test runner to print.
 */
export function getMissingKeys(
  a: object,
  b: object,
  aLocale: SupportedLocale,
  bLocale: SupportedLocale,
): string[] {
  const aKeys = getLogicalKeys(a, aLocale);
  const bKeys = getLogicalKeys(b, bLocale);
  return [...aKeys].filter((key) => !bKeys.has(key)).sort();
}

function getPlaceholderSets(
  obj: object,
  locale: SupportedLocale,
  pluralFamilies: ReadonlySet<string>,
): Map<string, Set<string>[]> {
  const placeholdersByKey = new Map<string, Set<string>[]>();
  for (const key of flattenKeys(obj)) {
    const value = getValueAt(obj, key);
    if (typeof value !== "string") continue;

    const logicalKey = normalizePluralKey(key, locale);
    const placeholders = extractPlaceholders(value);
    if (pluralFamilies.has(logicalKey)) placeholders.delete("count");
    const variants = placeholdersByKey.get(logicalKey) ?? [];
    variants.push(placeholders);
    placeholdersByKey.set(logicalKey, variants);
  }
  return placeholdersByKey;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function samePlaceholderSets(a: Set<string>[], b: Set<string>[]): boolean {
  const [expected, ...variants] = [...a, ...b];
  return (
    expected !== undefined && variants.every((placeholders) => sameSet(expected, placeholders))
  );
}

/**
 * Returns logical keys with inconsistent non-count placeholders across
 * plural variants or catalogues.
 */
export function getPlaceholderMismatches(
  a: object,
  b: object,
  aLocale: SupportedLocale,
  bLocale: SupportedLocale,
): string[] {
  const pluralFamilies = new Set([
    ...getPluralFamilyKeys(a, aLocale),
    ...getPluralFamilyKeys(b, bLocale),
  ]);
  const aPlaceholders = getPlaceholderSets(a, aLocale, pluralFamilies);
  const bPlaceholders = getPlaceholderSets(b, bLocale, pluralFamilies);

  // Why not compare matching suffixes: locales differ, and a form may spell out its count.
  return [...aPlaceholders.keys()]
    .filter((key) => bPlaceholders.has(key))
    .filter((key) => !samePlaceholderSets(aPlaceholders.get(key)!, bPlaceholders.get(key)!))
    .sort();
}

describe("i18n catalogue parity", () => {
  it("every key in en.json exists in ja.json", () => {
    const missing = getMissingKeys(en, ja, "en", "ja");
    expect(
      missing,
      `Keys present in en.json but missing in ja.json:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every key in ja.json exists in en.json", () => {
    const missing = getMissingKeys(ja, en, "ja", "en");
    expect(
      missing,
      `Keys present in ja.json but missing in en.json:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("covers plural categories or provides a base-key fallback in each locale", () => {
    expect(getIncompletePluralKeys(en, "en")).toEqual([]);
    expect(getIncompletePluralKeys(ja, "ja")).toEqual([]);
  });

  it("non-count interpolation tokens match across en.json and ja.json", () => {
    const mismatches = getPlaceholderMismatches(en, ja, "en", "ja");
    expect(
      mismatches,
      `Interpolation mismatches between en.json and ja.json:\n  ${mismatches.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("plural-aware parity helpers", () => {
  it("uses each supported locale's actual cardinal plural categories", () => {
    expect([...cardinalPluralCategories.en].sort()).toEqual(["one", "other"]);
    expect([...cardinalPluralCategories.ja].sort()).toEqual(["other"]);
  });

  it("accepts English and Japanese plural forms without hiding missing keys", () => {
    const english = {
      portfolio: {
        unvalued_one: "One position",
        unvalued_other: "{{count}} positions",
        activity_one: "One activity",
        activity_zero: "No activity",
        activity_other: "{{count}} activities",
        title: "Portfolio",
      },
    };
    const japanese = {
      portfolio: {
        unvalued: "価格を確認できないポジションが{{count}}件あります。",
        activity_zero: "アクティビティなし",
        activity_other: "{{count}}件のアクティビティ",
      },
    };

    expect(getMissingKeys(english, japanese, "en", "ja")).toEqual(["portfolio.title"]);
    expect(getMissingKeys(japanese, english, "ja", "en")).toEqual([]);
  });

  it("does not strip suffixes that are not plural categories for that locale", () => {
    const japanese = { label_one: "文字列", label_many: "複数" };
    const english = { label: "Label" };

    expect(getMissingKeys(japanese, english, "ja", "en")).toEqual(["label_many", "label_one"]);
  });

  it("requires the remaining English plural category without a base fallback", () => {
    expect(getIncompletePluralKeys({ tradeCount_one: "One trade" }, "en")).toEqual([
      "tradeCount_other",
    ]);
    expect(
      getIncompletePluralKeys(
        { tradeCount: "{{count}} trades", tradeCount_one: "One trade" },
        "en",
      ),
    ).toEqual([]);
    expect(getIncompletePluralKeys({ tradeCount_other: "{{count}}件" }, "ja")).toEqual([]);
  });

  it("detects ordinary count and interpolation mismatches across plural families", () => {
    const english = {
      total: "Total: {{count}}",
      greeting: "Hello, {{name}}",
      tradeCount_one: "One trade",
      tradeCount_other: "{{count}} trades",
    };
    const japanese = {
      total: "合計",
      greeting: "{{nickname}}さん、こんにちは",
      tradeCount_other: "{{count}}件の取引",
    };

    expect(getPlaceholderMismatches(english, japanese, "en", "ja")).toEqual(["greeting", "total"]);
  });

  it("detects a non-count interpolation missing from one plural variant", () => {
    const english = {
      welcome_one: "{{name}} has one item",
      welcome_other: "{{count}} items",
    };
    const japanese = {
      welcome_other: "{{name}}さんは{{count}}件持っています",
    };

    expect(getPlaceholderMismatches(english, japanese, "en", "ja")).toEqual(["welcome"]);
  });
});

it("distinguishes Japanese market resolution from trade settlement", () => {
  expect(ja.market.resolution).toBe("結果判定");
  expect(ja.market.resolutionCriteria).toBe("結果判定基準");
  expect(ja.marketStatus.resolved).toBe("結果判定済み");
  expect(ja.resolutionStatus.pending_resolution).toBe("結果判定待ち");
  expect(ja.activityType.payout_claimed).toBe("報酬受取");
  expect(ja.trade.estimatedSettlementFee).toBe("決済手数料（推定）");
});
