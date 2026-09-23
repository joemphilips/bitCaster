import { decodeDurableCustodyScopeInput } from "@bitcaster/client-sdk/durableCustody";
import type { BitcasterDB } from "../stores/proof-db";
import { EncryptedWalletBackupEnrollmentDexieStore } from "../stores/encrypted-wallet-backup-enrollment-db";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../stores/encrypted-wallet-backup-v2-db";
import { resolveEncryptedWalletBackupConfiguration } from "./encryptedWalletBackupConfig";

const RECOVERY_REQUIRED_MESSAGE =
  "Another browser changed this wallet. Reload to start recovery before making a new wallet change.";
const STARTUP_AUTHENTICATION_PENDING_MESSAGE =
  "Wallet backup startup is still authenticating this wallet. Try again before making a new wallet change.";

type BrowserWalletBackupAuthenticationState =
  | {
      readonly token: symbol;
      readonly status: "pending";
    }
  | {
      readonly token: symbol;
      readonly status: "authenticated";
      readonly enrollmentEpoch: number;
      readonly requestAuthPublicKey: string;
    };

const authenticationByDatabase = new WeakMap<
  BitcasterDB,
  Map<string, BrowserWalletBackupAuthenticationState>
>();

export interface BrowserWalletBackupAuthenticationSession {
  markAuthenticated(enrollmentEpoch: number, requestAuthPublicKey: string): boolean;
  markPending(): void;
  stop(): void;
}

export class BrowserWalletRecoveryRequiredError extends Error {
  readonly code = "browser-wallet-recovery-required";

  constructor(
    readonly reason: "genuine-conflict" | "startup-authentication-pending" = "genuine-conflict",
  ) {
    super(
      reason === "genuine-conflict"
        ? RECOVERY_REQUIRED_MESSAGE
        : STARTUP_AUTHENTICATION_PENDING_MESSAGE,
    );
    this.name = "BrowserWalletRecoveryRequiredError";
  }
}

/** Starts one process-local authentication session before the driver does asynchronous work. */
export function beginBrowserWalletBackupAuthenticationSession(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly realm: string;
}): BrowserWalletBackupAuthenticationSession {
  const key = authenticationKey(input.scopeId, input.realm);
  const token = Symbol("browser-wallet-backup-authentication");
  const sessions = authenticationSessions(input.database);
  sessions.set(key, { token, status: "pending" });
  let stopped = false;

  return Object.freeze({
    markAuthenticated(enrollmentEpoch: number, requestAuthPublicKey: string): boolean {
      if (
        !Number.isSafeInteger(enrollmentEpoch) ||
        enrollmentEpoch < 1 ||
        !/^[0-9a-f]{64}$/.test(requestAuthPublicKey)
      ) {
        throw new Error("browser wallet backup authentication identity is invalid");
      }
      if (stopped || sessions.get(key)?.token !== token) return false;
      sessions.set(key, {
        token,
        status: "authenticated",
        enrollmentEpoch,
        requestAuthPublicKey,
      });
      return true;
    },
    markPending(): void {
      if (stopped || sessions.get(key)?.token !== token) return;
      sessions.set(key, { token, status: "pending" });
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (sessions.get(key)?.token === token) sessions.delete(key);
      if (sessions.size === 0) authenticationByDatabase.delete(input.database);
    },
  });
}

/** Refuse only new writes for the active enrolled backup authority. */
export async function requireBrowserWalletNewWritePermission(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
}): Promise<void> {
  const configuration = resolveEncryptedWalletBackupConfiguration();
  if (configuration === null) return;

  const scope = decodeDurableCustodyScopeInput(input.scopeId);
  if (scope.scopeKind !== "wallet") {
    throw new Error("The browser wallet write permission requires a wallet scope.");
  }
  const requireRegisteredSession = async (): Promise<boolean> => {
    const session = readAuthenticationSession(input.database, input.scopeId, configuration.realm);
    if (session === undefined) return false;
    await requireAuthenticatedSessionPermission({
      ...input,
      realm: configuration.realm,
      walletId: scope.walletId,
      session,
    });
    return true;
  };
  if (await requireRegisteredSession()) return;

  const enrollmentRow = await input.database.encryptedWalletBackupEnrollmentResults.get([
    configuration.realm,
    scope.walletId,
  ]);
  if (await requireRegisteredSession()) return;
  if (enrollmentRow === undefined) return;

  const enrollmentStore = new EncryptedWalletBackupEnrollmentDexieStore({
    database: input.database,
    scopeId: input.scopeId,
    realm: configuration.realm,
    walletId: scope.walletId,
    requestAuthPublicKey: enrollmentRow.record.requestAuthPublicKey,
  });
  const enrollment = await enrollmentStore.read();
  if (await requireRegisteredSession()) return;
  if (enrollment === null) return;

  const authority = new EncryptedWalletBackupV2DexieAuthorityStore({
    database: input.database,
    scopeId: input.scopeId,
    realm: enrollment.realm,
    walletId: enrollment.walletId,
    enrollmentEpoch: enrollment.observedEnrollmentEpoch,
    requestAuthPublicKey: enrollment.requestAuthPublicKey,
  });
  const acceptedHead = await authority.readAcceptedHead();
  if (await requireRegisteredSession()) return;
  if (acceptedHead === null) return;
  if (acceptedHead.localRecoveryStatus === "recovery-required") {
    throw new BrowserWalletRecoveryRequiredError("genuine-conflict");
  }
  throw new BrowserWalletRecoveryRequiredError("startup-authentication-pending");
}

async function requireAuthenticatedSessionPermission(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly realm: string;
  readonly walletId: string;
  readonly session: BrowserWalletBackupAuthenticationState;
}): Promise<void> {
  if (input.session.status === "pending") {
    throw new BrowserWalletRecoveryRequiredError("startup-authentication-pending");
  }
  const authority = new EncryptedWalletBackupV2DexieAuthorityStore({
    database: input.database,
    scopeId: input.scopeId,
    realm: input.realm,
    walletId: input.walletId,
    enrollmentEpoch: input.session.enrollmentEpoch,
    requestAuthPublicKey: input.session.requestAuthPublicKey,
  });
  const acceptedHead = await authority.readAcceptedHead();
  const current = readAuthenticationSession(input.database, input.scopeId, input.realm);
  if (
    current?.status !== "authenticated" ||
    current.token !== input.session.token ||
    current.enrollmentEpoch !== input.session.enrollmentEpoch ||
    current.requestAuthPublicKey !== input.session.requestAuthPublicKey
  ) {
    throw new BrowserWalletRecoveryRequiredError("startup-authentication-pending");
  }
  if (acceptedHead === null) {
    throw new BrowserWalletRecoveryRequiredError("startup-authentication-pending");
  }
  if (acceptedHead.localRecoveryStatus === "recovery-required") {
    throw new BrowserWalletRecoveryRequiredError("genuine-conflict");
  }
}

function authenticationSessions(
  database: BitcasterDB,
): Map<string, BrowserWalletBackupAuthenticationState> {
  const current = authenticationByDatabase.get(database);
  if (current !== undefined) return current;
  const created = new Map<string, BrowserWalletBackupAuthenticationState>();
  authenticationByDatabase.set(database, created);
  return created;
}

function authenticationKey(scopeId: string, realm: string): string {
  return `${realm}\u0000${scopeId}`;
}

function readAuthenticationSession(
  database: BitcasterDB,
  scopeId: string,
  realm: string,
): BrowserWalletBackupAuthenticationState | undefined {
  return authenticationByDatabase.get(database)?.get(authenticationKey(scopeId, realm));
}
