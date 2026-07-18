import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { parseCashuProofUnit } from "@bitcaster/client-sdk/marketUnits";
import { DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX } from "@bitcaster/client-sdk/durableCustody";
import type { Collection } from "dexie";
import { normalizeUrl } from "../lib/url";
import {
  db,
  requireGuiWalletId,
  requireStoredProofRow,
  type BitcasterDB,
  type StoredProofRow,
} from "./proof-db";
import {
  requireGuiProofBackupAuthorityRow,
  type GuiProofBackupAuthorityRow,
  type GuiProofSpendDisposition,
} from "./gui-encrypted-wallet-backup-records";
import { sameValue } from "./durable-custody-dexie-model";
import {
  walletIdFromHeldGuiWalletLock,
  type GuiWalletLockContext,
} from "./gui-wallet-lock";

export interface GuiProofBackupAuthorityWrite {
  proof: StoredProofRow;
  authority: GuiProofBackupAuthorityRow;
  effectiveNowUnixSeconds: number;
}

export interface GuiProofAuthorityCursor {
  spendDisposition: GuiProofSpendDisposition;
  proofId: string;
}

export interface GuiProofAuthorityPage {
  proofs: StoredProofRow[];
  nextCursor: GuiProofAuthorityCursor | null;
}

export async function commitGuiProofWithBackupAuthority(
  lock: GuiWalletLockContext,
  input: GuiProofBackupAuthorityWrite,
  database: BitcasterDB = db,
): Promise<void> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  const proof = requireStoredProofRow(input.proof, walletId);
  const authority = requireAuthorityForProof(input.authority, proof);
  requireLocalOnlyAuthority(authority);
  requireCurrentCtfDisposition(authority, input.effectiveNowUnixSeconds);
  await database.transaction(
    "rw",
    database.proofs,
    database.proofBackupAuthorities,
    async () =>
      commitProofAuthorityRows(
        database,
        proof,
        authority,
        input.effectiveNowUnixSeconds,
      ),
  );
}

function requireLocalOnlyAuthority(
  authority: GuiProofBackupAuthorityRow,
): void {
  if (
    authority.storageClassification.backupBinding !== null ||
    authority.storageClassification.storageClass ===
      "remotely-backed-deterministic-proof"
  ) {
    throw new Error(
      "Authenticated remote proof authority requires an SDK store callback",
    );
  }
}

export async function getGuiSelectableProofsForAmount(input: {
  walletId: string;
  mintUrl: string;
  unit: string;
  minimumAmount: number;
  effectiveNowUnixSeconds: number;
  limit: number;
  database?: BitcasterDB;
}): Promise<StoredProofRow[]> {
  const walletId = requireGuiWalletId(input.walletId);
  requirePositiveInteger(input.minimumAmount, "selection amount");
  requirePositiveInteger(input.limit, "selection limit");
  if (input.limit > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX) {
    throw new Error("GUI proof selection limit is invalid");
  }
  requireNonNegativeInteger(input.effectiveNowUnixSeconds, "effective time");
  const unit = parseCashuProofUnit(input.unit);
  if (!unit) throw new Error("GUI proof selection unit is invalid");
  const database = input.database ?? db;
  const mintUrl = normalizeUrl(input.mintUrl);
  return database.transaction(
    "r",
    database.proofs,
    database.proofBackupAuthorities,
    async () => {
      const candidates = await scanSelectableAuthorities(
        database.proofBackupAuthorities
          .where("[walletId+mintUrl+unit+spendDisposition+amount+proofId]")
          .between(
            [walletId, mintUrl, unit, "active-selectable", 0, ""],
            [
              walletId,
              mintUrl,
              unit,
              "active-selectable",
              Number.MAX_SAFE_INTEGER,
              MAX_INDEX_TEXT,
            ],
          )
          .reverse(),
        input.effectiveNowUnixSeconds,
        input.minimumAmount,
        input.limit,
      );
      return selectEnoughProofs(
        database,
        candidates,
        input.effectiveNowUnixSeconds,
        input.minimumAmount,
      );
    },
  );
}

async function scanSelectableAuthorities(
  collection: Collection<GuiProofBackupAuthorityRow, [string, string]>,
  effectiveNowUnixSeconds: number,
  minimumAmount: number,
  resultLimit: number,
): Promise<GuiProofBackupAuthorityRow[]> {
  const selected: GuiProofBackupAuthorityRow[] = [];
  let selectedAmount = 0;
  await collection
    .until((raw) => {
      const authority = requireGuiProofBackupAuthorityRow(raw);
      if (remainsTimeSelectable(authority, effectiveNowUnixSeconds)) {
        selected.push(authority);
        selectedAmount += authority.amount;
      }
      return selected.length >= resultLimit || selectedAmount >= minimumAmount;
    }, true)
    .each(() => undefined);
  return selected;
}

