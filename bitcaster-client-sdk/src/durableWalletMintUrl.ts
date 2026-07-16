const DURABLE_WALLET_MINT_URL_MAX_LENGTH = 2_048;

export function normalizeDurableWalletMintUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > DURABLE_WALLET_MINT_URL_MAX_LENGTH
  ) {
    throw new Error("durable wallet mint is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("durable wallet mint is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("durable wallet mint is invalid");
  }
  return parsed.href.replace(/\/+$/, "");
}
