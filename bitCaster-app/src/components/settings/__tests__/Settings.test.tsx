import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nip19 } from 'nostr-tools'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { Settings } from '../Settings'
import type { SettingsState } from '@/types/settings'

function settingsState(
  overrides: Partial<SettingsState['nostr']> = {},
): SettingsState {
  return {
    general: {
      baseCurrency: 'BTC',
      language: 'en',
      theme: 'dark',
      appVersion: 'test',
      likedMarketCloseNotifications: false,
    },
    cashu: {
      mints: [],
    },
    nostr: {
      signerMode: 'none',
      signerSource: 'none',
      signerBackupState: 'none',
      canRevealGeneratedNsec: false,
      profile: null,
      profileFetchStatus: 'idle',
      relays: [],
      ...overrides,
    },
  }
}

describe('Settings generated nsec reveal', () => {
  it('shows the reveal affordance for implicit generated nsec signers', () => {
    render(
      <Settings
        activeCategory="nostr"
        settings={settingsState({
          signerMode: 'nsec',
          signerSource: 'implicit-generated',
          signerBackupState: 'needs_backup',
          canRevealGeneratedNsec: true,
        })}
        generatedNsecSecret="nsec1generated"
      />,
    )

    expect(screen.getByRole('button', { name: /view generated nsec/i })).toBeInTheDocument()
  })

  it('hides the reveal affordance for user-provided nsec signers', () => {
    render(
      <Settings
        activeCategory="nostr"
        settings={settingsState({
          signerMode: 'nsec',
          signerSource: 'user-nsec',
          signerBackupState: 'confirmed',
          canRevealGeneratedNsec: false,
        })}
        generatedNsecSecret="nsec1user"
      />,
    )

    expect(screen.queryByRole('button', { name: /view generated nsec/i })).not.toBeInTheDocument()
  })

  it('hides the reveal affordance for NIP-07 signers', () => {
    render(
      <Settings
        activeCategory="nostr"
        settings={settingsState({
          signerMode: 'nip07',
          signerSource: 'nip07',
          signerBackupState: 'confirmed',
          canRevealGeneratedNsec: false,
        })}
      />,
    )

    expect(screen.queryByRole('button', { name: /view generated nsec/i })).not.toBeInTheDocument()
  })
})

describe('Settings generated nsec/npub reveal modal (P22 Link E)', () => {
  it('shows BOTH the public npub and the secret nsec, and the npub matches the derived pubkey', () => {
    // Derive a real keypair in-test so the npub assertion is meaningful:
    // the modal must independently re-derive the same npub from the nsec.
    const sk = generateSecretKey()
    const nsec = nip19.nsecEncode(sk)
    const expectedNpub = nip19.npubEncode(getPublicKey(sk))

    render(
      <Settings
        activeCategory="nostr"
        settings={settingsState({
          signerMode: 'nsec',
          signerSource: 'implicit-generated',
          signerBackupState: 'needs_backup',
          canRevealGeneratedNsec: true,
        })}
        generatedNsecSecret={nsec}
      />,
    )

    // Open the reveal modal, then accept the security warning.
    fireEvent.click(screen.getByRole('button', { name: /view generated nsec/i }))
    fireEvent.click(screen.getByRole('button', { name: /i understand, show nsec/i }))

    // The public npub is shown, unblurred, and equals the independently
    // derived value.
    const npubValue = screen.getByTestId('generated-npub-value')
    expect(npubValue).toHaveTextContent(expectedNpub)
    expect(npubValue.className).not.toContain('blur')

    // The secret nsec is also shown (it carries the blur protection).
    const nsecValue = screen.getByTestId('generated-nsec-value')
    expect(nsecValue).toHaveTextContent(nsec)

    // Per-field copy affordances exist for both.
    expect(screen.getByRole('button', { name: /copy npub/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy nsec/i })).toBeInTheDocument()
  })
})

describe('Settings liked-market close notifications opt-in (P22 Link G)', () => {
  // jsdom has no Notification API by default; stub one so the toggle is not
  // disabled as "unsupported".
  beforeEach(() => {
    const ctor = vi.fn() as unknown as typeof Notification
    ;(ctor as unknown as { permission: NotificationPermission }).permission = 'default'
    vi.stubGlobal('Notification', ctor)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function generalSettings(
    likedMarketCloseNotifications: boolean,
  ): SettingsState {
    const base = settingsState()
    return {
      ...base,
      general: { ...base.general, likedMarketCloseNotifications },
    }
  }

  it('reflects the opt-in OFF state on the toggle switch', () => {
    render(
      <Settings activeCategory="general" settings={generalSettings(false)} />,
    )
    const toggle = screen.getByRole('switch', {
      name: /notify when a liked market closes/i,
    })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('reflects the opt-in ON state on the toggle switch', () => {
    render(
      <Settings activeCategory="general" settings={generalSettings(true)} />,
    )
    const toggle = screen.getByRole('switch', {
      name: /notify when a liked market closes/i,
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('invokes the change handler when toggled — the handler gates the SW permission request', async () => {
    const calls: boolean[] = []
    render(
      <Settings
        activeCategory="general"
        settings={generalSettings(false)}
        onLikedMarketCloseNotificationsChange={(enabled) => {
          calls.push(enabled)
          return true
        }}
      />,
    )
    fireEvent.click(
      screen.getByRole('switch', { name: /notify when a liked market closes/i }),
    )
    await waitFor(() => expect(calls).toEqual([true]))
  })
})