/** Return one bounded, stable page of currently selectable outcome proofs. */
export async function getGuiSelectableOutcomeProofs(input: {
  walletId: string;
  mintUrl: string;
  conditionId: string;
  outcomeCollection: string;
  effectiveNowUnixSeconds: number;
  cursor: GuiProofAuthorityCursor | null;
  limit: number;
  database?: BitcasterDB;
}): Promise<GuiProofAuthorityPage> {
  const walletId = requireGuiWalletId(input.walletId);
  const conditionId = requireConditionId(input.conditionId);
  const outcomeCollection = requireIndexText(
    input.outcomeCollection,
    512,
    "outcome collection",
  );
  const database = input.database ?? db;
  const mintUrl = normalizeUrl(input.mintUrl);
  const cursor = requireAuthorityCursor(input.cursor, "active-selectable");
  const limit = requirePageLimit(input.limit);
  requireNonNegativeInteger(input.effectiveNowUnixSeconds, "effective time");
  return database.transaction(
    "r",
    database.proofs,
    database.proofBackupAuthorities,
    () =>
      readAuthorityPage({
        database,
        prefix: [walletId, mintUrl, conditionId, outcomeCollection],
        cursor,
        limit,
        maximumDisposition: "active-selectable",
        minimumDisposition: "active-selectable",
        include: (authority) =>
          remainsTimeSelectable(authority, input.effectiveNowUnixSeconds),
      }),
  );
}

/** Return one bounded, stable page of retained or effectively expired CTF proofs. */
export async function getGuiRetainedCtfProofs(input: {
  walletId: string;
  mintUrl: string;
  conditionId: string;
  outcomeCollection: string;
  effectiveNowUnixSeconds: number;
  cursor: GuiProofAuthorityCursor | null;
  limit: number;
  database?: BitcasterDB;
}): Promise<GuiProofAuthorityPage> {
  const walletId = requireGuiWalletId(input.walletId);
  const conditionId = requireConditionId(input.conditionId);
  const outcomeCollection = requireIndexText(
    input.outcomeCollection,
    512,
    "outcome collection",
  );
  const database = input.database ?? db;
  const mintUrl = normalizeUrl(input.mintUrl);
  const cursor = requireAuthorityCursor(input.cursor);
  const limit = requirePageLimit(input.limit);
  requireNonNegativeInteger(input.effectiveNowUnixSeconds, "effective time");
  return database.transaction(
    "r",
    database.proofs,
    database.proofBackupAuthorities,
    () =>
      readAuthorityPage({
        database,
        prefix: [walletId, mintUrl, conditionId, outcomeCollection],
        cursor,
        limit,
        minimumDisposition: "",
        maximumDisposition: MAX_INDEX_TEXT,
        include: (authority) =>
          isEffectivelyRetained(authority, input.effectiveNowUnixSeconds),
      }),
  );
}

interface AuthorityPageScanInput {
  database: BitcasterDB;
  prefix: readonly [string, string, string, string];
  cursor: GuiProofAuthorityCursor | null;
  limit: number;
  minimumDisposition: GuiProofSpendDisposition | "";
  maximumDisposition: GuiProofSpendDisposition | typeof MAX_INDEX_TEXT;
  include: (authority: GuiProofBackupAuthorityRow) => boolean;
}

async function readAuthorityPage(
  input: AuthorityPageScanInput,
): Promise<GuiProofAuthorityPage> {
  const included: GuiProofBackupAuthorityRow[] = [];
  let scanCursor = input.cursor;
  let exhausted = false;
  while (included.length <= input.limit && !exhausted) {
    const rawPage = await queryAuthorityRows(input, scanCursor);
    exhausted = rawPage.length < GUI_AUTHORITY_PAGE_SIZE;
    for (const raw of rawPage) {
      const authority = requireGuiProofBackupAuthorityRow(raw);
      if (input.include(authority)) included.push(authority);
      if (included.length > input.limit) break;
    }
    const last = rawPage.at(-1);
    if (last) scanCursor = authorityCursor(last);
  }
  const returned = included.slice(0, input.limit);
  return {
    proofs: await joinAuthorityProofs(input.database, returned),
    nextCursor:
      included.length > input.limit
        ? authorityCursor(returned[returned.length - 1]!)
        : null,
  };
}

function queryAuthorityRows(
  input: AuthorityPageScanInput,
  cursor: GuiProofAuthorityCursor | null,
): Promise<GuiProofBackupAuthorityRow[]> {
  const lower = cursor
    ? [...input.prefix, cursor.spendDisposition, cursor.proofId]
    : [...input.prefix, input.minimumDisposition, ""];
  const upper = [...input.prefix, input.maximumDisposition, MAX_INDEX_TEXT];
  return input.database.proofBackupAuthorities
    .where(
      "[walletId+mintUrl+conditionId+outcomeCollection+spendDisposition+proofId]",
    )
    .between(lower, upper, cursor === null, true)
    .limit(GUI_AUTHORITY_PAGE_SIZE)
    .toArray();
}

