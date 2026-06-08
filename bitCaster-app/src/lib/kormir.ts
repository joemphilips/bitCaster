/**
 * Browser-side wrapper around the kormir-wasm DLC oracle library.
 *
 * Kormir is a Rust crate that exposes DLC oracle operations (announcement
 * creation, attestation signing) and publishes the resulting events to Nostr
 * relays. The wasm bundle in `kormir-wasm-pkg/` is ~3MB, so this module loads
 * it lazily via dynamic `import()` — the browser only pays the download cost
 * once the user actually enters the become-oracle flow.
 *
 * Key identity model
 * ------------------
 * Kormir stores its signing secret key (nsec) in IndexedDB. bitCaster keeps
 * the DLC oracle identity unified with the user's Nostr identity, so on every
 * nsec login we immediately push that key into kormir via `Kormir.restore`.
 * The NIP-07 signer path is intentionally unsupported: the extension only
 * exposes opaque signing, which cannot power the secp256k1 Schnorr operations
 * kormir performs locally.
 *
 * Singletons
 * ----------
 * - The wasm module is imported once and cached.
 * - The `Kormir` instance is cached per-key. If the user changes their nsec
 *   (e.g. logs in with a new one), call `resetKormir()` before re-fetching.
 */

import type {
  Kormir as KormirType,
  Announcement as KormirAnnouncement,
  Attestation as KormirAttestation,
} from './kormir-wasm-pkg/kormir_wasm'
import { nip19 } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools/pure'

// Re-export the wasm-bindgen types under friendlier names so callers do not
// have to reach into the generated `kormir-wasm-pkg` directory.
export type Kormir = KormirType
export type { KormirAnnouncement, KormirAttestation }

type KormirModule = typeof import('./kormir-wasm-pkg/kormir_wasm')
type StoredKormirEvent = {
  event_name?: unknown
  announcement?: unknown
  attestation?: unknown
  announcement_event_id?: unknown
}

const NIP88_TITLE_MAX_CHARS = 100

let modulePromise: Promise<KormirModule> | null = null
let instancePromise: Promise<KormirType> | null = null
// Relay list used to build the currently-cached Kormir instance. Tracked so
// that a subsequent getKormir() call with different relays rebuilds instead
// of silently returning the stale instance.
let instanceRelayKey: string | null = null
// The nsec that should be installed into kormir's IndexedDB on next load.
// Tracked separately from the wasm module so that `loginWithNsec` can remember
// the key without triggering the 3MB wasm download — the download is deferred
// until the user actually enters the become-oracle flow.
let pendingNsec: string | null = null

function relayKey(relays: string[]): string {
  // Join with a delimiter unlikely to appear in URLs so key comparisons are
  // order-sensitive (changing relay order rebuilds the instance, which is
  // what we want — Kormir treats the first relay list as canonical).
  return relays.join('|')
}

/**
 * Override hook used by tests to swap in a mocked wasm module. Production code
 * should never call this — always use the dynamic `loadKormirModule`.
 */
export function __setKormirModuleForTest(mod: KormirModule | null): void {
  modulePromise = mod ? Promise.resolve(mod) : null
  instancePromise = null
  instanceRelayKey = null
  pendingNsec = null
}

/**
 * Lazily load and initialize the kormir-wasm module. Subsequent calls return
 * the cached promise so the wasm binary is only fetched once per session.
 *
 * If the load fails, the cache is cleared so that a retry can re-attempt the
 * import instead of forever resurfacing the original error.
 */
async function loadKormirModule(): Promise<KormirModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = await import('./kormir-wasm-pkg/kormir_wasm')
      // wasm-pack --target web exposes a default export that must be awaited
      // before any class methods are available.
      await mod.default()
      return mod
    })().catch((e) => {
      modulePromise = null
      throw e
    })
  }
  return modulePromise
}

/**
 * Remember the nsec the user just logged in with. The actual write to kormir's
 * IndexedDB is deferred to the next {@link getKormir} call so that a simple
 * Nostr login does not trigger the 3MB wasm download. If the user never
 * enters the oracle flow, kormir is never loaded.
 *
 * Call with `null` to forget the pending nsec (e.g. on logout or when
 * switching to a NIP-07 signer that cannot drive kormir).
 *
 * @param nsec - hex or bech32 (nsec1…) encoded secp256k1 private key, or null
 */
export function setPendingKormirNsec(nsec: string | null): void {
  pendingNsec = nsec
  // Force a fresh instance on the next getKormir() call so it picks up the
  // new key from IndexedDB.
  instancePromise = null
}

/**
 * Eagerly push the given nsec into kormir's IndexedDB store, loading the
 * wasm module if necessary. Mostly useful for tests and for callers that
 * want to surface wasm load errors up front. Normal login should prefer
 * {@link setPendingKormirNsec}.
 */
export async function restoreKormirWithNsec(nsec: string): Promise<void> {
  const mod = await loadKormirModule()
  await mod.Kormir.restore(nsec)
  pendingNsec = null
  instancePromise = null
}

export async function ensureKormirNsec(
  relays: string[],
  nsec: string,
): Promise<void> {
  const desiredPubkey = pubkeyFromNsec(nsec)
  try {
    const currentPubkey = normalizeKormirPublicKey(
      (await getKormir(relays)).get_public_key(),
    )
    if (currentPubkey === desiredPubkey) return
  } catch {
    // If kormir cannot construct with the current browser store, restore the
    // requested nsec below. The caller is about to create a new event, so
    // clearing stale kormir state is acceptable here.
  }
  await restoreKormirWithNsec(nsec)
}

