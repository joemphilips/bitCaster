import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decode } from "cborg";
import {
  encodeCanonicalBackupCbor,
  preflightEncryptedBackupAccountIntentCbor,
  structurallyPreflightEncryptedBackupAccountRequestCbor,
} from "./encryptedWalletBackupCbor.ts";
import {
  equalBytes,
  requireBytes,
  requireExactHttpsUrl,
  requireInteger,
  requireRealm,
  requireValidXOnlyPublicKey,
} from "./encryptedWalletBackupServerValidation.ts";

export * from "./encryptedWalletBackupDelegatedServerCodec.ts";

const ACCOUNT_REQUEST_MAX_BYTES = 20 * 1_024;
const ACCOUNT_AUTHORIZATION_MAX_BYTES = 16 * 1_024;

export type DecodedEncryptedWalletBackupAccountAction =
  | "enroll"
  | "revoke"
  | "delete";

export interface DecodedEncryptedWalletBackupAccountIntent {
  readonly formatVersion: 1;
  readonly action: DecodedEncryptedWalletBackupAccountAction;
  readonly method: "POST" | "DELETE";
  readonly url: string;
  readonly realm: string;
  readonly vaultId: string;
  readonly requestAuthPublicKey: string;
  readonly expectedEnrollmentEpoch: number;
  readonly operationId: string;
}

export interface DecodedEncryptedWalletBackupAccountRequest {
  readonly formatVersion: 1;
  readonly canonicalIntent: Uint8Array;
  readonly intentDigest: string;
  readonly authorizationScheme: string;
  readonly authorization: Uint8Array;
  readonly intent: DecodedEncryptedWalletBackupAccountIntent;
}

/** Strict server-side decoder for the public account-lifecycle envelope. */
export function decodeEncryptedWalletBackupAccountRequest(
  bytes: Uint8Array,
): DecodedEncryptedWalletBackupAccountRequest {
  const requestBytes = requireBytes(
    bytes,
    1,
    ACCOUNT_REQUEST_MAX_BYTES,
    "account request",
  );
  structurallyPreflightEncryptedBackupAccountRequestCbor(requestBytes);
  const decoded = decode(requestBytes);
  if (
    !equalBytes(requestBytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 6 ||
    decoded[0] !== 1 ||
    decoded[1] !== "backup-account-request"
  ) {
    throw new Error("encrypted backup account request is invalid");
  }
  const canonicalIntent = requireBytes(
    decoded[2],
    1,
    4_096,
    "account canonical intent",
  );
  const intentDigestBytes = requireBytes(
    decoded[3],
    32,
    32,
    "account intent digest",
  );
  if (!equalBytes(sha256(canonicalIntent), intentDigestBytes)) {
    throw new Error("encrypted backup account request digest is invalid");
  }
  const authorizationScheme = requireEncryptedWalletBackupAuthorizationScheme(
    decoded[4],
  );
  const authorization = requireBytes(
    decoded[5],
    1,
    ACCOUNT_AUTHORIZATION_MAX_BYTES,
    "account authorization",
  );
  return Object.freeze({
    formatVersion: 1,
    canonicalIntent: canonicalIntent.slice(),
    intentDigest: bytesToHex(intentDigestBytes),
    authorizationScheme,
    authorization: authorization.slice(),
    intent: decodeEncryptedWalletBackupAccountIntent(canonicalIntent),
  });
}

export function decodeEncryptedWalletBackupAccountIntent(
  bytes: Uint8Array,
): DecodedEncryptedWalletBackupAccountIntent {
  const intentBytes = requireBytes(bytes, 1, 4_096, "account canonical intent");
  preflightEncryptedBackupAccountIntentCbor(intentBytes);
  const decoded = decode(intentBytes);
  if (
    !equalBytes(intentBytes, encodeCanonicalBackupCbor(decoded)) ||
    !Array.isArray(decoded) ||
    decoded.length !== 10 ||
    decoded[0] !== 1 ||
    decoded[1] !== "backup-account-operation"
  ) {
    throw new Error("encrypted backup account intent is invalid");
  }
  const action = requireAction(decoded[2]);
  const method = requireMethod(decoded[3]);
  if (
    (action === "delete" && method !== "DELETE") ||
    (action !== "delete" && method !== "POST")
  ) {
    throw new Error("encrypted backup account intent method is invalid");
  }
  const expectedEnrollmentEpoch = requireInteger(
    decoded[8],
    action === "enroll" ? 0 : 1,
    "account enrollment epoch",
  );
  return Object.freeze({
    formatVersion: 1,
    action,
    method,
    url: requireExactHttpsUrl(decoded[4]),
    realm: requireRealm(decoded[5]),
    vaultId: bytesToHex(requireBytes(decoded[6], 32, 32, "account vault id")),
    requestAuthPublicKey: bytesToHex(
      requireValidXOnlyPublicKey(decoded[7], "account request public key"),
    ),
    expectedEnrollmentEpoch,
    operationId: bytesToHex(
      requireBytes(decoded[9], 16, 16, "account operation id"),
    ),
  });
}

function requireAction(
  value: unknown,
): DecodedEncryptedWalletBackupAccountAction {
  if (value !== "enroll" && value !== "revoke" && value !== "delete") {
    throw new Error("encrypted backup account action is invalid");
  }
  return value;
}

function requireMethod(value: unknown): "POST" | "DELETE" {
  if (value !== "POST" && value !== "DELETE") {
    throw new Error("encrypted backup account method is invalid");
  }
  return value;
}

export function requireEncryptedWalletBackupAuthorizationScheme(
  value: unknown,
): string {
  if (
    typeof value !== "string" ||
    !/^[a-z](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)
  ) {
    throw new Error("encrypted backup account authorization scheme is invalid");
  }
  return value;
}
