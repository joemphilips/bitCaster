import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HorizontalPager } from '../HorizontalPager'

/**
 * jsdom has no layout — `scrollWidth` / `clientWidth` are always 0, so
 * the pager's `checkScroll` won't show chevrons unless we patch the
 * geometry on `HTMLDivElement.prototype` BEFORE the component mounts.
 */
const originalDescriptors = {
  scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  scrollLeft: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollLeft'),
  scrollBy: Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, 'scrollBy'),
}

function restoreDescriptor(
  proto: typeof HTMLElement.prototype,
  name: 'scrollWidth' | 'clientWidth' | 'scrollLeft',
) {
  const original = originalDescriptors[name]
  if (original) {
    Object.defineProperty(proto, name, original)
  } else {
    delete (proto as unknown as Record<string, unknown>)[name]
  }
}

function patchGeometry(opts: { scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() { return opts.scrollWidth },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return opts.clientWidth },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get() { return opts.scrollLeft ?? 0 },
    set() { /* assertion target is `scrollBy`, not the setter */ },
  })
}

describe('HorizontalPager', () => {
  beforeEach(() => {
    HTMLDivElement.prototype.scrollBy = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    restoreDescriptor(HTMLElement.prototype, 'scrollWidth')
    restoreDescriptor(HTMLElement.prototype, 'clientWidth')
    restoreDescriptor(HTMLElement.prototype, 'scrollLeft')
    if (originalDescriptors.scrollBy) {
      Object.defineProperty(HTMLDivElement.prototype, 'scrollBy', originalDescriptors.scrollBy)
    } else {
      delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).scrollBy
    }
  })

  it('renders children inside the scroll container', () => {
    render(
      <HorizontalPager scrollerTestId="t">
        <span>alpha</span>
        <span>beta</span>
      </HorizontalPager>,
    )
    const scroller = screen.getByTestId('t')
    expect(scroller).toHaveTextContent('alpha')
    expect(scroller).toHaveTextContent('beta')
  })

  it('hides the native scrollbar via inline style + class', () => {
    render(
      <HorizontalPager scrollerTestId="t">
        <span>x</span>
      </HorizontalPager>,
    )
    const scroller = screen.getByTestId('t')
    expect(scroller.className).toContain('scrollbar-hide')
    expect(scroller.style.scrollbarWidth).toBe('none')
  })

  it('forwards an explicit role to the scroll container', () => {
    render(
      <HorizontalPager scrollerTestId="t" role="list" ariaLabel="Items">
        <span role="listitem">x</span>
      </HorizontalPager>,
    )
    expect(screen.getByTestId('t')).toHaveAttribute('role', 'list')
    expect(screen.getByTestId('t')).toHaveAttribute('aria-label', 'Items')
  })

  it('omits both chevrons when there is no overflow', () => {
    render(
      <HorizontalPager scrollerTestId="t">
        <span>x</span>
      </HorizontalPager>,
    )
    expect(screen.queryByTestId('horizontal-pager-left')).toBeNull()
    expect(screen.queryByTestId('horizontal-pager-right')).toBeNull()
  })

  it('shows the right chevron when content overflows and triggers scrollBy on click', async () => {
    patchGeometry({ scrollWidth: 800, clientWidth: 200 })
    render(
      <HorizontalPager scrollerTestId="t">
        <span>x</span>
      </HorizontalPager>,
    )

    const right = await screen.findByTestId('horizontal-pager-right')
    expect(screen.queryByTestId('horizontal-pager-left')).toBeNull()

    const user = userEvent.setup()
    await user.click(right)

    const scrollBy = HTMLDivElement.prototype.scrollBy as unknown as ReturnType<typeof vi.fn>
    expect(scrollBy).toHaveBeenCalledTimes(1)
    const [arg] = scrollBy.mock.calls[0] as [{ left: number; behavior: string }]
    expect(arg.behavior).toBe('smooth')
    expect(arg.left).toBeGreaterThan(0)
  })

  it('shows the left chevron once scrolled past the start', async () => {
    patchGeometry({ scrollWidth: 800, clientWidth: 200, scrollLeft: 100 })
    render(
      <HorizontalPager scrollerTestId="t">
        <span>x</span>
      </HorizontalPager>,
    )
    expect(await screen.findByTestId('horizontal-pager-left')).toBeInTheDocument()
    expect(await screen.findByTestId('horizontal-pager-right')).toBeInTheDocument()
  })
})
