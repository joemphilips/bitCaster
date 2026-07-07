import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { TopUpOverlay } from '../TopUpOverlay'

const createMintQuote = vi.fn()
const createMintQuoteForUnit = vi.fn()
const waitForMintQuotePaid = vi.fn()
const waitForMintQuotePaidForUnit = vi.fn()
const mintProofs = vi.fn()
const mintProofsForUnit = vi.fn()
const decodeToken = vi.fn()
const getWalletForUnit = vi.fn()
const addProofs = vi.fn()
const ensureImplicitWallet = vi.fn()
const navigate = vi.fn()
let walletBackupState: 'none' | 'needs_backup' | 'confirmed' = 'none'

vi.mock('react-router', () => ({
  useNavigate: () => navigate,
}))

vi.mock('@/lib/cashu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cashu')>()),
  createMintQuote: (...args: unknown[]) => createMintQuote(...args),
  createMintQuoteForUnit: (...args: unknown[]) => createMintQuoteForUnit(...args),
  waitForMintQuotePaid: (...args: unknown[]) => waitForMintQuotePaid(...args),
  waitForMintQuotePaidForUnit: (...args: unknown[]) => waitForMintQuotePaidForUnit(...args),
  mintProofs: (...args: unknown[]) => mintProofs(...args),
  mintProofsForUnit: (...args: unknown[]) => mintProofsForUnit(...args),
  decodeToken: (...args: unknown[]) => decodeToken(...args),
  getWalletForUnit: (...args: unknown[]) => getWalletForUnit(...args),
}))

vi.mock('@/stores/proof-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/proof-db')>()),
  addProofs: (...args: unknown[]) => addProofs(...args),
}))

vi.mock('@/stores/wallet', () => ({
  useWalletStore: Object.assign(
    (selector: (state: { activeMintUrl: string; ensureImplicitWallet: typeof ensureImplicitWallet; walletBackupState: typeof walletBackupState }) => unknown) =>
      selector({ activeMintUrl: 'https://mint.example', ensureImplicitWallet, walletBackupState }),
    {
      getState: () => ({ activeMintUrl: 'https://mint.example', ensureImplicitWallet, walletBackupState }),
    },
  ),
}))

