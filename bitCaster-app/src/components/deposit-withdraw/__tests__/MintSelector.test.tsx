import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MintSelector } from '../MintSelector'
import { useWalletStore } from '@/stores/wallet'

const MINT_A = { id: 'http://localhost:8085', name: 'Mint A', url: 'http://localhost:8085', balanceSats: 1000 }

describe('MintSelector — P5.2 add-mint integration', () => {
  let storeAddMint: ReturnType<typeof vi.fn>

  beforeEach(() => {
    storeAddMint = vi.fn().mockResolvedValue(undefined)
    // Replace the wallet store's addMint with a spy. Other state stays
    // intact so the rest of the store keeps working in case any subscriber
    // reaches into it during the test.
    useWalletStore.setState({ addMint: storeAddMint as unknown as typeof useWalletStore.getState.prototype.addMint })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the bottom sheet and exposes the shared Add Mint trigger', async () => {
    const user = userEvent.setup()
    render(<MintSelector mints={[MINT_A]} selectedMintId={MINT_A.id} />)

    await user.click(screen.getByText('Mint A'))
    expect(await screen.findByTestId('add-mint-trigger')).toBeInTheDocument()
  })

  it('routes the new URL through useWalletStore.addMint and auto-selects the result', async () => {
    const user = userEvent.setup()
    const onMintChange = vi.fn()
    render(
      <MintSelector
        mints={[MINT_A]}
        selectedMintId={MINT_A.id}
        onMintChange={onMintChange}
      />,
    )

    await user.click(screen.getByText('Mint A'))
    await user.click(screen.getByTestId('add-mint-trigger'))
    await user.type(
      screen.getByTestId('add-mint-url-input'),
      'https://new-mint.example.com',
    )
    await user.click(screen.getByTestId('add-mint-submit'))

    await waitFor(() => {
      expect(storeAddMint).toHaveBeenCalledWith('https://new-mint.example.com')
    })
    // T5.2.b — auto-select the just-added mint. Normalised URL is the
    // canonical form; here the input had no trailing slash so the value
    // matches verbatim.
    expect(onMintChange).toHaveBeenCalledWith('https://new-mint.example.com')
  })
})
