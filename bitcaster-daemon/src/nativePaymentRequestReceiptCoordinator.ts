import { getEncodedToken, type Proof, type ProofState } from '@cashu/cashu-ts'
import { nip19 } from 'nostr-tools'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk/durableCustody'
import type { DurableCustodyMintKeysetAuthority } from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  hydrateDurableWalletProof,
  serializeDurableWalletProof,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import {
  createAmountlessCashuPaymentRequest,
  derivePaymentRequestReceiveKeyPair,
  readPendingCashuPaymentRequestMessage,
} from '@bitcaster-market/client-sdk/paymentRequest'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  canonicalizeTokenImportMintUrl,
  validateProductWalletTokenImport,
  type TokenImportKeysetLookup,
  type TokenImportKeysetRequest,
} from '@bitcaster-market/client-sdk/tokenImportValidation'
import { DurableWalletProofImportCoordinator } from './durableWalletProofImportCoordinator.ts'
import {
  DaemonDurableWalletReceiveCoordinator,
  type PreparedDaemonWalletReceive,
} from './durableWalletReceiveCoordinator.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import {
  NativePaymentRequestReceiptSqlite,
  paymentRequestReceiptBinding,
  type NativePaymentRequest,
  type NativePaymentRequestIndexPage,
} from './nativePaymentRequestReceiptSqlite.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import type { StoredProofAsset } from './state.ts'
import type { CashuWalletLike } from './walletOps.ts'

type OutcomeAsset = Extract<StoredProofAsset, { kind: 'Outcome' }>

/** The transport adapter must call create before it publishes or subscribes. */
export interface NativePaymentRequestReceiptDependencies {
  readonly receive: DaemonDurableWalletReceiveCoordinator
  readonly conditional: DurableWalletProofImportCoordinator
  readonly resolveKeysets: (request: TokenImportKeysetRequest) => Promise<TokenImportKeysetLookup>
  readonly conditionalKeysets: (
    mintUrl: string,
    ids: readonly string[],
    identity: Extract<DurableCustodyMintKeysetAuthority['identity'], { kind: 'conditional' }>,
  ) => Promise<readonly DurableCustodyMintKeysetAuthority[]>
  readonly walletFor: (mintUrl: string) => Promise<CashuWalletLike>
  readonly checkProofsStates: (
    mintUrl: string,
    proofs: readonly Pick<Proof, 'id' | 'secret'>[],
  ) => Promise<readonly ProofState[]>
  /** Reuse ordinary receive preparation. Do not reserve another range on replay. */
  readonly prepareRegular: (input: {
    readonly requestId: string
    readonly encodedToken: string
    readonly proofs: readonly Proof[]
    readonly mintUrl: string
  }) => Promise<{
    readonly prepared: PreparedDaemonWalletReceive
    readonly wallet: CashuWalletLike
  }>
}

export type NativePaymentRequestReceiptStatus =
  | { readonly state: 'awaiting' | 'pending'; readonly requestId: string }
  | {
      readonly state: 'credited'
      readonly requestId: string
      readonly amountMsat: number
      readonly proofCount: number
    }

// Instances in one process share the queue. SQLite uniqueness also fences competing writers.
const receiptQueues = new Map<string, Promise<unknown>>()

/** Persisted request and receipt authority. This class has no relay or signer I/O. */
export class NativePaymentRequestReceiptCoordinator {
  readonly #storage
  readonly #getFence: () => CustodyScopeFence
  readonly #now: () => number
  readonly #scopeId: string
  readonly #receivePublicKey: string
  readonly #mintUrl: string
  readonly #dependencies: NativePaymentRequestReceiptDependencies