async function commitProofAuthorityRows(
  database: BitcasterDB,
  proof: StoredProofRow,
  authority: GuiProofBackupAuthorityRow,
  effectiveNowUnixSeconds: number,
): Promise<void> {
  const key: [string, string] = [proof.walletId, proof.proofId];
  const [currentProof, currentAuthority] = await Promise.all([
    database.proofs.get(proof.proofId),
    database.proofBackupAuthorities.get(key),
  ]);
  if (currentProof) requireExactProof(currentProof, proof);
  if (currentAuthority) {
    requireAuthorityRevision(
      currentAuthority,
      authority,
      effectiveNowUnixSeconds,
    );
  }
  await database.proofs.put(proof);
  await database.proofBackupAuthorities.put(authority);
}

async function selectEnoughProofs(
  database: BitcasterDB,
  authorities: readonly GuiProofBackupAuthorityRow[],
  effectiveNowUnixSeconds: number,
  minimumAmount: number,
): Promise<StoredProofRow[]> {
  const proofs = await joinSelectableProofs(
    database,
    authorities,
    effectiveNowUnixSeconds,
  );
  const selected: StoredProofRow[] = [];
  let amount = 0;
  for (const proof of proofs) {
    selected.push(proof);
    amount += amountToNumber(proof.amount);
    if (amount >= minimumAmount) break;
  }
  return selected;
}

async function joinSelectableProofs(
  database: BitcasterDB,
  authorities: readonly GuiProofBackupAuthorityRow[],
  effectiveNowUnixSeconds: number,
): Promise<StoredProofRow[]> {
  const current = authorities.map((authority) =>
    requireGuiProofBackupAuthorityRow(authority),
  );
  const selectable = current.filter((authority) =>
    remainsTimeSelectable(authority, effectiveNowUnixSeconds),
  );
  return joinAuthorityProofs(database, selectable);
}

async function joinAuthorityProofs(
  database: BitcasterDB,
  authorities: readonly GuiProofBackupAuthorityRow[],
): Promise<StoredProofRow[]> {
  const proofs = await database.proofs.bulkGet(
    authorities.map(({ proofId }) => proofId),
  );
  return authorities.map((authority, index) => {
    const proof = proofs[index];
    if (!proof) throw new Error("GUI selectable proof body is missing");
    const stored = requireStoredProofRow(proof, authority.walletId);
    requireAuthorityForProof(authority, stored);
    return stored;
  });
}

function requireAuthorityForProof(
  raw: GuiProofBackupAuthorityRow,
  proof: StoredProofRow,
): GuiProofBackupAuthorityRow {
  const authority = requireGuiProofBackupAuthorityRow(raw, proof.walletId);
  if (
    authority.proofId !== proof.proofId ||
    authority.mintUrl !== proof.mintUrl ||
    authority.unit !== proof.unit ||
    authority.amount !== amountToNumber(proof.amount) ||
    (authority.proofKind === "ctf") !== (proof.proofClass === "ctf") ||
    authority.conditionId !== (proof.conditionId ?? null) ||
    authority.outcomeCollection !== (proof.outcomeCollection ?? null) ||
    (authority.derivationLocator.kind === "nut13" &&
      authority.derivationLocator.keysetId !== proof.id)
  ) {
    throw new Error("GUI proof backup authority conflicts with proof body");
  }
  const reserved = proof.reservedBy !== undefined;
  if (
    (authority.spendDisposition === "active-reserved") !== reserved ||
    (authority.spendDisposition === "active-selectable" && reserved)
  ) {
    throw new Error("GUI proof reservation authority conflicts");
  }
  return authority;
}

function requireCurrentCtfDisposition(
  authority: GuiProofBackupAuthorityRow,
  effectiveNowUnixSeconds: number,
): void {
  requireNonNegativeInteger(effectiveNowUnixSeconds, "effective time");
  const effectiveNowMs = effectiveTimeMs(effectiveNowUnixSeconds);
  if (authority.updatedAtMs > effectiveNowMs) {
    throw new Error("GUI proof authority time is in the future");
  }
  const expired =
    authority.finalExpiryUnixSeconds !== null &&
    authority.finalExpiryUnixSeconds <= effectiveNowUnixSeconds;
  const losing = authority.terminalEvidence !== null;
  if (
    (expired || losing) !==
    (authority.spendDisposition === "retained-nonselectable")
  ) {
    throw new Error("GUI CTF spend disposition is stale");
  }
}

