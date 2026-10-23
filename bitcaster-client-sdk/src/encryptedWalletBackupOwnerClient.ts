import {
  EncryptedWalletBackupOwnerHttpAdapter,
  type EncryptedWalletBackupOwnerHttpAdapter as OwnerHttpTransport,
} from './encryptedWalletBackupOwnerHttpAdapter.ts'
import {
  selectEncryptedWalletBackupOwnerCandidateFromPages,
  validateEncryptedWalletBackupOwnerDiscoveryPages,
  resolveEncryptedWalletBackupFirstAccount,
  type EncryptedWalletBackupFirstAccountResolution,
  type EncryptedWalletBackupOwnerCandidate,
  type EncryptedWalletBackupOwnerDiscoveryPage,
} from './encryptedWalletBackupOwnerDiscovery.ts'
import {
  collectEncryptedWalletBackupOwnerDescriptorPages,
  decodeEncryptedWalletBackupOwnerContext,
  type EncryptedWalletBackupOwnerCollectedHeadEvidence,
  type EncryptedWalletBackupOwnerContext,
  type EncryptedWalletBackupOwnerDescriptorPage,
} from './encryptedWalletBackupOwnerHead.ts'
import {
  decodeEncryptedWalletBackupOwnerCurrentInventory,
  requireEncryptedWalletBackupOwnerCurrentInventoryScope,
  decodeEncryptedWalletBackupOwnerDescriptorPageWire,
  decodeEncryptedWalletBackupOwnerBundleSupersessionReceiptWire,
} from './encryptedWalletBackupOwnerServiceCodec.ts'
import { decodeEncryptedWalletBackupOwnerEnrollmentEpochResult } from './encryptedWalletBackupOwnerHttpCodec.ts'
import {
  verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  issueEncryptedWalletBackupOwnerBackupReachabilityEvidence,
  type EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt,
  type EncryptedWalletBackupOwnerBackupReachabilityEvidence,
} from './encryptedWalletBackupOwnerReceipt.ts'
import {
  verifyEncryptedWalletBackupOwnerBundleSupersessionMutation,
  requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation,
  type EncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation,
} from './encryptedWalletBackupOwnerMutation.ts'
import { decodeEncryptedWalletBackupOwnerSignedMutationWire } from './encryptedWalletBackupOwnerServiceCodec.ts'
import { decodeEncryptedWalletBackupOwnerUploadGroup } from './encryptedWalletBackupOwnerUpload.ts'
import type { EncryptedWalletBackupV2KeyHandle } from './encryptedWalletBackupV2Keys.ts'
import {
  decodeEncryptedWalletBackupV2BundleObjectWire,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleObjectWire,
} from './encryptedWalletBackupV2Bundle.ts'
import type { PreparedEncryptedWalletBackupOwnerAccountOperation } from './encryptedWalletBackupOwnerAccount.ts'
import type { EncryptedWalletBackupOwnerAccountResponse } from './encryptedWalletBackupOwnerAccountHttp.ts'

const MAX_DISCOVERY_PAGES = 64
const MAX_DESCRIPTOR_PAGES = 18

/** Shared bounded client for selected-owner encrypted backup routes. */
export class EncryptedWalletBackupOwnerClient {
  readonly #transport: OwnerHttpTransport
  readonly #keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly #receiptPins: readonly { readonly keyId: string; readonly publicKey: string }[]