  constructor(input: {
    readonly directory: string
    readonly getFence: () => CustodyScopeFence
    readonly walletSeedHex: string
    readonly mintUrl: string
    readonly dependencies: NativePaymentRequestReceiptDependencies
    readonly now?: () => number
  }) {
    if (!/^[0-9a-f]{128}$/.test(input.walletSeedHex))
      throw new Error('payment request wallet seed is invalid')
    const seed = Buffer.from(input.walletSeedHex, 'hex')
    this.#scopeId = deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(seed),
    })
    this.#receivePublicKey = derivePaymentRequestReceiveKeyPair(seed).publicKey
    this.#mintUrl = canonicalizeTokenImportMintUrl(input.mintUrl, true)
    this.#storage = createDaemonStateSqliteSession(input.directory)
    this.#getFence = input.getFence
    this.#now = input.now ?? Date.now
    this.#dependencies = input.dependencies
  }

  async create(input: {
    readonly requestId: string
    readonly nprofile: string
  }): Promise<NativePaymentRequest> {
    if (
      input.requestId.length === 0 ||
      Buffer.byteLength(input.requestId) > 256 ||
      Buffer.byteLength(input.nprofile) > 65536
    )
      throw new Error('payment request presentation exceeds bounds')
    const decoded = nip19.decode(input.nprofile)
    if (decoded.type !== 'nprofile' || decoded.data.pubkey !== this.#receivePublicKey)
      throw new Error('payment request receive identity is foreign')
    const created = createAmountlessCashuPaymentRequest({
      id: input.requestId,
      mintUrl: this.#mintUrl,
      nprofile: input.nprofile,
    })
    return withDurableCustodyUnitOfWork(this.#storage, this.#fence(), this.#now(), (database) => {
      const store = new NativePaymentRequestReceiptSqlite(database)
      const existing = store.getRequest(this.#scopeId, input.requestId)
      if (existing !== null) {
        this.#assertRequest(existing)
        if (existing.encoded !== created.encoded || existing.nprofile !== input.nprofile)
          throw new Error('payment request presentation is already bound')
        return existing
      }
      const request: NativePaymentRequest = {
        scopeId: this.#scopeId,
        requestId: input.requestId,
        mintUrl: this.#mintUrl,
        unit: 'msat',
        receivePublicKey: this.#receivePublicKey,
        nprofile: input.nprofile,
        encoded: created.encoded,
        createdAtMs: this.#now(),
      }
      store.createRequest(request)
      return request
    })
  }

  async receive(content: string): Promise<NativePaymentRequestReceiptStatus | null> {
    if (content.length > 4 * 1024 * 1024 || Buffer.byteLength(content) > 4 * 1024 * 1024)
      throw new Error('payment request message exceeds bounds')
    const matched = await this.#read((store) =>
      readPendingCashuPaymentRequestMessage({
        content,
        walletScopeId: this.#scopeId,
        readPending: (id) => {
          const request = store.getRequest(this.#scopeId, id)
          if (request === null) return undefined
          this.#assertRequest(request)
          return { id, mintUrl: request.mintUrl, walletScopeId: request.scopeId }
        },
      }),
    )
    if (matched === null) return null
    if (matched.payload.proofs.length > 10000)
      throw new Error('payment request proof count exceeds bounds')
    const proofs = matched.payload.proofs.map((proof) =>
      hydrateDurableWalletProof(serializeDurableWalletProof(proof)),
    )
    const candidate = paymentRequestReceiptBinding({
      scopeId: this.#scopeId,
      requestId: matched.payload.id,
      mintUrl: this.#mintUrl,
      proofs,
    })
    return this.#serialize(candidate.requestId, async () => {
      const receipt = await this.#read((store) => store.assertCandidate(candidate))
      if (receipt !== null) return this.#recover(candidate.requestId)
      const encodedToken = getEncodedToken({ mint: this.#mintUrl, unit: 'msat', proofs })
      const validated = await validateProductWalletTokenImport({
        encodedToken,
        decode: () => ({ mint: this.#mintUrl, unit: 'msat', proofs }),
        resolveKeysets: this.#dependencies.resolveKeysets,
        allowedCanonicalMintUrls: new Set([this.#mintUrl]),
        allowInsecureLoopbackHttp: true,
        bounds: {
          maxEncodedBytes: 4 * 1024 * 1024,
          maxProofs: 10000,
          maxMints: 1,
          maxKeysets: 512,
          maxResolverCandidates: 512,
          resolverTimeoutMs: 10000,
        },
      })
      switch (validated.context) {
        case 'ctf-collateral-msat': {
          const prepared = await this.#dependencies.prepareRegular({
            requestId: candidate.requestId,
            encodedToken,
            proofs,
            mintUrl: this.#mintUrl,
          })
          await this.#dependencies.receive.execute({ ...prepared, receipt: candidate })
          break
        }
        case 'ctf-position-msat': {
          const groups = new Map<
            string,
            {
              asset: OutcomeAsset
              proofs: Proof[]
              ids: Set<string>
              identity: Extract<
                DurableCustodyMintKeysetAuthority['identity'],
                { kind: 'conditional' }
              >
            }
          >()
          for (const classified of validated.proofs) {
            const metadata = classified.conditionalMetadata
            if (
              metadata === undefined ||
              typeof metadata.conditionId !== 'string' ||
              !/^[0-9a-f]{64}$/.test(metadata.conditionId) ||
              typeof metadata.outcomeCollection !== 'string' ||
              metadata.outcomeCollection.length === 0 ||
              metadata.outcomeCollection.length > 256 ||
              typeof metadata.outcomeCollectionId !== 'string' ||
              !/^[0-9a-f]{64}$/.test(metadata.outcomeCollectionId)
            )
              throw new Error('payment request conditional metadata is invalid')
            const key = JSON.stringify([
              metadata.conditionId,
              metadata.outcomeCollection,
              metadata.outcomeCollectionId,
            ])
            let group = groups.get(key)
            if (group === undefined) {
              group = {
                asset: {
                  kind: 'Outcome',
                  conditionId: metadata.conditionId,
                  outcomeSetId: metadata.outcomeCollection,
                  baseAsset: 'sat',
                  unit: 'msat',
                },
                proofs: [],
                ids: new Set(),
                identity: {
                  kind: 'conditional',
                  conditionId: metadata.conditionId,
                  outcomeCollection: metadata.outcomeCollection,
                  outcomeCollectionId: metadata.outcomeCollectionId,
                },
              }
              groups.set(key, group)
            }
            const proof = proofs[classified.proofIndex]
            if (proof === undefined || proof.id !== classified.resolvedKeysetId)
              throw new Error('payment request proof classification is foreign')
            group.proofs.push(proof)
            group.ids.add(classified.resolvedKeysetId)
          }
          if (groups.size > 16) throw new Error('payment request group count exceeds bounds')
          const sources = await Promise.all(
            [...groups.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(async ([, group]) => ({
                asset: group.asset,
                proofs: group.proofs,
                keysets: await this.#dependencies.conditionalKeysets(
                  this.#mintUrl,
                  [...group.ids].sort(),
                  group.identity,
                ),
              })),
          )
          await this.#dependencies.conditional.receivePaymentRequest({
            receipt: candidate,
            mintUrl: this.#mintUrl,
            groups: sources,
            checkProofsStates: (remaining) =>
              this.#dependencies.checkProofsStates(this.#mintUrl, remaining),
          })
          break
        }
        default:
          throw new Error('payment request token context is invalid')
      }
      return this.status(candidate.requestId)
    })
  }

  async recover(requestId: string): Promise<NativePaymentRequestReceiptStatus> {
    return this.#serialize(requestId, () => this.#recover(requestId))
  }

  list(input: {
    readonly cursor: string | null
    readonly limit?: number
  }): Promise<NativePaymentRequestIndexPage> {
    return this.#read((store) =>
      store.listRequests({ ...input, scopeId: this.#scopeId, mintUrl: this.#mintUrl }),
    )
  }

  hasUncreditedRequests(): Promise<boolean> {
    return this.#read((store) => store.hasUncreditedRequests(this.#scopeId, this.#mintUrl))
  }

  async status(requestId: string): Promise<NativePaymentRequestReceiptStatus> {
    const receipt = await this.#read((store) => {
      const request = store.getRequest(this.#scopeId, requestId)
      if (request === null) throw new Error('payment request is missing')
      this.#assertRequest(request)
      return store.getReceipt(this.#scopeId, requestId)
    })
    if (receipt === null) return { state: 'awaiting', requestId }
    if (receipt.kind === 'regular') {
      const proofs = await this.#dependencies.receive.paymentRequestResult(requestId)
      if (proofs === null) return { state: 'pending', requestId }
      return {
        state: 'credited',
        requestId,
        amountMsat: proofs.reduce((total, proof) => total + amountToNumber(proof.amount), 0),
        proofCount: proofs.length,
      }
    }
    return (await this.#dependencies.conditional.paymentRequestApplied(requestId))
      ? {
          state: 'credited',
          requestId,
          amountMsat: receipt.inputAmountMsat,
          proofCount: receipt.proofCount,
        }
      : { state: 'pending', requestId }
  }

  async #recover(requestId: string): Promise<NativePaymentRequestReceiptStatus> {
    const status = await this.status(requestId)
    if (status.state !== 'pending') return status
    const receipt = await this.#read((store) => store.getReceipt(this.#scopeId, requestId))
    if (receipt?.kind === 'regular')
      await this.#dependencies.receive.resumePaymentRequest(
        requestId,
        await this.#dependencies.walletFor(this.#mintUrl),
      )
    else if (receipt?.kind === 'conditional')
      await this.#dependencies.conditional.recoverPaymentRequest(requestId, (proofs) =>
        this.#dependencies.checkProofsStates(this.#mintUrl, proofs),
      )
    return this.status(requestId)
  }

  #assertRequest(request: NativePaymentRequest): void {
    if (
      request.scopeId !== this.#scopeId ||
      request.mintUrl !== this.#mintUrl ||
      request.receivePublicKey !== this.#receivePublicKey ||
      request.unit !== 'msat' ||
      createAmountlessCashuPaymentRequest({
        id: request.requestId,
        mintUrl: request.mintUrl,
        nprofile: request.nprofile,
      }).encoded !== request.encoded
    )
      throw new Error('payment request stored authority is foreign')
    const decoded = nip19.decode(request.nprofile)
    if (decoded.type !== 'nprofile' || decoded.data.pubkey !== this.#receivePublicKey)
      throw new Error('payment request stored receive identity is foreign')
  }

  #fence(): CustodyScopeFence {
    const fence = this.#getFence()
    if (fence.scopeId !== this.#scopeId) throw new Error('payment request wallet scope is foreign')
    return fence
  }

  #read<T>(read: (store: NativePaymentRequestReceiptSqlite) => T): Promise<T> {
    return withDurableCustodyFencedRead(this.#storage, this.#fence(), this.#now(), (database) =>
      read(new NativePaymentRequestReceiptSqlite(database)),
    )
  }

  async #serialize<T>(requestId: string, run: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([this.#scopeId, requestId])
    const previous = receiptQueues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(run)
    receiptQueues.set(key, current)
    try {
      return await current
    } finally {
      if (receiptQueues.get(key) === current) receiptQueues.delete(key)
    }
  }
}
