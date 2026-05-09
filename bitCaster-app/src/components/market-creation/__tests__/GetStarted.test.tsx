import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GetStarted } from '../GetStarted'

describe('GetStarted', () => {
  it('does not allow numeric market selection before finite bins are supported', async () => {
    const onOutcomeTypeSelect = vi.fn()
    const user = userEvent.setup()

    render(
      <GetStarted
        outcomeType={null}
        onOutcomeTypeSelect={onOutcomeTypeSelect}
      />,
    )

    const numeric = screen.getByRole('button', { name: /Numeric/i })

    expect(numeric).toBeDisabled()
    await user.click(numeric)
    expect(onOutcomeTypeSelect).not.toHaveBeenCalled()
  })
})
