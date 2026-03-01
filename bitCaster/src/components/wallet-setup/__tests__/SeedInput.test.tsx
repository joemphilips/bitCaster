import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SeedInput } from '../SeedInput'

const validPhrase = [
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'about',
]

describe('SeedInput', () => {
  it('pasting 12-word phrase calls onSeedPhrasePaste', async () => {
    const onPaste = vi.fn()
    const user = userEvent.setup()

    render(
      <SeedInput
        inputSeedWords={Array(12).fill('')}
        onSeedPhrasePaste={onPaste}
      />
    )

    const firstInput = screen.getAllByPlaceholderText('word')[0]
    await user.click(firstInput)
    await user.paste(validPhrase.join(' '))

    expect(onPaste).toHaveBeenCalledWith(validPhrase.join(' '))
  })

  it('"Recover Wallet" button disabled until all 12 fields are valid BIP-39 words with valid checksum', () => {
    render(
      <SeedInput
        inputSeedWords={Array(12).fill('')}
      />
    )
    expect(screen.getByRole('button', { name: /recover wallet/i })).toBeDisabled()
  })

  it('"Recover Wallet" enabled with valid 12-word mnemonic', () => {
    render(
      <SeedInput inputSeedWords={validPhrase} />
    )
    expect(screen.getByRole('button', { name: /recover wallet/i })).toBeEnabled()
  })

  it('"Recover Wallet" disabled when words are valid individually but fail checksum', () => {
    const badChecksum = [
      'zoo', 'zoo', 'zoo', 'zoo',
      'zoo', 'zoo', 'zoo', 'zoo',
      'zoo', 'zoo', 'zoo', 'abandon',
    ]
    render(
      <SeedInput inputSeedWords={badChecksum} />
    )
    expect(screen.getByRole('button', { name: /recover wallet/i })).toBeDisabled()
    expect(screen.getByText(/invalid mnemonic/i)).toBeInTheDocument()
  })
})
