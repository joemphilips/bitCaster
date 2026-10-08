/** The app wordmark inherits its color from the surrounding header. */
export function BitCasterLogo({
  className,
  ariaLabel = "bitCaster",
}: {
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox="0 0 118 28"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      // Height defaults to 1em so the parent's `text-xl` / `text-2xl` controls size
      style={{ height: "1.1em", width: "auto" }}
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
    </svg>
  );
}
