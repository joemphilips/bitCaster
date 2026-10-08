export type AppEnvironment = "mainnet" | "testnet";

export interface EnvironmentDestination {
  environment: AppEnvironment;
  href: string;
}

/** Resolve only explicit deployment settings. Browser routes cannot select an environment. */
export function resolveEnvironmentDestination(
  environment: unknown,
  alternateOrigin: unknown,
  currentOrigin: string,
): EnvironmentDestination | null {
  if (environment !== "mainnet" && environment !== "testnet") return null;
  if (typeof alternateOrigin !== "string" || alternateOrigin.trim() !== alternateOrigin)
    return null;

  // Validate the original input before URL normalization can remove a path or
  // an empty query/fragment. Reject even empty credentials and backslash URLs.
  if (!/^https:\/\/[^\s/@?#\\]+\/?$/i.test(alternateOrigin)) return null;

  try {
    const target = new URL(alternateOrigin);
    const current = new URL(currentOrigin);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.pathname !== "/" ||
      target.search ||
      target.hash ||
      target.origin === current.origin
    ) {
      return null;
    }

    return {
      environment: environment === "mainnet" ? "testnet" : "mainnet",
      href: `${target.origin}/`,
    };
  } catch {
    return null;
  }
}
