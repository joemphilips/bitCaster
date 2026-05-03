/**
 * The bitCaster(β) wordmark used across the app shell during the open-beta
 * period. Pure inline SVG so it scales cleanly across the desktop (h-16) and
 * mobile (h-14) headers without bitmap rasterization.
 *
 * Design notes (P5.3):
 *  - The "(β)" sits at ~55% of the wordmark's cap-height, italic, with a
 *    thin underline that doubles as the open-beta semaphore.
 *  - All strokes/fills use `currentColor` so the existing Tailwind cascade
 *    (`text-blue-600 dark:text-blue-400`) keeps working without a prop.
 *  - The viewBox is sized so each em ≈ 1 unit; callers control absolute
 *    pixel size with Tailwind text/height classes on the wrapping element.
 */
export function BitCasterLogo({
  className,
  ariaLabel = 'bitCaster (beta)',
}: {
  className?: string
  ariaLabel?: string
}) {
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox="0 0 156 28"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      // Height defaults to 1em so the parent's `text-xl` / `text-2xl` controls size
      style={{ height: '1.1em', width: 'auto' }}
    >
      {/* Wordmark — sized to dominate the lockup. */}
      <text
        x="0"
        y="22"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontWeight={700}
        fontSize="24"
        letterSpacing="-0.01em"
        fill="currentColor"
      >
        bitCaster
      </text>
      {/* Beta marker — italic, ~55% cap-height, baseline-aligned. */}
      <text
        x="118"
        y="22"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontStyle="italic"
        fontWeight={500}
        fontSize="13"
        letterSpacing="0.01em"
        fill="currentColor"
        opacity={0.85}
      >
        (β)
      </text>
      {/* Subtle underline anchoring the beta marker. */}
      <line
        x1="118"
        y1="25"
        x2="151"
        y2="25"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        opacity={0.45}
      />
    </svg>
  )
}