describe('TopUpOverlay', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    createMintQuote.mockReset()
    createMintQuote.mockResolvedValue({ request: 'lnbc1example', expiry: 123 })
    createMintQuoteForUnit.mockReset()
    createMintQuoteForUnit.mockResolvedValue({ request: 'lnbc1score', expiry: 123 })
    waitForMintQuotePaid.mockReset()
    waitForMintQuotePaid.mockResolvedValue(() => undefined)
    waitForMintQuotePaidForUnit.mockReset()
    waitForMintQuotePaidForUnit.mockResolvedValue(() => undefined)
    mintProofs.mockReset()
    mintProofsForUnit.mockReset()
    decodeToken.mockReset()
    decodeToken.mockResolvedValue({
      mint: 'https://mint.example',
      unit: 'msat',
      proofs: [{ id: 'keyset-msat', amount: 15_000, secret: 'incoming', C: 'incoming-c' }],
    })
    getWalletForUnit.mockReset()
    getWalletForUnit.mockResolvedValue({
      receive: vi.fn().mockResolvedValue([{ id: 'keyset-msat', amount: 15_000, secret: 'received', C: 'received-c' }]),
    })
    addProofs.mockReset()
    ensureImplicitWallet.mockReset()
    ensureImplicitWallet.mockResolvedValue(undefined)
    navigate.mockReset()
    walletBackupState = 'none'
  })

  it('shows a dismissible backup warning while still allowing top-up deposits', async () => {
    walletBackupState = 'needs_backup'

    render(
      <TopUpOverlay
        deficit={10_000}
        baseAsset="sat"
        onCancel={vi.fn()}
        onSuccess={vi.fn()}
      />,
    )

    expect(screen.getByText('You must back up your wallet to protect your funds')).toBeInTheDocument()
    expect(screen.getByTestId('top-up-continue')).toBeEnabled()

    await userEvent.click(screen.getByRole('button', { name: 'Backup now' }))
    expect(navigate).toHaveBeenCalledWith('/settings?category=cashu')

    await userEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByText('You must back up your wallet to protect your funds')).not.toBeInTheDocument()
    expect(screen.getByTestId('top-up-continue')).toBeEnabled()
  })

  it('shows USD top-up inputs in dollars while requesting cent subunits', async () => {
    const user = userEvent.setup()

    render(
      <TopUpOverlay
        deficit={1_500}
        baseAsset="usd"
        onCancel={vi.fn()}
        onSuccess={vi.fn()}
      />,
    )

    expect(screen.getByText(/Minimum \$15\.00 to cover the trade/)).toBeInTheDocument()
    expect(screen.getByText('Amount (USD)')).toBeInTheDocument()
    expect(screen.getByTestId('top-up-amount-input')).toHaveValue(18)

    await user.clear(screen.getByTestId('top-up-amount-input'))
    await user.type(screen.getByTestId('top-up-amount-input'), '150')
    await user.click(screen.getByTestId('top-up-continue'))

    await waitFor(() => {
      expect(createMintQuote).toHaveBeenCalledWith(15_000, 'https://mint.example', 'usd')
    })
    expect(await screen.findByTestId('bolt11-display')).toBeInTheDocument()
    expect(screen.getByText('$150.00')).toBeInTheDocument()
  })

  it('shows the full registration fee separately from the top-up deficit', () => {
    render(
      <TopUpOverlay
        deficit={1_500}
        balanceSubunits={1_000}
        feeSubunits={2_500}
        baseAsset="usd"
        onCancel={vi.fn()}
        onSuccess={vi.fn()}
      />,
    )

    expect(screen.getByText('Registration fee')).toBeInTheDocument()
    expect(screen.getByText('$25.00')).toBeInTheDocument()
    expect(screen.getByText('Your balance')).toBeInTheDocument()
    expect(screen.getByText('$10.00')).toBeInTheDocument()
    expect(screen.getByText('Top-up needed')).toBeInTheDocument()
    expect(screen.getByText('$15.00')).toBeInTheDocument()
  })

  it('adds the unit-aware top-up buffer and converts sat-market subunits to sats for the invoice', async () => {
    const user = userEvent.setup()

    render(
      <TopUpOverlay
        deficit={10_000}
        baseAsset="sat"
        onCancel={vi.fn()}
        onSuccess={vi.fn()}
      />,
    )

    expect(screen.getByText(/Minimum 10 sats to cover the trade/)).toBeInTheDocument()
    expect(screen.getByTestId('top-up-amount-input')).toHaveValue(20)

    await user.click(screen.getByTestId('top-up-continue'))

    await waitFor(() => {
      expect(createMintQuote).toHaveBeenCalledWith(20, 'https://mint.example', 'sat')
    })
  })

  it('can mint regular sat proofs for Engine Score top-ups', async () => {
    const user = userEvent.setup()

    render(
      <TopUpOverlay
        deficit={500}
        baseAsset="sat"
        proofUnit="sat"
        minimumDescription="Top up at least 500 sats to cover Engine Score before placing the order."
        onCancel={vi.fn()}
        onSuccess={vi.fn()}
      />,
    )

    expect(screen.getByText(/Top up at least 500 sats/)).toBeInTheDocument()
    expect(screen.getByTestId('top-up-amount-input')).toHaveValue(600)

    await user.click(screen.getByTestId('top-up-continue'))

    await waitFor(() => {
      expect(createMintQuoteForUnit).toHaveBeenCalledWith(600, 'https://mint.example', 'sat')
    })
    expect(createMintQuote).not.toHaveBeenCalled()
  })

  it('accepts a same-mint same-unit ecash token and closes after storing received proofs', async () => {
    const user = userEvent.setup()
    const onSuccess = vi.fn()

    render(
      <TopUpOverlay
        deficit={10_000}
        baseAsset="sat"
        onCancel={vi.fn()}
        onSuccess={onSuccess}
      />,
    )

    await user.click(screen.getByTestId('top-up-method-ecash'))
    await user.type(screen.getByTestId('top-up-ecash-input'), 'cashuB-token')
    await user.click(screen.getByTestId('top-up-ecash-submit'))

    await waitFor(() => {
      expect(decodeToken).toHaveBeenCalledWith('cashuB-token')
    })
    expect(getWalletForUnit).toHaveBeenCalledWith('https://mint.example', 'msat')
    await waitFor(() => {
      expect(addProofs).toHaveBeenCalledWith([
        {
          id: 'keyset-msat',
          amount: 15_000,
          secret: 'received',
          C: 'received-c',
          mintUrl: 'https://mint.example',
          baseAsset: 'sat',
          unit: 'msat',
        },
      ])
      expect(onSuccess).toHaveBeenCalledTimes(1)
    })
  })

  it('fails fast for unsupported top-up base assets', () => {
    expect(() => render(
      <TopUpOverlay
        deficit={1_500}
        baseAsset="jpy"
        onCancel={vi.fn()}
        onSuccess={vi.fn()}
      />,
    )).toThrow(/unsupported base asset: jpy/)
  })
})
