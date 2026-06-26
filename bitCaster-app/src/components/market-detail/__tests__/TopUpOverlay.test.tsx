import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { TopUpOverlay } from '../TopUpOverlay'

const createMintQuote = vi.fn()
const waitForMintQuotePaid = vi.fn()
const mintProofs = vi.fn()
const addProofs = vi.fn()
const ensureImplicitWallet = vi.fn()

vi.mock('@/lib/cashu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cashu')>()),
  FEE_BUFFER_SATS: 1_000,
  createMintQuote: (...args: unknown[]) => createMintQuote(...args),
  waitForMintQuotePaid: (...args: unknown[]) => waitForMintQuotePaid(...args),
  mintProofs: (...args: unknown[]) => mintProofs(...args),
}))

vi.mock('@/stores/proof-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/proof-db')>()),
  addProofs: (...args: unknown[]) => addProofs(...args),
}))

vi.mock('@/stores/wallet', () => ({
  useWalletStore: Object.assign(
    (selector: (state: { activeMintUrl: string; ensureImplicitWallet: typeof ensureImplicitWallet }) => unknown) =>
      selector({ activeMintUrl: 'https://mint.example', ensureImplicitWallet }),
    {
      getState: () => ({ activeMintUrl: 'https://mint.example', ensureImplicitWallet }),
    },
  ),
}))

describe('TopUpOverlay', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    createMintQuote.mockReset()
    createMintQuote.mockResolvedValue({ request: 'lnbc1example', expiry: 123 })
    waitForMintQuotePaid.mockReset()
    waitForMintQuotePaid.mockResolvedValue(() => undefined)
    mintProofs.mockReset()
    addProofs.mockReset()
    ensureImplicitWallet.mockReset()
    ensureImplicitWallet.mockResolvedValue(undefined)
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
    expect(screen.getByTestId('top-up-amount-input')).toHaveValue(15)

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

  it('converts sat-market deficit subunits to sats for the top-up invoice', async () => {
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
    expect(screen.getByTestId('top-up-amount-input')).toHaveValue(1_010)

    await user.click(screen.getByTestId('top-up-continue'))

    await waitFor(() => {
      expect(createMintQuote).toHaveBeenCalledWith(1_010, 'https://mint.example', 'sat')
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
