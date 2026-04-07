import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { BasicInfo } from '../BasicInfo'
import type { WizardStepBasicInfo } from '@/types/market-creation'

function futureDate(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() + 1)
  return d.toISOString().slice(0, 16)
}

function pastDate(): string {
  return '2020-01-01T00:00'
}

const defaultData: WizardStepBasicInfo = {
  imageFile: null,
  title: '',
  categoryTags: [],
  closingDate: '',
}

const categoryTags = ['politics', 'sports', 'crypto']

describe('BasicInfo', () => {
  it('disables Next when title and closing date are empty', () => {
    render(<BasicInfo data={defaultData} categoryTags={categoryTags} />)
    const nextBtn = screen.getByRole('button', { name: 'Next' })
    expect(nextBtn).toBeDisabled()
  })

  it('disables Next when title is present but closing date is empty', () => {
    render(<BasicInfo data={{ ...defaultData, title: 'Test Market' }} categoryTags={categoryTags} />)
    const nextBtn = screen.getByRole('button', { name: 'Next' })
    expect(nextBtn).toBeDisabled()
  })

  it('disables Next when closing date is in the past', () => {
    render(
      <BasicInfo
        data={{ ...defaultData, title: 'Test Market', closingDate: pastDate() }}
        categoryTags={categoryTags}
      />,
    )
    const nextBtn = screen.getByRole('button', { name: 'Next' })
    expect(nextBtn).toBeDisabled()
  })

  it('enables Next when title is present and closing date is in the future', () => {
    render(
      <BasicInfo
        data={{ ...defaultData, title: 'Test Market', closingDate: futureDate() }}
        categoryTags={categoryTags}
      />,
    )
    const nextBtn = screen.getByRole('button', { name: 'Next' })
    expect(nextBtn).toBeEnabled()
  })

  it('renders datetime input with min attribute', () => {
    render(<BasicInfo data={defaultData} categoryTags={categoryTags} />)
    const dateInput = document.querySelector('input[type="datetime-local"]')
    expect(dateInput).not.toBeNull()
    expect(dateInput!.getAttribute('min')).toBeTruthy()
  })

  it('calls onTitleChange when title is typed', async () => {
    const user = userEvent.setup()
    const onTitleChange = vi.fn()
    render(
      <BasicInfo
        data={defaultData}
        categoryTags={categoryTags}
        onTitleChange={onTitleChange}
      />,
    )
    const titleInput = screen.getByPlaceholderText('Type title...')
    await user.type(titleInput, 'A')
    expect(onTitleChange).toHaveBeenCalledWith('A')
  })

  it('calls onNext when Next is clicked with valid data', async () => {
    const user = userEvent.setup()
    const onNext = vi.fn()
    render(
      <BasicInfo
        data={{ ...defaultData, title: 'Test', closingDate: futureDate() }}
        categoryTags={categoryTags}
        onNext={onNext}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(onNext).toHaveBeenCalledOnce()
  })
})
