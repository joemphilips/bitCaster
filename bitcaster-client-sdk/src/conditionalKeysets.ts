import type { CtfConditionalKeysetInfo } from "./ctfSplit.ts";

export interface ConditionalKeysetTransport {
  getConditionalKeysets?(query?: {
    active?: boolean;
  }): Promise<CtfConditionalKeysetInfo[]>;
}

export interface GetConditionalKeysetsOptions {
  transport: ConditionalKeysetTransport;
  mintUrl?: string;
  active?: boolean;
  cacheKey?: string;
  ttlMs?: number;
  forceRefresh?: boolean;
  now?: () => number;
}

interface CacheEntry {
  expiresAt: number;
  value: CtfConditionalKeysetInfo[];
}

const cache = new Map<string, CacheEntry>();

export async function getConditionalKeysets(
  options: GetConditionalKeysetsOptions,
): Promise<CtfConditionalKeysetInfo[]> {
  const fn = options.transport.getConditionalKeysets;
  if (!fn) {
    throw new Error(
      options.mintUrl
        ? `mint ${options.mintUrl} transport does not expose getConditionalKeysets; conditional-keyset preflight is unavailable`
        : "CTF transport does not expose getConditionalKeysets; conditional-keyset preflight is unavailable",
    );
  }

  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now?.() ?? Date.now();
  const key = options.cacheKey ?? `${options.mintUrl ?? "<unknown-mint>"}:active=${options.active ?? "all"}`;
  const cached = cache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > now) {
    return structuredClone(cached.value);
  }

  const value = await fn.call(options.transport, options.active === undefined ? undefined : { active: options.active });
  cache.set(key, {
    expiresAt: now + ttlMs,
    value: structuredClone(value),
  });
  return structuredClone(value);
}

export function clearConditionalKeysetsCache(cacheKey?: string): void {
  if (cacheKey === undefined) {
    cache.clear();
    return;
  }
  cache.delete(cacheKey);
}
