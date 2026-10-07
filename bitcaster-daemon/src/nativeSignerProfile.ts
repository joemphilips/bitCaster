import {
  decodeNostrProfileAcknowledgment,
  MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  MAX_NOSTR_PROFILE_RELAY_FRAMES,
  prepareNostrProfileEdit,
  readNostrProfile,
  readNostrProfileEditSnapshot,
  selectNostrProfileEditBase,
  signNostrProfileEdit,
  validateNostrProfilePatch,
  type NostrProfilePatch,
  type NostrProfileQuery,
  type NostrProfileReadResult,
} from '@bitcaster-market/client-sdk'
import { finalizeEvent, type Event as NostrEvent, type EventTemplate } from 'nostr-tools/pure'
import { NativeNostrRelay, type NativeNostrRelayOptions } from './nativeNostrRelay.ts'
import { readNativeConfig } from './nativeConfig.ts'
import { readSecrets, readSelectedDaemonSigner, type SelectedDaemonSigner } from './secrets.ts'
import {
  withNativeProfileEditSession,
  type NativeProfileEditSession,
} from './nativeProfileCache.ts'

export interface NativeSignerProfileResult extends NostrProfileReadResult {
  readonly signer: SelectedDaemonSigner
}

/** A fresh public read never opens the secret authority or changes the selected signer. */
export async function readNativeSignerProfile(
  options: Pick<NativeNostrRelayOptions, 'websocketImplementation'> = {},
): Promise<NativeSignerProfileResult> {
  const signer = await readSelectedDaemonSigner()
  if (!signer.enabled)
    throw new Error('Signer is disconnected. Connect the saved signer before reading its profile.')
  const config = readNativeConfig()
  const result = await readNostrProfile(
    signer.publicKeyHex,
    config.config.daemon.nostrRelays,
    nativeProfileQuery(options),
  )
  const current = await readSelectedDaemonSigner()
  const currentConfig = readNativeConfig()
  if (
    current.revision !== signer.revision ||
    current.publicKeyHex !== signer.publicKeyHex ||
    current.enabled !== signer.enabled ||
    currentConfig.revision !== config.revision
  )
    throw new Error(
      'Signer or relay settings changed during the profile read. Retry with the current selection.',
    )
  return { signer, ...result }
}

function nativeProfileQuery(
  options: Pick<NativeNostrRelayOptions, 'websocketImplementation' | 'signal' | 'connectTimeoutMs'>,
  beforeSend?: () => Promise<void>,
): NostrProfileQuery {
  return (url, filter, onEvent) =>
    new Promise<void>((resolve, reject) => {
      let settled = false
      let frames = 0
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        relay.close()
        if (error) reject(error)
        else resolve()
      }
      const relay = new NativeNostrRelay(url, {
        ...options,
        maxMessageBytes: MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
        acceptMessage: () => ++frames <= MAX_NOSTR_PROFILE_RELAY_FRAMES,
        onclose: () => finish(new Error('Nostr profile relay closed.')),
      })
      const timer = setTimeout(() => finish(new Error('Nostr profile relay timed out.')), 8_000)
      void relay
        .connect()
        .then(async () => {
          if (settled) return
          await beforeSend?.()
          if (settled) return
          relay.subscribe([filter], {
            onevent: onEvent,
            oneose: () => finish(),
            onclose: () => finish(new Error('Nostr profile subscription closed.')),
            // The owned deadline must win over upstream synthetic EOSE on timeout.
            eoseTimeoutMs: 8_001,
          })
        })
        .catch(() => finish(new Error('Nostr profile relay connection failed.')))
    })
}

export interface NativeSignerProfileEditOptions extends Pick<
  NativeNostrRelayOptions,
  'websocketImplementation' | 'signal' | 'connectTimeoutMs' | 'publishTimeoutMs'
> {
  readonly nowSeconds?: () => number
  readonly withSession?: typeof withNativeProfileEditSession
  readonly sign?: (event: EventTemplate) => Promise<unknown>
}

export interface NativeSignerProfileEditResult {
  readonly signer: SelectedDaemonSigner
  readonly status: 'saved' | 'not-acknowledged' | 'published-retention-failed' | 'selection-changed'
  readonly eventId: string
  readonly published: boolean
  readonly retained: boolean
  readonly acceptedRelays: readonly string[]
  readonly rejectedRelays: readonly string[]
  readonly unacknowledgedRelays: readonly string[]
  readonly unsentRelays: readonly string[]
}

class ProfileSelectionChanged extends Error {
  constructor() {
    super(
      'Signer or relay settings changed during the profile edit. Retry with the current selection.',
    )
  }
}

interface ProfileEditSelection {
  readonly signer: SelectedDaemonSigner
  readonly config: ReturnType<typeof readNativeConfig>
  readonly assertCurrent: () => Promise<void>
}

type ProfileDelivery = Pick<
  NativeSignerProfileEditResult,
  'acceptedRelays' | 'rejectedRelays' | 'unacknowledgedRelays' | 'unsentRelays'
>

/** The session covers the complete save. An accepted event remains bound to the captured owner. */
export async function editNativeSignerProfile(
  value: NostrProfilePatch,
  options: NativeSignerProfileEditOptions = {},
): Promise<NativeSignerProfileEditResult> {
  const patch = validateNostrProfilePatch(value)
  const selection = await captureProfileSelection(options)
  return (options.withSession ?? withNativeProfileEditSession)(
    selection.signer.publicKeyHex,
    (session) => editProfileInSession(patch, options, selection, session),
    { signal: options.signal },
  )
}

