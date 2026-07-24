import type { Token } from "@cashu/cashu-ts";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  COLLATERAL_UNIT_REGISTRY,
  cashuAmountToMarketSubunits,
  formatAmount,
  marketUnitLabel,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import { normalizeUrl } from "@/lib/url";

export const TOP_UP_ECASH_MAX_BYTES = 100 * 1024;

export type TopUpPasteValidationErrorCode =
  | "too_large"
  | "decode_failed"
  | "mint_mismatch"
  | "unit_invalid"
  | "unit_mismatch"
  | "amount_too_low";

export interface TopUpPasteValidationError {
  ok: false;
  code: TopUpPasteValidationErrorCode;
  values?: Record<string, string | number>;
}

export interface TopUpPasteValidationSuccess {
  ok: true;
  token: Token;
  mintUrl: string;
  unit: CashuProofUnit;
  baseAsset: MarketBaseAsset;
  tokenAmountSubunits: number;
}

export type TopUpPasteValidationResult = TopUpPasteValidationSuccess | TopUpPasteValidationError;

export type DecodeCashuToken = (token: string) => Promise<Token>;

export async function validateTopUpEcashToken(
  tokenText: string,
  params: {
    activeMintUrl: string;
    baseAsset: MarketBaseAsset | string | null | undefined;
    proofUnit?: CashuProofUnit | null;
    deficit: number;
    decodeCashuToken: DecodeCashuToken;
  },
): Promise<TopUpPasteValidationResult> {
  const trimmed = tokenText.trim();
  if (new TextEncoder().encode(trimmed).byteLength > TOP_UP_ECASH_MAX_BYTES) {
    return {
      ok: false,
      code: "too_large",
      values: { maxKb: TOP_UP_ECASH_MAX_BYTES / 1024 },
    };
  }

  let token: Token;
  try {
    token = await params.decodeCashuToken(trimmed);
  } catch {
    return { ok: false, code: "decode_failed" };
  }

  const tokenMintUrl = normalizeUrl(token.mint);
  const activeMintUrl = normalizeUrl(params.activeMintUrl);
  if (tokenMintUrl !== activeMintUrl) {
    return {
      ok: false,
      code: "mint_mismatch",
      values: { mintUrl: tokenMintUrl },
    };
  }

  const expectedBaseAsset = normalizeMarketBaseAsset(params.baseAsset);
  const unit = parseCashuProofUnit(token.unit);
  if (!unit) {
    return {
      ok: false,
      code: "unit_invalid",
      values: {
        tokenUnit: typeof token.unit === "string" && token.unit.length > 0 ? token.unit : "missing",
      },
    };
  }
  if (params.proofUnit && unit !== params.proofUnit) {
    return {
      ok: false,
      code: "unit_mismatch",
      values: {
        tokenUnit: unit,
        expectedUnit: params.proofUnit,
      },
    };
  }
  const tokenBaseAsset = COLLATERAL_UNIT_REGISTRY[unit]?.baseAsset;
  if (tokenBaseAsset !== expectedBaseAsset) {
    return {
      ok: false,
      code: "unit_mismatch",
      values: {
        tokenUnit: unit,
        expectedUnit: marketUnitLabel(expectedBaseAsset),
      },
    };
  }

  const tokenAmountSubunits = token.proofs.reduce((sum, proof) => {
    const amount = amountToNumber(proof.amount);
    return sum + (params.proofUnit ? amount : cashuAmountToMarketSubunits(amount, unit));
  }, 0);
  if (tokenAmountSubunits < params.deficit) {
    return {
      ok: false,
      code: "amount_too_low",
      values: {
        covered: formatAmount(tokenAmountSubunits, expectedBaseAsset),
        needed: formatAmount(params.deficit, expectedBaseAsset),
      },
    };
  }

  return {
    ok: true,
    token,
    mintUrl: tokenMintUrl,
    unit,
    baseAsset: expectedBaseAsset,
    tokenAmountSubunits,
  };
}
