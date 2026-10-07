import { BitcasterEngineClient } from '@bitcaster-market/client-sdk/engineClient'
import { signNip98 } from './nostrAuth.ts'

export function createAuthenticatedBitcasterEngineClient(options: {
  baseUrl: string
  nostrSecretKeyHex: string
}): BitcasterEngineClient {
  return new BitcasterEngineClient({
    baseUrl: options.baseUrl,
    authorization: ({ url, method, bodyText, payloadHash }) =>
      signNip98({ privateKeyHex: options.nostrSecretKeyHex }, url, method, bodyText, payloadHash),
  })
}