  constructor(input: {
    readonly origin: string
    readonly keyHandle: EncryptedWalletBackupV2KeyHandle
    readonly pinnedReceiptKeys: readonly { readonly keyId: string; readonly publicKey: string }[]
    readonly fetch?: typeof fetch
    readonly nowUnixSeconds?: () => number
  }) {
    this.#keyHandle = input.keyHandle
    this.#receiptPins = Object.freeze(
      input.pinnedReceiptKeys.map((pin) => Object.freeze({ ...pin })),
    )
    this.#transport = new EncryptedWalletBackupOwnerHttpAdapter({
      origin: input.origin,
      keyHandle: input.keyHandle,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.nowUnixSeconds === undefined ? {} : { nowUnixSeconds: input.nowUnixSeconds }),
    })
    if (this.#receiptPins.length < 1 || this.#receiptPins.length > 2)
      throw new Error('encrypted backup owner receipt pins are invalid')
  }

  /** Reads the bounded owner listing. It never chooses a candidate. */
  async discover(input: {
    readonly signal: AbortSignal
  }): Promise<readonly EncryptedWalletBackupOwnerDiscoveryPage[]> {
    const pages: EncryptedWalletBackupOwnerDiscoveryPage[] = []
    let requestedCursor: string | null = null
    for (let count = 0; count < MAX_DISCOVERY_PAGES; count += 1) {
      if (input.signal.aborted) throw new Error('encrypted backup owner discovery was cancelled')
      const page = await this.#transport.discover({ requestedCursor, signal: input.signal })
      if (
        page.realm !== this.#keyHandle.realm ||
        page.walletId !== this.#keyHandle.walletId ||
        page.requestedCursor !== requestedCursor
      )
        throw new Error('encrypted backup owner discovery context changed')
      pages.push(page)
      if (page.nextCursor === null) {
        validateEncryptedWalletBackupOwnerDiscoveryPages(pages)
        return Object.freeze(pages)
      }
      requestedCursor = page.nextCursor
    }
    throw new Error('encrypted backup owner listing exceeds the page bound')
  }

  /** Resolves the already verified discovery result for this exact wallet key. */
  resolveFirstAccount(input: {
    readonly pages: readonly EncryptedWalletBackupOwnerDiscoveryPage[]
    readonly authenticatedOwner:
      | import('./encryptedWalletBackupOwnerScope.ts').EncryptedWalletBackupOwnerScope
      | null
  }): EncryptedWalletBackupFirstAccountResolution {
    for (const page of input.pages) {
      if (
        page.realm !== this.#keyHandle.realm ||
        page.walletId !== this.#keyHandle.walletId ||
        page.requestAuthPublicKey !== this.#keyHandle.requestAuthPublicKey
      )
        throw new Error('encrypted backup first-account key context changed')
    }
    return resolveEncryptedWalletBackupFirstAccount(input)
  }

  /** Uses one candidate automatically; multiple candidates require an explicit listed owner. */
  async selectOwner(input: {
    readonly signal: AbortSignal
    readonly ownerScopeId?: string | null
  }): Promise<EncryptedWalletBackupOwnerCandidate> {
    const pages = await this.discover({ signal: input.signal })
    const listed = pages.flatMap((page) => page.entries)
    const onlyCandidate =
      pages.length === 1 && pages[0]?.entries.length === 1 && pages[0]?.nextCursor === null
    const selectedScopeId =
      input.ownerScopeId === undefined
        ? onlyCandidate
          ? listed[0]!.ownerScopeId
          : null
        : input.ownerScopeId
    return selectEncryptedWalletBackupOwnerCandidateFromPages({
      pages,
      ownerScopeId: selectedScopeId,
    })
  }

  async readEnrollmentEpoch(input: {
    readonly owner: EncryptedWalletBackupOwnerCandidate
    readonly signal: AbortSignal
  }): Promise<
    | { readonly status: 'active'; readonly enrollmentEpoch: number }
    | { readonly status: 'not-enrolled' }
  > {
    const response = await this.#transport.request({
      route: {
        operation: 'enrollment-epoch',
        realm: this.#keyHandle.realm,
        walletId: this.#keyHandle.walletId,
        ownerScopeId: input.owner.ownerScopeId,
      },
      enrollmentEpoch: 0,
      payload: new Uint8Array(),
      signal: input.signal,
    })
    if (response.kind !== 'enrollment-epoch')
      throw new Error('encrypted backup owner epoch response is invalid')
    const result = decodeEncryptedWalletBackupOwnerEnrollmentEpochResult(response.body)
    if (result.result === 'active' && result.enrollmentEpoch !== input.owner.enrollmentEpoch)
      throw new Error('encrypted backup owner epoch changed')
    return result.result === 'active'
      ? Object.freeze({ status: 'active', enrollmentEpoch: result.enrollmentEpoch })
      : Object.freeze({ status: 'not-enrolled' })
  }

  async readCurrentHead(input: {
    readonly owner: EncryptedWalletBackupOwnerCandidate
    readonly enrollmentEpoch: number
    readonly signal: AbortSignal
  }): Promise<EncryptedWalletBackupOwnerCollectedHeadEvidence> {
    const context: EncryptedWalletBackupOwnerContext = {
      ownerScopeId: input.owner.ownerScopeId,
      realm: this.#keyHandle.realm,
      walletId: this.#keyHandle.walletId,
      enrollmentEpoch: input.enrollmentEpoch,
    }
    const pages: EncryptedWalletBackupOwnerDescriptorPage[] = []
    let afterBundleId: string | null = null
    for (let count = 0; count < MAX_DESCRIPTOR_PAGES; count += 1) {
      const response = await this.#transport.request({
        route: {
          operation: 'descriptor-page',
          realm: context.realm,
          walletId: context.walletId,
          ownerScopeId: context.ownerScopeId,
          afterBundleId,
        },
        enrollmentEpoch: context.enrollmentEpoch,
        payload: new Uint8Array(),
        signal: input.signal,
      })
      if (response.kind !== 'descriptor-page')
        throw new Error('encrypted backup owner head response is invalid')
      const page = decodeEncryptedWalletBackupOwnerDescriptorPageWire(response.body)
      if (
        page.head.ownerScopeId !== context.ownerScopeId ||
        page.head.realm !== context.realm ||
        page.head.walletId !== context.walletId ||
        page.head.enrollmentEpoch !== context.enrollmentEpoch ||
        page.afterBundleId !== afterBundleId
      )
        throw new Error('encrypted backup owner head context is invalid')
      pages.push(page)
      if (page.nextAfterBundleId === null)
        return collectEncryptedWalletBackupOwnerDescriptorPages(pages, context)
      afterBundleId = page.nextAfterBundleId
    }
    throw new Error('encrypted backup owner head exceeds the descriptor page bound')
  }

  async readCurrentInventory(input: {
    readonly owner: EncryptedWalletBackupOwnerCandidate
    readonly enrollmentEpoch: number
    readonly signal: AbortSignal
  }) {
    const context: EncryptedWalletBackupOwnerContext = {
      ownerScopeId: input.owner.ownerScopeId,
      realm: this.#keyHandle.realm,
      walletId: this.#keyHandle.walletId,
      enrollmentEpoch: input.enrollmentEpoch,
    }
    const response = await this.#transport.request({
      route: {
        operation: 'current-inventory',
        realm: context.realm,
        walletId: context.walletId,
        ownerScopeId: context.ownerScopeId,
      },
      enrollmentEpoch: context.enrollmentEpoch,
      payload: new Uint8Array(),
      signal: input.signal,
    })
    if (response.kind !== 'current-inventory')
      throw new Error('encrypted backup owner inventory response is invalid')
    return requireEncryptedWalletBackupOwnerCurrentInventoryScope({
      inventory: decodeEncryptedWalletBackupOwnerCurrentInventory(response.body),
      expectedContext: context,
    })
  }

  async readObject(input: {
    readonly owner: EncryptedWalletBackupOwnerCandidate
    readonly enrollmentEpoch: number
    readonly descriptor: EncryptedWalletBackupV2BundleDescriptor
    readonly objectId: string
    readonly signal: AbortSignal
  }): Promise<EncryptedWalletBackupV2BundleObjectWire> {
    const response = await this.#transport.request({
      route: {
        operation: 'object-get',
        realm: this.#keyHandle.realm,
        walletId: this.#keyHandle.walletId,
        ownerScopeId: input.owner.ownerScopeId,
        objectId: input.objectId,
      },
      enrollmentEpoch: input.enrollmentEpoch,
      payload: new Uint8Array(),
      signal: input.signal,
    })
    if (response.kind !== 'object')
      throw new Error('encrypted backup owner object response is invalid')
    const object = decodeEncryptedWalletBackupV2BundleObjectWire(response.body, input.descriptor)
    if (object.objectId !== input.objectId)
      throw new Error('encrypted backup owner object id is invalid')
    return object
  }

  async mutateHead(input: {
    readonly owner: EncryptedWalletBackupOwnerCandidate
    readonly enrollmentEpoch: number
    readonly mutationEvidence: EncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation
    readonly canonicalUploadGroup: Uint8Array
    readonly signal: AbortSignal
  }): Promise<EncryptedWalletBackupOwnerVerifiedBundleSupersessionReceipt> {
    const context: EncryptedWalletBackupOwnerContext = {
      ownerScopeId: input.owner.ownerScopeId,
      realm: this.#keyHandle.realm,
      walletId: this.#keyHandle.walletId,
      enrollmentEpoch: input.enrollmentEpoch,
    }
    const decodedGroup = decodeEncryptedWalletBackupOwnerUploadGroup({
      bytes: input.canonicalUploadGroup,
      expectedContext: context,
      expectedRequestAuthPublicKey: this.#keyHandle.requestAuthPublicKey,
    })
    requireEncryptedWalletBackupOwnerVerifiedBundleSupersessionMutation(
      input.mutationEvidence,
      context,
    )
    if (
      decodedGroup.mutationEvidence.envelope.mutation.mutationId !==
        input.mutationEvidence.envelope.mutation.mutationId ||
      decodedGroup.mutationEvidence.envelope.requestDigest !==
        input.mutationEvidence.envelope.requestDigest
    )
      throw new Error('encrypted backup owner mutation does not match upload bytes')
    const response = await this.#transport.request({
      route: {
        operation: 'bundle-supersession',
        realm: this.#keyHandle.realm,
        walletId: this.#keyHandle.walletId,
        ownerScopeId: input.owner.ownerScopeId,
      },
      enrollmentEpoch: input.enrollmentEpoch,
      payload: input.canonicalUploadGroup,
      signal: input.signal,
    })
    if (response.kind !== 'bundle-supersession-receipt')
      throw new Error('encrypted backup owner mutation response is invalid')
    const receipt = decodeEncryptedWalletBackupOwnerBundleSupersessionReceiptWire(response.body)
    return verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
      receipt,
      mutationEvidence: decodedGroup.mutationEvidence,
      expectedContext: context,
      pinnedSigningKeys: this.#receiptPins,
    })
  }

  /** Revalidates a locally persisted receipt with this client's configured trust pins. */
  verifyStoredBackupReachability(input: {
    readonly expectedContext: EncryptedWalletBackupOwnerContext
    readonly canonicalSignedMutation: Uint8Array
    readonly canonicalSignedReceipt: Uint8Array
    readonly collectedHeadEvidence: EncryptedWalletBackupOwnerCollectedHeadEvidence
  }): EncryptedWalletBackupOwnerBackupReachabilityEvidence {
    const context = decodeEncryptedWalletBackupOwnerContext(input.expectedContext)
    if (context.realm !== this.#keyHandle.realm || context.walletId !== this.#keyHandle.walletId)
      throw new Error('encrypted backup owner stored receipt context is foreign')
    const mutation = decodeEncryptedWalletBackupOwnerSignedMutationWire(
      input.canonicalSignedMutation,
    )
    const mutationEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
      envelope: mutation,
      expectedContext: context,
      expectedRequestAuthPublicKey: this.#keyHandle.requestAuthPublicKey,
    })
    const receipt = decodeEncryptedWalletBackupOwnerBundleSupersessionReceiptWire(
      input.canonicalSignedReceipt,
    )
    const receiptEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
      receipt,
      mutationEvidence,
      expectedContext: context,
      pinnedSigningKeys: this.#receiptPins,
    })
    return issueEncryptedWalletBackupOwnerBackupReachabilityEvidence({
      receiptEvidence,
      expectedContext: context,
      collectedHeadEvidence: input.collectedHeadEvidence,
    })
  }

  /** Sends one lifecycle operation that was prepared with explicit account authorization. */
  async operateAccount(input: {
    readonly operation: PreparedEncryptedWalletBackupOwnerAccountOperation
    readonly signal: AbortSignal
  }): Promise<EncryptedWalletBackupOwnerAccountResponse> {
    return this.#transport.accountOperation(input)
  }
}