async function captureProfileSelection(
  options: NativeSignerProfileEditOptions,
): Promise<ProfileEditSelection> {
  const signer = await readSelectedDaemonSigner()
  if (!signer.enabled)
    throw new Error('Signer is disconnected. Connect the saved signer before editing its profile.')
  const config = readNativeConfig()
  const assertCurrent = async () => {
    options.signal?.throwIfAborted()
    const current = await readSelectedDaemonSigner()
    if (
      current.revision !== signer.revision ||
      current.publicKeyHex !== signer.publicKeyHex ||
      current.enabled !== signer.enabled ||
      readNativeConfig().revision !== config.revision
    )
      throw new ProfileSelectionChanged()
  }
  return { signer, config, assertCurrent }
}

async function editProfileInSession(
  patch: NostrProfilePatch,
  options: NativeSignerProfileEditOptions,
  selection: ProfileEditSelection,
  session: NativeProfileEditSession,
): Promise<NativeSignerProfileEditResult> {
  const { signer, config, assertCurrent } = selection
  await assertCurrent()
  const retained = await session.read()
  await assertCurrent()
  const snapshot = await readNostrProfileEditSnapshot(
    signer.publicKeyHex,
    config.config.daemon.nostrRelays,
    nativeProfileQuery(options, assertCurrent),
  )
  await assertCurrent()
  const base = selectNostrProfileEditBase(signer.publicKeyHex, snapshot, retained)
  const template = prepareNostrProfileEdit(
    signer.publicKeyHex,
    base,
    patch,
    (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))(),
  )
  await assertCurrent()
  const event = await signNostrProfileEdit(
    signer.publicKeyHex,
    template,
    options.sign ?? ((request) => signNativeProfile(request, signer.publicKeyHex, assertCurrent)),
  )
  const delivery = await deliverNativeProfile(
    event,
    config.config.daemon.nostrRelays,
    options,
    assertCurrent,
  )
  return finishProfileSave(selection, session, event, delivery)
}

async function finishProfileSave(
  selection: ProfileEditSelection,
  session: NativeProfileEditSession,
  event: NostrEvent,
  delivery: ProfileDelivery,
): Promise<NativeSignerProfileEditResult> {
  const published = delivery.acceptedRelays.length > 0
  let retained = false
  if (published) {
    try {
      await session.retain(event)
      retained = true
    } catch {
      return {
        signer: selection.signer,
        eventId: event.id,
        published,
        retained,
        status: 'published-retention-failed',
        ...delivery,
      }
    }
  }
  let selectionChanged = false
  try {
    await selection.assertCurrent()
  } catch {
    selectionChanged = true
  }
  return {
    signer: selection.signer,
    eventId: event.id,
    published,
    retained,
    status: selectionChanged ? 'selection-changed' : published ? 'saved' : 'not-acknowledged',
    ...delivery,
  }
}

async function signNativeProfile(
  template: EventTemplate,
  owner: string,
  assertCurrent: () => Promise<void>,
): Promise<NostrEvent> {
  await assertCurrent()
  const secrets = await readSecrets()
  await assertCurrent()
  if (!secrets || secrets.nostrPublicKeyHex !== owner)
    throw new Error('Nostr profile signing identity is unavailable.')
  const key = new Uint8Array(Buffer.from(secrets.nostrSecretKeyHex, 'hex'))
  try {
    return finalizeEvent(template, key)
  } finally {
    key.fill(0)
  }
}

async function publishProfileToRelay(
  event: NostrEvent,
  url: string,
  options: NativeSignerProfileEditOptions,
  assertCurrent: () => Promise<void>,
): Promise<'accepted' | 'rejected' | 'unacknowledged' | 'unsent'> {
  const acknowledgment = { status: null as ReturnType<typeof decodeNostrProfileAcknowledgment> }
  let attempted = false
  let frames = 0
  let relay: NativeNostrRelay | undefined
  try {
    await assertCurrent()
    relay = new NativeNostrRelay(url, {
      ...options,
      maxMessageBytes: MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
      acceptMessage(message) {
        if (++frames > MAX_NOSTR_PROFILE_RELAY_FRAMES) return false
        let frame: unknown
        try {
          frame = JSON.parse(message)
        } catch {
          return false
        }
        if (attempted) acknowledgment.status ??= decodeNostrProfileAcknowledgment(frame, event.id)
        return true
      },
    })
    await relay.connect()
    await assertCurrent()
    attempted = true
    await relay.publish(event)
  } catch {
    // A missing ACK is uncertain delivery. It is not a relay rejection.
  } finally {
    relay?.close()
  }
  return attempted ? (acknowledgment.status ?? 'unacknowledged') : 'unsent'
}

async function deliverNativeProfile(
  event: NostrEvent,
  urls: readonly string[],
  options: NativeSignerProfileEditOptions,
  assertCurrent: () => Promise<void>,
): Promise<ProfileDelivery> {
  const acceptedRelays: string[] = [],
    rejectedRelays: string[] = [],
    unacknowledgedRelays: string[] = [],
    unsentRelays: string[] = []
  for (const url of urls) {
    switch (await publishProfileToRelay(event, url, options, assertCurrent)) {
      case 'accepted':
        acceptedRelays.push(url)
        break
      case 'rejected':
        rejectedRelays.push(url)
        break
      case 'unacknowledged':
        unacknowledgedRelays.push(url)
        break
      case 'unsent':
        unsentRelays.push(url)
        break
    }
  }
  return { acceptedRelays, rejectedRelays, unacknowledgedRelays, unsentRelays }
}
