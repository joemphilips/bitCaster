import type { ReactNode } from "react";

/**
 * The wallet banners above every page. The stack uses the page container, so
 * a banner starts at the page content edge and keeps a gap below the header.
 * Each banner renders nothing when it has nothing to say. Then the stack is
 * empty, and `empty:hidden` removes it, so it adds no gap.
 */
export function ShellBanners({ children }: { readonly children: ReactNode }) {
  return <div className="mx-auto max-w-7xl px-4 pt-4 empty:hidden sm:px-6 lg:px-8">{children}</div>;
}
