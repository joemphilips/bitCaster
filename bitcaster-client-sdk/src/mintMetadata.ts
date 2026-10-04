import {
  Mint as CashuMint,
  type GetInfoResponse,
  type GetKeysResponse,
  type GetKeysetsResponse,
  type RequestFn,
} from '@cashu/cashu-ts'
import { isCanonicalNut02V2KeysetId } from './durableSeedDerivedPolicy.ts'

/** Public metadata read from a Cashu mint without wallet state or authentication. */
export interface PublicMintMetadata {
  readonly mintUrl: string
  readonly info: GetInfoResponse
  readonly keysets: GetKeysetsResponse['keysets']
  readonly keys: GetKeysResponse['keysets']
}

export interface ReadPublicMintMetadataOptions {
  /** Request override for tests or callers that already own a Cashu request transport. */
  readonly request?: RequestFn
}

/** Product wallets need a supported regular msat keyset for new collateral. */
export function assertMintSupportsMsat(metadata: Pick<PublicMintMetadata, 'keysets'>): void {
  if (
    !metadata.keysets.some(
      (keyset) =>
        keyset.active === true &&
        keyset.unit === 'msat' &&
        keyset.conditional === undefined &&
        (!('condition_id' in keyset) || keyset.condition_id === undefined) &&
        isCanonicalNut02V2KeysetId(keyset.id),
    )
  ) {
    throw new Error('mint must have an active regular NUT-02 v2 msat keyset')
  }
}

/** Read the mint info, every public keyset, and every active keyset's public keys. */
export async function readPublicMintMetadata(
  mintUrl: string,
  options: ReadPublicMintMetadataOptions = {},
): Promise<PublicMintMetadata> {
  const mint = new CashuMint(mintUrl)
  const [info, keysets, keys] = await Promise.all([
    mint.getInfo(options.request),
    mint.getKeySets(options.request),
    mint.getKeys(undefined, undefined, options.request),
  ])

  return {
    mintUrl: mint.mintUrl,
    info,
    keysets: keysets.keysets,
    keys: keys.keysets,
  }
}
