import type {
  ResolveTokenImportKeysets,
  TokenImportKeysetRequest,
} from "@bitcaster/client-sdk/tokenImportValidation";
import {
  assertTokenImportResolverRequestLive,
  readBoundedTokenImportJsonResponse,
  selectPagedTokenImportKeysetCandidates,
} from "@bitcaster/client-sdk/tokenImportValidation";

const TOKEN_IMPORT_KEYSET_RESPONSE_BYTES_MAX = 1_048_576;

/**
 * Browser transport adapter for the SDK's bounded token-import policy.
 *
 * Both registries are fetched before any wallet mutation. Only candidates
 * matching an exact requested ID or modern short-ID prefix are returned, so
 * the SDK's candidate bound is independent of the mint's total keyset count.
 */
export const resolveTokenImportKeysets: ResolveTokenImportKeysets = async (request) => {
  assertTokenImportResolverRequestLive(request);
  return selectPagedTokenImportKeysetCandidates({
    request,
    regularResponse: fetchKeysets(mintEndpoint(request.canonicalMintUrl, "keysets"), request),
    fetchConditionalPage: ({ limit, cursor }) => {
      const conditionalUrl = mintEndpoint(request.canonicalMintUrl, "conditional_keysets");
      conditionalUrl.searchParams.set("limit", String(limit));
      if (cursor !== undefined) conditionalUrl.searchParams.set("cursor", cursor);
      return fetchKeysets(conditionalUrl, request);
    },
  });
};

function mintEndpoint(mintUrl: string, endpoint: string): URL {
  return new URL(`${mintUrl.replace(/\/+$/, "")}/v1/${endpoint}`);
}

async function fetchKeysets(url: URL, request: TokenImportKeysetRequest): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: request.signal,
  });
  if (!response.ok) {
    throw new Error(`Mint keyset lookup failed with HTTP ${response.status}`);
  }
  return readBoundedTokenImportJsonResponse(response, TOKEN_IMPORT_KEYSET_RESPONSE_BYTES_MAX);
}