/**
 * Get a connected {@link Kormir} instance, initializing and connecting it to
 * the provided relays on first call.
 *
 * If a pending nsec has been recorded via {@link setPendingKormirNsec}, it is
 * applied (via `Kormir.restore`) before constructing the instance so that the
 * oracle identity matches the user's Nostr identity.
 *
 * The instance is cached and reused as long as the relay list is unchanged.
 * Passing a different relay list (or different order) rebuilds the instance
 * so the caller's relays are actually honored. If construction fails, the
 * cache is cleared so that subsequent calls can retry.
 */
export async function getKormir(relays: string[]): Promise<KormirType> {
  const key = relayKey(relays)
  if (!instancePromise || instanceRelayKey !== key) {
    instanceRelayKey = key
    instancePromise = (async () => {
      const mod = await loadKormirModule()
      if (pendingNsec !== null) {
        const stagedNsec = pendingNsec
        const existing = await mod.Kormir.new(relays).catch(() => null)
        if (
          existing &&
          normalizeKormirPublicKey(existing.get_public_key()) === pubkeyFromNsec(stagedNsec)
        ) {
          pendingNsec = null
          return existing
        }
        await mod.Kormir.restore(stagedNsec)
        pendingNsec = null
      }
      return mod.Kormir.new(relays)
    })().catch((e) => {
      instancePromise = null
      instanceRelayKey = null
      throw e
    })
  }
  return instancePromise
}

/**
 * Drop the cached Kormir instance so the next {@link getKormir} rebuilds
 * with fresh state. Does NOT clear a staged nsec — callers that want to
 * forget the key must use `setPendingKormirNsec(null)` explicitly.
 */
export function resetKormir(): void {
  instancePromise = null
  instanceRelayKey = null
}

function plainTextTagValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function truncateNip88Title(title: string): string {
  return Array.from(plainTextTagValue(title)).slice(0, NIP88_TITLE_MAX_CHARS).join('')
}

/**
 * Create an enum oracle event, publish its announcement to the connected
 * relays, and return the announcement encoded as a hex string (the shape
 * expected by the CDK mint's condition registration endpoint).
 *
 * @param relays - websocket URLs of Nostr relays to publish to
 * @param eventId - DLC event_id (slug derived from the market title)
 * @param outcomes - list of possible outcome strings
 * @param maturityEpoch - Unix timestamp (seconds) when the event matures
 * @param title - short plain-text market title for the kind-88 NIP-88 title tag
 * @param description - plain-text market summary for the kind-88 NIP-88 description tag
 */
export async function createEnumAnnouncement(
  relays: string[],
  eventId: string,
  outcomes: string[],
  maturityEpoch: number,
  title = eventId,
  description = title,
): Promise<string> {
  const kormir = await getKormir(relays)
  try {
    return await kormir.create_enum_event(
      eventId,
      outcomes,
      maturityEpoch,
      truncateNip88Title(title),
      plainTextTagValue(description),
    )
  } catch (err) {
    throw new Error(`Failed to create DLC oracle announcement: ${describeThrown(err)}`)
  }
}

/**
 * Sign a previously-created enum event with the given outcome, publish the
 * attestation to the connected relays, and return the attestation encoded as
 * a hex string.
 */
export async function signEnumAttestation(
  relays: string[],
  eventId: string,
  outcome: string,
): Promise<string> {
  const kormir = await getKormir(relays)
  try {
    return await kormir.sign_enum_event(eventId, outcome)
  } catch (err) {
    const stored = await findStoredKormirEvent(kormir, eventId).catch(() => null)
    if (typeof stored?.attestation === 'string' && stored.attestation.length > 0) {
      console.warn(
        'DLC oracle attestation was signed locally, but publishing to Nostr failed. Continuing with the local attestation hex.',
        describeThrown(err),
      )
      return stored.attestation
    }
    throw new Error(`Failed to sign DLC oracle attestation: ${describeThrown(err)}`)
  }
}

export async function getOracleAnnouncementEventId(
  relays: string[],
  eventId: string,
): Promise<string | null> {
  const kormir = await getKormir(relays)
  const stored = await findStoredKormirEvent(kormir, eventId)
  return typeof stored?.announcement_event_id === 'string'
    ? stored.announcement_event_id
    : null
}

/**
 * Return the oracle public key (hex-encoded 32-byte x-only Schnorr key).
 * This matches the Nostr pubkey derived from the same nsec.
 */
export async function getOraclePublicKey(relays: string[]): Promise<string> {
  const kormir = await getKormir(relays)
  return kormir.get_public_key()
}

async function findStoredKormirEvent(
  kormir: KormirType,
  eventId: string,
): Promise<StoredKormirEvent | null> {
  const events = await kormir.list_events()
  if (!Array.isArray(events)) return null
  return (
    events.find(
      (event): event is StoredKormirEvent =>
        isRecord(event) && event.event_name === eventId,
    ) ?? null
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function describeThrown(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err.length > 0) return err
  if (isRecord(err)) {
    const message = err.message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(err)
}

function pubkeyFromNsec(nsec: string): string {
  const trimmed = nsec.trim()
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed)
    if (decoded.type !== 'nsec') throw new Error('Expected an nsec private key')
    return getPublicKey(decoded.data)
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return getPublicKey(hexToBytes(trimmed))
  }
  throw new Error('Expected an nsec1... or 64-character hex private key')
}

function normalizeKormirPublicKey(pubkey: string): string {
  const trimmed = pubkey.trim().toLowerCase()
  if (/^(02|03)[0-9a-f]{64}$/.test(trimmed)) return trimmed.slice(2)
  return trimmed
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
