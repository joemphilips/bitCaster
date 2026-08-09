export const portfolioInvalidatedEvent = "bitcaster:portfolio-invalidated";

export interface PortfolioInvalidation {
  readonly walletId: string;
}

export function publishPortfolioInvalidation(invalidation: PortfolioInvalidation): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PortfolioInvalidation>(portfolioInvalidatedEvent, { detail: invalidation }),
  );
}

export function listenForPortfolioInvalidation(
  listener: (invalidation: PortfolioInvalidation) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handleEvent = (event: Event) => {
    if (event instanceof CustomEvent) listener(event.detail as PortfolioInvalidation);
  };
  window.addEventListener(portfolioInvalidatedEvent, handleEvent);
  return () => window.removeEventListener(portfolioInvalidatedEvent, handleEvent);
}
