export interface EncryptedWalletBackupConfiguration {
  readonly realm: string;
  readonly signedOrigin: string;
  readonly transportOrigin: string;
}

export interface EncryptedWalletBackupEnvironment {
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly VITE_ENCRYPTED_BACKUP_REALM?: string;
  readonly VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN?: string;
  readonly VITE_ENCRYPTED_BACKUP_TRANSPORT_ORIGIN?: string;
}

/**
 * Reads the explicit encrypted-backup deployment contract.
 * An absent contract leaves backup disabled until Phase 17 wires deployment config.
 */
export function resolveEncryptedWalletBackupConfiguration(
  env: EncryptedWalletBackupEnvironment = import.meta.env,
): EncryptedWalletBackupConfiguration | null {
  const realm = env.VITE_ENCRYPTED_BACKUP_REALM?.trim() ?? "";
  const signedOrigin = env.VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN?.trim() ?? "";
  const transportOrigin = env.VITE_ENCRYPTED_BACKUP_TRANSPORT_ORIGIN?.trim() ?? "";
  if (!realm && !signedOrigin && !transportOrigin) {
    return null;
  }
  if (!realm || !signedOrigin) {
    throw new Error("encrypted wallet backup configuration is incomplete");
  }
  const requiredSignedOrigin = requireHttpsOrigin(signedOrigin, "signed");
  const requiredTransportOrigin = transportOrigin
    ? requireTransportOrigin(transportOrigin)
    : requiredSignedOrigin;
  if (
    requiredTransportOrigin !== requiredSignedOrigin &&
    !(env.DEV === true && env.PROD !== true)
  ) {
    throw new Error("encrypted wallet backup transport origin must match the signed origin");
  }
  return Object.freeze({
    realm: requireRealm(realm),
    signedOrigin: requiredSignedOrigin,
    transportOrigin: requiredTransportOrigin,
  });
}

/** Rewrites only the network origin. The signed URL stays untouched. */
export function createEncryptedWalletBackupTransportFetch(input: {
  readonly signedOrigin: string;
  readonly transportOrigin: string;
  readonly fetch?: typeof fetch;
}): typeof fetch {
  const signedOrigin = requireHttpsOrigin(input.signedOrigin, "signed");
  const transportOrigin = requireTransportOrigin(input.transportOrigin);
  const dispatch = input.fetch ?? globalThis.fetch;
  if (typeof dispatch !== "function") throw new Error("encrypted backup fetch is unavailable");
  return async (resource, init) => {
    const url = typeof resource === "string" || resource instanceof URL ? new URL(resource) : null;
    if (url === null || url.origin !== signedOrigin) {
      throw new Error("encrypted backup request origin is invalid");
    }
    const transportUrl = `${transportOrigin}${url.pathname}${url.search}`;
    const response = await dispatch(transportUrl, init);
    try {
      requireExactTransportResponse(response, transportUrl);
      return signedResponseFacade(response, url.href);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  };
}

function requireExactTransportResponse(response: Response, transportUrl: string): void {
  if (
    typeof response !== "object" ||
    response === null ||
    response.redirected ||
    typeof response.url !== "string"
  ) {
    throw new Error("encrypted backup transport response is invalid");
  }
  let actual: URL;
  try {
    actual = new URL(response.url);
  } catch {
    throw new Error("encrypted backup transport response is invalid");
  }
  if (actual.href !== new URL(transportUrl).href) {
    throw new Error("encrypted backup transport response is invalid");
  }
}

function signedResponseFacade(response: Response, signedUrl: string): Response {
  const facade = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(facade, "url", { value: signedUrl });
  return facade;
}

function requireRealm(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new Error("encrypted wallet backup realm is invalid");
  }
  return value;
}

function requireHttpsOrigin(value: string, label: string): string {
  const origin = requireOrigin(value, label);
  if (new URL(origin).protocol !== "https:") {
    throw new Error(`encrypted wallet backup ${label} origin must use HTTPS`);
  }
  return origin;
}

function requireTransportOrigin(value: string): string {
  const origin = requireOrigin(value, "transport");
  const parsed = new URL(origin);
  const protocol = parsed.protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("encrypted wallet backup transport origin is invalid");
  }
  if (
    protocol === "http:" &&
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "[::1]"
  ) {
    throw new Error("encrypted wallet backup cleartext transport must be loopback");
  }
  return origin;
}

function requireOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`encrypted wallet backup ${label} origin is invalid`);
  }
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`encrypted wallet backup ${label} origin is invalid`);
  }
  return parsed.origin;
}
