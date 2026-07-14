import { randomUUID } from 'node:crypto'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyScope,
  type DurableCustodyStore,
} from '@bitcaster-market/client-sdk/durableCustody'

const DEFAULT_LEASE_DURATION_MS = 60_000
const DEFAULT_RENEW_AFTER_MS = 20_000

export function daemonWalletCustodyScope(
  walletSeedHex: string,
): DurableCustodyScope {
  if (!/^(?:[0-9a-f]{64}|[0-9a-f]{128})$/.test(walletSeedHex)) {
    throw new Error('daemon wallet seed is invalid')
  }
  const walletId = deriveDurableCustodyWalletId(
    Uint8Array.from(Buffer.from(walletSeedHex, 'hex')),
  )
  const input = { scopeKind: 'wallet' as const, walletId }
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) }
}

export class DaemonDurableCustodyLease {
  private readonly store: DurableCustodyStore
  readonly scope: DurableCustodyScope
  readonly incarnationId: string
  readonly fencingEpoch: number
  private readonly nowMs: () => number
  private readonly leaseDurationMs: number
  private readonly renewAfterMs: number
  private renewalTimer: NodeJS.Timeout | undefined
  private failure: Error | undefined
  private released = false
  private leaseExpiresAtMs: number

  private constructor(
    store: DurableCustodyStore,
    scope: DurableCustodyScope,
    incarnationId: string,
    fencingEpoch: number,
    leaseExpiresAtMs: number,
    nowMs: () => number,
    leaseDurationMs: number,
    renewAfterMs: number,
  ) {
    this.store = store
    this.scope = scope
    this.incarnationId = incarnationId
    this.fencingEpoch = fencingEpoch
    this.leaseExpiresAtMs = leaseExpiresAtMs
    this.nowMs = nowMs
    this.leaseDurationMs = leaseDurationMs
    this.renewAfterMs = renewAfterMs
  }

  static async claim(input: {
    store: DurableCustodyStore
    walletSeedHex: string
    nowMs?: () => number
    leaseDurationMs?: number
    renewAfterMs?: number
    incarnationId?: string
  }): Promise<DaemonDurableCustodyLease> {
    const nowMs = input.nowMs ?? Date.now
    const leaseDurationMs =
      input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
    const renewAfterMs = input.renewAfterMs ?? DEFAULT_RENEW_AFTER_MS
    if (renewAfterMs < 1 || renewAfterMs >= leaseDurationMs) {
      throw new Error('daemon custody lease renewal interval is invalid')
    }
    const observedAtMs = nowMs()
    const incarnationId = input.incarnationId ?? randomUUID()
    const scope = daemonWalletCustodyScope(input.walletSeedHex)
    const claimed = await input.store.claimScope({
      scope,
      incarnationId,
      observedAtMs,
      leaseExpiresAtMs: observedAtMs + leaseDurationMs,
    })
    if (!claimed.owner) throw new Error('daemon custody scope was not claimed')
    return new DaemonDurableCustodyLease(
      input.store,
      scope,
      incarnationId,
      claimed.fencingEpoch,
      claimed.owner.leaseExpiresAtMs,
      nowMs,
      leaseDurationMs,
      renewAfterMs,
    )
  }

  authorization(): DurableCustodyOwnerAuthorization {
    this.assertActive()
    return {
      incarnationId: this.incarnationId,
      fencingEpoch: this.fencingEpoch,
      observedAtMs: this.nowMs(),
    }
  }

  assertActive(): void {
    if (this.failure) throw this.failure
    if (this.released) throw new Error('daemon custody lease is released')
    if (this.nowMs() >= this.leaseExpiresAtMs) {
      throw new Error('daemon custody lease expired')
    }
  }

  startRenewal(onLost: (error: Error) => void): void {
    this.assertActive()
    if (this.renewalTimer) return
    this.renewalTimer = setTimeout(
      () => void this.renew(onLost),
      this.renewAfterMs,
    )
    this.renewalTimer.unref?.()
  }

  async stopAndRelease(): Promise<void> {
    if (this.renewalTimer) clearTimeout(this.renewalTimer)
    this.renewalTimer = undefined
    if (this.released) return
    this.released = true
    if (this.failure) return
    await this.store.releaseScope({
      scope: this.scope,
      incarnationId: this.incarnationId,
      fencingEpoch: this.fencingEpoch,
      observedAtMs: this.nowMs(),
    })
  }

  private async renew(onLost: (error: Error) => void): Promise<void> {
    this.renewalTimer = undefined
    if (this.released || this.failure) return
    try {
      const observedAtMs = this.nowMs()
      const renewed = await this.store.renewScope({
        scope: this.scope,
        incarnationId: this.incarnationId,
        fencingEpoch: this.fencingEpoch,
        observedAtMs,
        leaseExpiresAtMs: observedAtMs + this.leaseDurationMs,
      })
      if (!renewed.owner) throw new Error('daemon custody lease was not renewed')
      this.leaseExpiresAtMs = renewed.owner.leaseExpiresAtMs
      this.startRenewal(onLost)
    } catch (error) {
      this.failure =
        error instanceof Error ? error : new Error(String(error))
      onLost(this.failure)
    }
  }
}
