import { decodeCanonicalMintOrigin } from "@bitcaster/client-sdk/durableCustody";
import { browserWalletScope } from "@/lib/browserCtfRangeOrderSource";
import type { BrowserDurableOutgoingCashuContext } from "@/lib/browserDurableOutgoingCashuTransfer";
import { withWalletProfileLock } from "@/lib/walletProfileLock";
import { db, type BrowserParticipationScoreDeliveryPointerRow } from "@/stores/proof-db";

export interface BrowserParticipationScoreDeliveryPointer {
  readonly deliveryId: string;
  readonly purchaseEpoch: number;
  readonly revision: number;
}

/** Read one validated local coordination pointer. This does not read wallet authority. */
export async function readBrowserParticipationScoreDeliveryPointer(input: {
  readonly accountSubject: string;
  readonly mintUrl: string;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<BrowserParticipationScoreDeliveryPointer | null> {
  const scope = browserWalletScope(input.context.seed);
  const mintUrl = decodeCanonicalMintOrigin(input.mintUrl);
  const accountSubject = requireAccountSubject(input.accountSubject);
  input.context.requireCapturedProfile();
  const row = await (input.context.database ?? db).participationScoreDeliveryPointers.get([
    scope.scopeId,
    mintUrl,
    accountSubject,
  ]);
  input.context.requireCapturedProfile();
  return row === undefined ? null : decodePointer(row, scope.scopeId, mintUrl, accountSubject);
}

/** Claim one current delivery id under the wallet lock. Existing current work always wins. */
export async function claimBrowserParticipationScoreDeliveryPointer(input: {
  readonly deliveryId: string;
  readonly purchaseEpoch: number;
  readonly accountSubject: string;
  readonly mintUrl: string;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<BrowserParticipationScoreDeliveryPointer> {
  const scope = browserWalletScope(input.context.seed);
  const mintUrl = decodeCanonicalMintOrigin(input.mintUrl);
  const accountSubject = requireAccountSubject(input.accountSubject);
  const deliveryId = requireUuid(input.deliveryId);
  const purchaseEpoch = requireEpoch(input.purchaseEpoch);
  const database = input.context.database ?? db;
  return withWalletProfileLock(
    scope.scopeId,
    () =>
      database.transaction("rw", database.participationScoreDeliveryPointers, async () => {
        input.context.requireCapturedProfile();
        const key: [string, string, string] = [scope.scopeId, mintUrl, accountSubject];
        const current = await database.participationScoreDeliveryPointers.get(key);
        input.context.requireCapturedProfile();
        if (current !== undefined) {
          return decodePointer(current, scope.scopeId, mintUrl, accountSubject);
        }
        const row: BrowserParticipationScoreDeliveryPointerRow = {
          scopeId: scope.scopeId,
          mintUrl,
          accountSubject,
          deliveryId,
          purchaseEpoch,
          revision: 0,
        };
        try {
          await database.participationScoreDeliveryPointers.add(row);
        } catch {
          const concurrent = await database.participationScoreDeliveryPointers.get(key);
          input.context.requireCapturedProfile();
          if (concurrent === undefined)
            throw new Error("Participation Score pointer claim conflicted");
          return decodePointer(concurrent, scope.scopeId, mintUrl, accountSubject);
        }
        input.context.requireCapturedProfile();
        return { deliveryId, purchaseEpoch, revision: 0 };
      }),
    input.context.lockManager,
  );
}

/** Clear only the exact current pointer after authoritative credit and local acknowledgement. */
export async function clearBrowserParticipationScoreDeliveryPointer(input: {
  readonly pointer: BrowserParticipationScoreDeliveryPointer;
  readonly accountSubject: string;
  readonly mintUrl: string;
  readonly context: BrowserDurableOutgoingCashuContext;
}): Promise<void> {
  const scope = browserWalletScope(input.context.seed);
  const mintUrl = decodeCanonicalMintOrigin(input.mintUrl);
  const accountSubject = requireAccountSubject(input.accountSubject);
  const expected = decodePointer(
    {
      scopeId: scope.scopeId,
      mintUrl,
      accountSubject,
      ...input.pointer,
    },
    scope.scopeId,
    mintUrl,
    accountSubject,
  );
  const database = input.context.database ?? db;
  await withWalletProfileLock(
    scope.scopeId,
    () =>
      database.transaction("rw", database.participationScoreDeliveryPointers, async () => {
        input.context.requireCapturedProfile();
        const key: [string, string, string] = [scope.scopeId, mintUrl, accountSubject];
        const current = await database.participationScoreDeliveryPointers.get(key);
        input.context.requireCapturedProfile();
        if (current === undefined) return;
        const actual = decodePointer(current, scope.scopeId, mintUrl, accountSubject);
        if (actual.deliveryId !== expected.deliveryId || actual.revision !== expected.revision) {
          throw new Error("Participation Score pointer conflicts");
        }
        await database.participationScoreDeliveryPointers.delete(key);
        input.context.requireCapturedProfile();
      }),
    input.context.lockManager,
  );
}

function decodePointer(
  value: BrowserParticipationScoreDeliveryPointerRow,
  scopeId: string,
  mintUrl: string,
  accountSubject: string,
): BrowserParticipationScoreDeliveryPointer {
  if (
    value.scopeId !== scopeId ||
    value.mintUrl !== mintUrl ||
    value.accountSubject !== accountSubject
  ) {
    throw new Error("Participation Score pointer is foreign");
  }
  return {
    deliveryId: requireUuid(value.deliveryId),
    purchaseEpoch: requireEpoch(value.purchaseEpoch),
    revision: requireRevision(value.revision),
  };
}

function requireAccountSubject(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /[^\x20-\x7e]/.test(value) ||
    value.includes("\0")
  ) {
    throw new Error("Participation Score pointer account subject is invalid");
  }
  return value;
}

function requireUuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new Error("Participation Score pointer delivery id is invalid");
  }
  return value;
}

function requireEpoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Participation Score pointer purchase epoch is invalid");
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Participation Score pointer revision is invalid");
  }
  return value;
}
