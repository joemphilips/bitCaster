import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type {
  ResolveTokenImportKeysets,
  TokenImportKeysetRequest,
} from '@bitcaster-market/client-sdk/tokenImportValidation'
import {
  assertTokenImportResolverRequestLive,
  readBoundedTokenImportJsonResponse,
  selectTokenImportKeysetCandidates,
} from '@bitcaster-market/client-sdk/tokenImportValidation'

const TOKEN_IMPORT_KEYSET_RESPONSE_BYTES_MAX = 1_048_576

interface DaemonTokenImportResolverOptions {
  allowInsecureLoopbackHttp: boolean
  lookupHost?: (hostname: string) => Promise<readonly { address: string }[]>
}

export function createDaemonTokenImportKeysetResolver(
  options: DaemonTokenImportResolverOptions,
): ResolveTokenImportKeysets {
  return async (request) => {
    assertTokenImportResolverRequestLive(request)
    const conditionalUrl = mintEndpoint(request.canonicalMintUrl, 'conditional_keysets')
    conditionalUrl.searchParams.set('limit', String(request.maxCandidates))
    const [regular, conditional] = await Promise.all([
      fetchKeysets(mintEndpoint(request.canonicalMintUrl, 'keysets'), request, options),
      fetchKeysets(conditionalUrl, request, options),
    ])
    assertTokenImportResolverRequestLive(request)
    return selectTokenImportKeysetCandidates({
      request,
      regularResponse: regular,
      conditionalResponse: conditional,
    })
  }
}

function mintEndpoint(mintUrl: string, endpoint: string): URL {
  return new URL(`${mintUrl.replace(/\/+$/, '')}/v1/${endpoint}`)
}

async function fetchKeysets(
  url: URL,
  request: TokenImportKeysetRequest,
  options: DaemonTokenImportResolverOptions,
): Promise<unknown> {
  await assertPublicDestination(url, options.allowInsecureLoopbackHttp, options.lookupHost)
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: request.signal,
  })
  if (!response.ok) {
    throw new Error(`Mint keyset lookup failed with HTTP ${response.status}`)
  }
  return readBoundedTokenImportJsonResponse(response, TOKEN_IMPORT_KEYSET_RESPONSE_BYTES_MAX)
}

async function assertPublicDestination(
  url: URL,
  allowLoopback: boolean,
  lookupHost?: (hostname: string) => Promise<readonly { address: string }[]>,
): Promise<void> {
  const addresses = lookupHost
    ? await lookupHost(url.hostname)
    : await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0) throw new Error('Mint keyset lookup DNS returned no addresses')
  for (const { address } of addresses) {
    if (!isPublicAddress(address) && !(allowLoopback && isLoopbackAddress(address))) {
      throw new Error('Mint keyset lookup resolved to a private address')
    }
  }
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    )
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    )
  }
  return false
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address.startsWith('127.')
}