function remainsTimeSelectable(
  authority: GuiProofBackupAuthorityRow,
  effectiveNowUnixSeconds: number,
): boolean {
  requireNonNegativeInteger(effectiveNowUnixSeconds, "effective time");
  if (authority.spendDisposition !== "active-selectable") return false;
  return (
    authority.finalExpiryUnixSeconds === null ||
    authority.finalExpiryUnixSeconds > effectiveNowUnixSeconds
  );
}

function isEffectivelyRetained(
  raw: GuiProofBackupAuthorityRow,
  effectiveNowUnixSeconds: number,
): boolean {
  const authority = requireGuiProofBackupAuthorityRow(raw);
  return (
    authority.spendDisposition === "retained-nonselectable" ||
    (authority.proofKind === "ctf" &&
      authority.finalExpiryUnixSeconds !== null &&
      authority.finalExpiryUnixSeconds <= effectiveNowUnixSeconds)
  );
}

function requireAuthorityRevision(
  current: GuiProofBackupAuthorityRow,
  next: GuiProofBackupAuthorityRow,
  effectiveNowUnixSeconds: number,
): void {
  const existing = requireGuiProofBackupAuthorityRow(current, next.walletId);
  if (sameValue(existing, next)) return;
  requireMonotonicProofAuthority(existing, next);
  if (effectiveTimeMs(effectiveNowUnixSeconds) < existing.updatedAtMs) {
    throw new Error("GUI proof authority effective time is stale");
  }
  if (next.proofCommitment !== existing.proofCommitment) {
    throw new Error("GUI proof commitment is immutable");
  }
  if (
    next.revision !== existing.revision + 1 ||
    next.updatedAtMs < existing.updatedAtMs
  ) {
    throw new Error("GUI proof backup authority revision is stale");
  }
}

function requireMonotonicProofAuthority(
  current: GuiProofBackupAuthorityRow,
  next: GuiProofBackupAuthorityRow,
): void {
  if (
    current.proofKind !== next.proofKind ||
    !sameValue(current.derivationLocator, next.derivationLocator) ||
    !sameValue(current.ctfMetadata, next.ctfMetadata) ||
    (current.terminalEvidence !== null &&
      !sameValue(current.terminalEvidence, next.terminalEvidence)) ||
    (current.spendDisposition === "retained-nonselectable" &&
      next.spendDisposition !== "retained-nonselectable")
  ) {
    throw new Error("GUI proof terminal authority cannot be reverted");
  }
}

function effectiveTimeMs(effectiveNowUnixSeconds: number): number {
  if (effectiveNowUnixSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    throw new Error("GUI effective time is invalid");
  }
  return effectiveNowUnixSeconds * 1_000;
}

function requireIndexText(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value > MAX_INDEX_TEXT
  ) {
    throw new Error(`GUI ${label} is invalid`);
  }
  return value;
}

function requireConditionId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("GUI condition id is invalid");
  }
  return value;
}

function requireAuthorityCursor(
  value: GuiProofAuthorityCursor | null,
  expectedDisposition?: GuiProofSpendDisposition,
): GuiProofAuthorityCursor | null {
  if (value === null) return null;
  if (
    Object.keys(value).length !== 2 ||
    !GUI_PROOF_SPEND_DISPOSITIONS.has(value.spendDisposition) ||
    !/^[0-9a-f]{64}$/.test(value.proofId) ||
    (expectedDisposition !== undefined &&
      value.spendDisposition !== expectedDisposition)
  ) {
    throw new Error("GUI proof authority cursor is invalid");
  }
  return { ...value };
}

function authorityCursor(
  authority: GuiProofBackupAuthorityRow,
): GuiProofAuthorityCursor {
  return {
    spendDisposition: authority.spendDisposition,
    proofId: authority.proofId,
  };
}

function requirePageLimit(value: unknown): number {
  const limit = requirePositiveInteger(value, "proof page limit");
  if (limit > GUI_AUTHORITY_PAGE_SIZE) {
    throw new Error("GUI proof page limit is invalid");
  }
  return limit;
}

function requireExactProof(
  current: StoredProofRow,
  expected: StoredProofRow,
): void {
  const existing = requireStoredProofRow(current, expected.walletId);
  if (!sameValue(existing, expected)) {
    throw new Error("GUI proof backup write conflicts with proof body");
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  const integer = requireNonNegativeInteger(value, label);
  if (integer === 0) throw new Error(`GUI ${label} is invalid`);
  return integer;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`GUI ${label} is invalid`);
  }
  return value as number;
}

const MAX_INDEX_TEXT = "\uffff";
const GUI_AUTHORITY_PAGE_SIZE = DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX;
const GUI_PROOF_SPEND_DISPOSITIONS = new Set<GuiProofSpendDisposition>([
  "active-selectable",
  "active-reserved",
  "retained-nonselectable",
]);
