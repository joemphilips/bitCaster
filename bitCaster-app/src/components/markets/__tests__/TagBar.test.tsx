import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { TagBar } from '../TagBar'
import type { CategoryTag } from '@/types/market'

const categoryTags: CategoryTag[] = [
  { id: 'sports', label: 'Sports', marketCount: 42 },
  { id: 'crypto', label: 'Crypto', marketCount: 100 },
]

describe('TagBar', () => {
  it('renders category tag chips (Row 2 — sort buttons live in SortBar)', () => {
    render(
      <TagBar
        categoryTags={categoryTags}
        selectedTags={[]}
        filtersVisible={false}
        activeFilterCount={0}
      />
    )

    expect(screen.getByText('Sports')).toBeInTheDocument()
    expect(screen.getByText('Crypto')).toBeInTheDocument()
  })

  it('does not render sort dimensions inside the tag chip row (T4.2.d)', () => {
    render(
      <TagBar
        categoryTags={categoryTags}
        selectedTags={[]}
        filtersVisible={false}
        activeFilterCount={0}
      />
    )

    expect(screen.queryByText('Trending')).not.toBeInTheDocument()
    expect(screen.queryByText('Popular')).not.toBeInTheDocument()
    expect(screen.queryByText('New')).not.toBeInTheDocument()
  })

  it('calls onTagSelect when a tag is clicked', async () => {
    const user = userEvent.setup()
    const onTagSelect = vi.fn()

    render(
      <TagBar
        categoryTags={categoryTags}
        selectedTags={[]}
        filtersVisible={false}
        activeFilterCount={0}
        onTagSelect={onTagSelect}
      />
    )

    await user.click(screen.getByText('Sports'))
    expect(onTagSelect).toHaveBeenCalledWith('sports')
  })

  it('calls onToggleFilters when filter button is clicked', async () => {
    const user = userEvent.setup()
    const onToggleFilters = vi.fn()

    render(
      <TagBar
        categoryTags={categoryTags}
        selectedTags={[]}
        filtersVisible={false}
        activeFilterCount={0}
        onToggleFilters={onToggleFilters}
      />
    )

    await user.click(screen.getByTitle('Show filters'))
    expect(onToggleFilters).toHaveBeenCalled()
  })

  it('shows active filter count badge', () => {
    render(
      <TagBar
        categoryTags={categoryTags}
        selectedTags={[]}
        filtersVisible={false}
        activeFilterCount={2}
      />
    )

    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders aria-pressed=true on every selected chip (multi-select)', () => {
    render(
      <TagBar
        categoryTags={categoryTags}
        selectedTags={['sports', 'crypto']}
        filtersVisible={false}
        activeFilterCount={0}
      />,
    )
    const sports = screen.getByText('Sports').closest('button')!
    const crypto = screen.getByText('Crypto').closest('button')!
    expect(sports.getAttribute('aria-pressed')).toBe('true')
    expect(crypto.getAttribute('aria-pressed')).toBe('true')
  })

  it('hides the Clear-all chip when no tags are selected', () => {
    render(
      <TagBar
        categoryTags={categoryTags}
        selectedTags={[]}
        filtersVisible={false}
        activeFilterCount={0}
      />,
    )
    expect(screen.queryByTestId('market-tag-clear')).toBeNull()
  })

  it('shows the Clear-all chip when at least one tag is selected and fires onClearTags', async () => {
    const user = userEvent.setup()
    const onClearTags = vi.fn()
    render(
      <TagBar
        categoryTags={categoryTags}
        selectedTags={['sports']}
        filtersVisible={false}
        activeFilterCount={0}
        onClearTags={onClearTags}
      />,
    )
    const clear = screen.getByTestId('market-tag-clear')
    expect(clear).toBeInTheDocument()
    await user.click(clear)
    expect(onClearTags).toHaveBeenCalledOnce()
  })
})
