import { randomUUID } from 'node:crypto'
import { isLoopbackHttpUrl } from '@bitcaster-market/client-sdk'
import { canonicalizeTokenImportMintUrl } from '@bitcaster-market/client-sdk/tokenImportValidation'
import { DaemonDurableWalletReceiveCoordinator } from './durableWalletReceiveCoordinator.ts'
import { DurableWalletProofImportCoordinator } from './durableWalletProofImportCoordinator.ts'
import {
  NativePaymentRequestReceiptCoordinator,
  type NativePaymentRequestReceiptStatus,
} from './nativePaymentRequestReceiptCoordinator.ts'
import type { NativePaymentRequestIndexPage } from './nativePaymentRequestReceiptSqlite.ts'
import { profileDir, type DaemonProfile } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import { createDaemonTokenImportKeysetResolver } from './tokenImportKeysetResolver.ts'
import {
  createWallet,
  prepareRegularWalletReceive,
  resolveMintKeysByKeyset,
  restoreOutputGroups,
  type WalletOpsDependencies,
  type WalletOpsSecrets,
} from './walletOps.ts'

export interface NativePaymentRequestView {
  readonly requestId: string
  readonly encoded: string
  readonly mintUrl: string
  readonly unit: 'msat'
  readonly receivePublicKey: string
  readonly createdAtMs: number
}

/** Compose native requests with the selected profile and the existing custody paths. */
export class NativePaymentRequestOps {
  readonly #coordinator: NativePaymentRequestReceiptCoordinator

  constructor(input: {
    readonly profile: DaemonProfile
    readonly secrets: WalletOpsSecrets
    readonly getFence: () => CustodyScopeFence
    readonly deps?: WalletOpsDependencies
    readonly now?: () => number
  }) {
    const deps: WalletOpsDependencies = { ...input.deps, getCustodyFence: input.getFence }
    const mintUrl = canonicalizeTokenImportMintUrl(
      input.profile.mintUrl,
      isLoopbackHttpUrl(input.profile.mintUrl),
    )
    const now = input.now ?? Date.now
    const directory = profileDir()
    const loadedWallet = async (mint: string) => {
      if (mint !== mintUrl) throw new Error('payment request mint is foreign')
      const wallet = createWallet(mint, input.secrets, deps, 'sat', 'msat')
      await wallet.loadMint()
      return wallet
    }
    this.#coordinator = new NativePaymentRequestReceiptCoordinator({
      directory,
      getFence: input.getFence,
      walletSeedHex: input.secrets.walletSeedHex,
      mintUrl,
      now,
      dependencies: {
        receive: new DaemonDurableWalletReceiveCoordinator(
          directory,
          input.getFence,
          deps.restoreOutputGroups ?? restoreOutputGroups,
          now,
          deps.injectCustodyFault,
        ),
        conditional: new DurableWalletProofImportCoordinator(
          directory,
          input.getFence,
          now,
          deps.injectCustodyFault,
        ),
        resolveKeysets:
          deps.resolveTokenImportKeysets ??
          createDaemonTokenImportKeysetResolver({
            allowInsecureLoopbackHttp: isLoopbackHttpUrl(mintUrl),
          }),
        conditionalKeysets: async (mint, ids, identity) => {
          const keys = await resolveMintKeysByKeyset(mint, [...ids], deps)
          return ids.map((id) => {
            const keyset = keys[id]
            if (keyset === undefined || keyset.id !== id || keyset.unit !== 'msat')
              throw new Error('payment request mint keyset is foreign')
            return {
              canonicalMintUrl: mint,
              id,
              unit: keyset.unit,
              keys: Object.fromEntries(Object.entries(keyset.keys)),
              inputFeePpk: keyset.input_fee_ppk ?? 0,
              finalExpiry: keyset.final_expiry ?? null,
              identity,
            }
          })
        },
        walletFor: loadedWallet,
        checkProofsStates: async (mint, proofs) => {
          const wallet = await loadedWallet(mint)
          if (!wallet.checkProofsStates)
            throw new Error('cashu wallet does not support proof-state checks')
          return wallet.checkProofsStates([...proofs])
        },
        prepareRegular: ({ encodedToken, mintUrl: mint }) =>
          prepareRegularWalletReceive({
            encodedToken,
            mintUrl: mint,
            unit: 'msat',
            secrets: input.secrets,
            deps,
          }),
      },
    })
  }

  async create(input: {
    readonly requestId?: string
    readonly nprofile: string
  }): Promise<NativePaymentRequestView> {
    try {
      const request = await this.#coordinator.create({
        requestId: input.requestId ?? `wallet-request-${randomUUID()}`,
        nprofile: input.nprofile,
      })
      return {
        requestId: request.requestId,
        encoded: request.encoded,
        mintUrl: request.mintUrl,
        unit: request.unit,
        receivePublicKey: request.receivePublicKey,
        createdAtMs: request.createdAtMs,
      }
    } catch {
      throw new Error('native payment request creation failed')
    }
  }

  async status(input: { readonly requestId: string }): Promise<NativePaymentRequestReceiptStatus> {
    try {
      requireRequestId(input.requestId)
      return await this.#coordinator.status(input.requestId)
    } catch {
      throw new Error('native payment request status failed')
    }
  }

  async hasUncreditedRequests(): Promise<boolean> {
    try {
      return await this.#coordinator.hasUncreditedRequests()
    } catch {
      throw new Error('native payment request status failed')
    }
  }

  async list(input: {
    readonly cursor: string | null
    readonly limit?: number
  }): Promise<NativePaymentRequestIndexPage> {
    try {
      return await this.#coordinator.list(input)
    } catch {
      throw new Error('native payment request listing failed')
    }
  }

  async receive(content: string): Promise<NativePaymentRequestReceiptStatus | null> {
    try {
      return await this.#coordinator.receive(content)
    } catch {
      throw new Error('native payment request receive failed')
    }
  }

  async recover(input: { readonly requestId: string }): Promise<NativePaymentRequestReceiptStatus> {
    try {
      requireRequestId(input.requestId)
      return await this.#coordinator.recover(input.requestId)
    } catch {
      throw new Error('native payment request recovery failed')
    }
  }
}

function requireRequestId(requestId: string): void {
  if (typeof requestId !== 'string' || requestId.length === 0 || Buffer.byteLength(requestId) > 256)
    throw new Error('payment request id is invalid')
}
