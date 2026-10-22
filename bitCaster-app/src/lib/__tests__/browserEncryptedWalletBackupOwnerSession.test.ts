// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { deriveEncryptedWalletBackupOwnerScope } from "@bitcaster/client-sdk/encryptedWalletBackupEnrollment";
import {
  BrowserEncryptedWalletBackupOwnerSessionError,
  captureBrowserEncryptedWalletBackupOwnerSession,
} from "../browserEncryptedWalletBackupOwnerSession";

const ownerA = deriveEncryptedWalletBackupOwnerScope({
  authorizationScheme: "nip98-backup-intent-v1",
  ownerSubject: "11".repeat(32),
});
const ownerB = deriveEncryptedWalletBackupOwnerScope({
  authorizationScheme: "nip98-backup-intent-v1",
  ownerSubject: "22".repeat(32),
});

function revisionSource() {
  let revision = 1;
  const listeners = new Set<() => void>();
  return {
    get: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    advance() {
      revision += 1;
      for (const listener of listeners) listener();
    },
  };
}

const sessions = new Set<{ dispose(): void }>();
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions.clear();
});

function capture(input: {
  authenticatedOwner: typeof ownerA | null;
  selectedOwner?: typeof ownerB | null;
  isCurrentProfile?: () => boolean;
  revisions?: ReturnType<typeof revisionSource>;
  readAuthenticatedOwner?: () => typeof ownerA | null;
}) {
  const revisions = input.revisions ?? revisionSource();
  const session = captureBrowserEncryptedWalletBackupOwnerSession({
    isCurrentProfile: input.isCurrentProfile ?? (() => true),
    ...(input.selectedOwner === undefined ? {} : { selectedOwnerScope: input.selectedOwner }),
    readAuthenticatedOwner: input.readAuthenticatedOwner ?? (() => input.authenticatedOwner),
    readSignerRevision: revisions.get,
    subscribeSignerRevision: revisions.subscribe,
  });
  sessions.add(session);
  return { session, revisions };
}

it("allows seed-only recovery for a discovered owner without an account signer", () => {
  const { session } = capture({ authenticatedOwner: null, selectedOwner: ownerB });

  expect(session.isCurrent()).toBe(true);
  session.requireCurrent();
  expect(session.selectedOwnerScope?.ownerScopeId).toBe(ownerB.ownerScopeId);
  expect(session.authenticatedOwnerScope).toBeNull();
  expect(() => session.requireLifecycleOwner(ownerB)).toThrow(
    BrowserEncryptedWalletBackupOwnerSessionError,
  );
});

it("keeps content selection independent from the active signer owner", () => {
  const { session } = capture({ authenticatedOwner: ownerA, selectedOwner: ownerB });

  session.requireCurrent();
  expect(session.selectedOwnerScope?.ownerScopeId).toBe(ownerB.ownerScopeId);
  expect(session.authenticatedOwnerScope?.ownerScopeId).toBe(ownerA.ownerScopeId);
  expect(() => session.requireLifecycleOwner(ownerB)).toThrow(
    BrowserEncryptedWalletBackupOwnerSessionError,
  );
  expect(() => session.requireLifecycleOwner(ownerA)).toThrow(
    BrowserEncryptedWalletBackupOwnerSessionError,
  );
});

it("rejects a lifecycle result that does not match the captured live signer", () => {
  const { session } = capture({ authenticatedOwner: ownerA });

  expect(session.requireLifecycleOwner(ownerA)).toEqual(ownerA);
  expect(() => session.requireLifecycleOwner(ownerB)).toThrow(
    expect.objectContaining({ code: "lifecycle-owner-mismatch" }),
  );
  expect(() =>
    session.requireLifecycleOwner({ ...ownerA, ownerScopeId: ownerB.ownerScopeId }),
  ).toThrow(expect.objectContaining({ code: "lifecycle-owner-mismatch" }));
});

it("cancels deferred work when the signer session changes", async () => {
  const revisions = revisionSource();
  const { session } = capture({ authenticatedOwner: ownerA, revisions });
  let complete!: () => void;
  const deferred = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const lateWork = deferred.then(() => session.requireCurrent());

  revisions.advance();
  expect(session.signal.aborted).toBe(true);
  complete();
  await expect(lateWork).rejects.toMatchObject({ code: "cancelled" });
});

it("invalidates work when the wallet profile changes", () => {
  let current = true;
  const { session } = capture({
    authenticatedOwner: ownerA,
    isCurrentProfile: () => current,
  });

  current = false;
  expect(session.isCurrent()).toBe(false);
  expect(() => session.requireCurrent()).toThrow(
    expect.objectContaining({ code: "selection-changed" }),
  );
});

it("invalidates work when the live account owner changes", () => {
  let liveOwner: typeof ownerA | null = ownerA;
  const { session } = capture({
    authenticatedOwner: ownerA,
    readAuthenticatedOwner: () => liveOwner,
  });

  liveOwner = ownerB;
  expect(session.isCurrent()).toBe(false);
  expect(() => session.requireCurrent()).toThrow(
    expect.objectContaining({ code: "selection-changed" }),
  );
});
