import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { TagBar } from '../TagBar'
import type { MetaTag, CategoryTag } from '@/types/market'

const metaTags: MetaTag[] = [
  { id: 'trending', label: 'Trending', description: 'High activity' },
  { id: 'popular', label: 'Popular', description: 'Most volume' },
]

const categoryTags: CategoryTag[] = [
  { id: 'sports', label: 'Sports', marketCount: 42 },
  { id: 'crypto', label: 'Crypto', marketCount: 100 },
]

describe('TagBar', () => {
  it('renders meta tags and category tags', () => {
    render(
      <TagBar
        metaTags={metaTags}
        categoryTags={categoryTags}
        selectedTag={null}
        filtersVisible={false}
        activeFilterCount={0}
      />
    )

    expect(screen.getByText('Trending')).toBeInTheDocument()
    expect(screen.getByText('Popular')).toBeInTheDocument()
    expect(screen.getByText('Sports')).toBeInTheDocument()
    expect(screen.getByText('Crypto')).toBeInTheDocument()
  })

  it('calls onTagSelect when a tag is clicked', async () => {
    const user = userEvent.setup()
    const onTagSelect = vi.fn()

    render(
      <TagBar
        metaTags={metaTags}
        categoryTags={categoryTags}
        selectedTag={null}
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
        metaTags={metaTags}
        categoryTags={categoryTags}
        selectedTag={null}
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
        metaTags={metaTags}
        categoryTags={categoryTags}
        selectedTag={null}
        filtersVisible={false}
        activeFilterCount={2}
      />
    )

    expect(screen.getByText('2')).toBeInTheDocument()
  })
})
