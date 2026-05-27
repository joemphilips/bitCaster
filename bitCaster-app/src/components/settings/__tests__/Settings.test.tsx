import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
