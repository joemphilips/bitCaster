import type { ComponentType, MouseEventHandler, ReactNode } from "react";
import type { LucideProps } from "lucide-react";

interface PrimaryGradientButtonProps {
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /**
   * Lucide icon rendered at 20px on the left. Passed as a component
   * rather than an element so the button controls sizing / position.
   */
  icon: ComponentType<LucideProps>;
  children: ReactNode;
  disabled?: boolean;
  type?: "button" | "submit";
  /**
   * Forwarded so the button is addressable in E2E tests that scope by
   * role+name. Defaults to the button's text content otherwise.
   */
  ariaLabel?: string;
}

/**
 * The "Create Market" style CTA — a blue gradient pill with a shimmer
 * animation, used for the two primary calls to action in the shell
 * (Create Market on /creator, Connect Nostr on /portfolio when Anon).
 * Any future tweaks to the CTA style land here instead of drifting
 * between two hand-copied className strings.
 */
export function PrimaryGradientButton({
  onClick,
  icon: Icon,
  children,
  disabled,
  type = "button",
  ariaLabel,
}: PrimaryGradientButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-blue-600 via-blue-600 to-blue-700 px-6 py-3 text-base font-bold text-white shadow-lg shadow-blue-500/30 transition-all hover:scale-[1.02] hover:shadow-xl hover:shadow-blue-500/40 active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
    >
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_3s_infinite] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      <Icon className="relative h-5 w-5" />
      <span className="relative">{children}</span>
    </button>
  );
}
