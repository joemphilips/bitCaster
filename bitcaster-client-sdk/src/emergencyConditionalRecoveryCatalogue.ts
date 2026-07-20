import {
  Amount,
  Keyset,
  deriveConditionalKeysetId,
  hashToCurve,
} from "@cashu/cashu-ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { decodeDurableCustodyScopeId } from "./durableCustody.ts";
import { normalizeDurableWalletMintUrl } from "./durableWalletMintUrl.ts";
import {
  CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION,
  computeConditionalRecoverySessionDigest,
  decodeConditionalRecoveryScan,
  decodeConditionalRecoverySessionTransition,
  initialConditionalRecoveryScan,
  validateConditionalRecoverySessionState,
  validateConditionalRecoverySessionSuccessor,
  type ConditionalRecoveryBatchBinding,
  type ConditionalRecoveryKeysetTerminalEvidence,
  type ConditionalRecoverySessionTransition,
  type ConditionalRecoverySkipEvidence,
  type ConditionalRecoveryTerminalEvidence,
} from "./emergencyConditionalRecoverySession.ts";
import {
  encodeBoundedConditionalCheckpoint,
  parseBoundedConditionalCheckpoint,
  type EncodedConditionalCatalogueCheckpoint,
} from "./emergencyConditionalRecoveryCheckpointCodec.ts";
import {
  CONDITIONAL_RECOVERY_AUTHORITY_MAX_AGE_MS,
  CONDITIONAL_RECOVERY_CATALOGUE_VERSION,
  CONDITIONAL_RECOVERY_CHECKPOINT_VERSION,
  CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
  CONDITIONAL_RECOVERY_MAX_CHECKPOINT_BYTES,
  CONDITIONAL_RECOVERY_MAX_CURSOR_BYTES,
  CONDITIONAL_RECOVERY_MAX_KEYS_PER_KEYSET,
  CONDITIONAL_RECOVERY_MAX_KEYSETS,
  CONDITIONAL_RECOVERY_MAX_OUTCOME_COLLECTION_BYTES,
  CONDITIONAL_RECOVERY_MAX_PAGES,
  CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
  CONDITIONAL_RECOVERY_MAX_PAGE_SIZE,
  CONDITIONAL_RECOVERY_MAX_PROOFS,
  CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS,
  CONDITIONAL_RECOVERY_MAX_UNIT_BYTES,
  CONDITIONAL_RECOVERY_MAX_WORK_UNITS,
  CONDITIONAL_RECOVERY_WALLET_SCOPE_SCHEMA_VERSION,
  type CompletedConditionalRecoveryCatalogue,
  type ConditionalCatalogueCheckpoint,
  type ConditionalCatalogueProgress,
  type ConditionalCatalogueReplayPort,
  type ConditionalRecoveryAuthorityObservation,
  type ConditionalRecoveryAuthorityPort,
  type ConditionalRecoveryBudget,
  type ConditionalRecoveryCapability,
  type ConditionalRecoveryKeysetMetadata,
  type ConditionalRecoverySession,
  type ConditionalRecoverySessionCasPort,
  type ConditionalRecoveryWalletScope,
  type ValidatedConditionalCataloguePage,
  type ValidatedConditionalRecoveryTarget,
} from "./emergencyConditionalRecoveryTypes.ts";

const UINT64_MAX = (1n << 64n) - 1n;
const LOWER_HEX_32 = /^[0-9a-f]{64}$/;
const V2_KEYSET_ID = /^01[0-9a-f]{64}$/;
const COMPRESSED_SECP_PUBLIC_KEY = /^(02|03)[0-9a-f]{64}$/;
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const OUTCOME_ID_TAG = utf8ToBytes("Cashu_outcome_collection_id");
const OUTCOME_ID_TAG_HASH = sha256(OUTCOME_ID_TAG);
const encoder = new TextEncoder();

interface LiveProgressState {
  readonly keysets: ReadonlyMap<string, ConditionalRecoveryKeysetMetadata>;
  readonly terminalComplete: boolean;
  readonly currentCursor: string | null;
}

const liveProgress = new WeakMap<object, LiveProgressState>();
const livePages = new WeakMap<object, LiveProgressState>();
const completedCatalogues = new WeakSet<object>();
const validatedTargets = new WeakSet<object>();
const targetCatalogues = new WeakMap<object, object>();
const targetSessionPorts = new WeakMap<
  object,
  ConditionalRecoverySessionCasPort
>();

export function getConditionalRecoveryTargetSessionPort(
  target: ValidatedConditionalRecoveryTarget,
): ConditionalRecoverySessionCasPort | undefined {
  return targetSessionPorts.get(target);
}
const authorityObservations = new WeakMap<
  object,
  { readonly subject: object; readonly issuedAtMs: number }
>();
const consumedAuthorityObservations = new WeakSet<object>();
const liveSessions = new WeakMap<object, ConditionalRecoverySessionCasPort>();
const rehydratedSessionPorts = new Map<string, ConditionalRecoverySessionCasPort>();
const replaySuccessors = new WeakMap<
  object,
  Readonly<{
    successor: ConditionalRecoverySession;
    port: ConditionalRecoverySessionCasPort;
  }>
>();

export function decodeConditionalRecoveryCapability(
  mintInfo: unknown,
): ConditionalRecoveryCapability | null {
  const info = requireObject(mintInfo, "mint info");
  if (info.nuts === undefined) return null;
  const nuts = requireObject(info.nuts, "mint NUT settings");
  if (!hasOwn(nuts, "CTF")) {
    if (Object.keys(nuts).some((key) => key.toLowerCase() === "ctf")) {
      throw new Error(
        "conditional recovery requires the exact CTF capability key",
      );
    }
    return null;
  }
  const ctf = requireObject(nuts.CTF, "CTF capability");
  if (typeof ctf.supported !== "boolean") {
    throw new Error("conditional recovery CTF capability is invalid");
  }
  if (!ctf.supported) return null;
  const catalogue = requireObject(
    ctf.conditional_keyset_catalogue,
    "conditional keyset catalogue capability",
  );
  requireExactKeys(
    catalogue,
    ["version", "max_page_size"],
    "conditional keyset catalogue capability",
  );
  if (catalogue.version !== CONDITIONAL_RECOVERY_CATALOGUE_VERSION) {
    throw new Error("conditional recovery catalogue version is unsupported");
  }
  const maxPageSize = requireSafeInteger(
    catalogue.max_page_size,
    "conditional recovery catalogue page size",
  );
  if (maxPageSize < 1 || maxPageSize > CONDITIONAL_RECOVERY_MAX_PAGE_SIZE) {
    throw new Error("conditional recovery catalogue page size is invalid");
  }
  return Object.freeze({
    version: CONDITIONAL_RECOVERY_CATALOGUE_VERSION,
    maxPageSize,
  });
}

export function assertConditionalRecoveryCapabilityUnchanged(
  expected: ConditionalRecoveryCapability,
  currentMintInfo: unknown,
): void {
  const wanted = decodeCapabilityRecord(expected);
  const current = decodeConditionalRecoveryCapability(currentMintInfo);
  if (
    current === null ||
    current.version !== wanted.version ||
    current.maxPageSize !== wanted.maxPageSize
  ) {
    throw new Error(
      "conditional recovery catalogue capability changed or was withdrawn",
    );
  }
}

export function createConditionalRecoveryWalletScope(input: {
  scopeId: unknown;
  mintUrl: unknown;
  unit: unknown;
}): ConditionalRecoveryWalletScope {
  const scopeId = decodeDurableCustodyScopeId(input.scopeId);
  if (!scopeId.startsWith("custody:wallet:")) {
    throw new Error(
      "conditional recovery requires a durable custody wallet scope",
    );
  }
  return Object.freeze({
    schemaVersion: CONDITIONAL_RECOVERY_WALLET_SCOPE_SCHEMA_VERSION,
    scopeId,
    mintUrl: normalizeDurableWalletMintUrl(input.mintUrl),
    unit: requireBoundedUnit(input.unit),
  });
}

export function decodeConditionalRecoveryWalletScope(
  value: unknown,
): ConditionalRecoveryWalletScope {
  const scope = requireObject(value, "conditional recovery wallet scope");
  requireExactKeys(
    scope,
    ["schemaVersion", "scopeId", "mintUrl", "unit"],
    "conditional recovery wallet scope",
  );
  if (
    scope.schemaVersion !== CONDITIONAL_RECOVERY_WALLET_SCOPE_SCHEMA_VERSION
  ) {
    throw new Error("conditional recovery wallet scope schema is unsupported");
  }
  return createConditionalRecoveryWalletScope({
    scopeId: scope.scopeId,
    mintUrl: scope.mintUrl,
    unit: scope.unit,
  });
}

export function assertConditionalRecoveryWalletScopeMatches(
  persisted: unknown,
  expected: unknown,
): void {
  const left = decodeConditionalRecoveryWalletScope(persisted);
  const right = decodeConditionalRecoveryWalletScope(expected);
  if (
    left.scopeId !== right.scopeId ||
    left.mintUrl !== right.mintUrl ||
    left.unit !== right.unit
  ) {
    throw new Error("conditional recovery wallet scope row is foreign");
  }
}

export function createConditionalRecoveryBudget(): ConditionalRecoveryBudget {
  return freezeBudget({
    transportBytes: 0,
    serializedBytes: 0,
    workUnits: 0,
    proofCount: 0,
  });
}

export function chargeConditionalRecoveryBudget(
  current: ConditionalRecoveryBudget,
  charge: {
    transportBytes?: number;
    serializedBytes?: number;
    workUnits?: number;
    proofCount?: number;
  },
): ConditionalRecoveryBudget {
  const budget = decodeConditionalRecoveryBudget(current);
  const transportBytes = requireCharge(charge.transportBytes, "transport byte");
  const serializedBytes = requireCharge(
    charge.serializedBytes,
    "serialized byte",
  );
  if (
    transportBytes > CONDITIONAL_RECOVERY_MAX_PAGE_BYTES ||
    serializedBytes > CONDITIONAL_RECOVERY_MAX_PAGE_BYTES
  ) {
    throw new Error(
      "conditional recovery response exceeded its page byte bound",
    );
  }
  return freezeBudget({
    transportBytes: checkedBudgetAdd(
      budget.transportBytes,
      transportBytes,
      CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
      "transport byte",
    ),
    serializedBytes: checkedBudgetAdd(
      budget.serializedBytes,
      serializedBytes,
      CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
      "serialized byte",
    ),
    workUnits: checkedBudgetAdd(
      budget.workUnits,
      requireCharge(charge.workUnits, "work"),
      CONDITIONAL_RECOVERY_MAX_WORK_UNITS,
      "work",
    ),
    proofCount: checkedBudgetAdd(
      budget.proofCount,
      requireCharge(charge.proofCount, "proof"),
      CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS,
      "proof",
    ),
  });
}

export function assertConditionalRecoveryBudgetDoesNotRegress(
  previous: ConditionalRecoveryBudget,
  next: ConditionalRecoveryBudget,
): void {
  const before = decodeConditionalRecoveryBudget(previous);
  const after = decodeConditionalRecoveryBudget(next);
  if (
    after.transportBytes < before.transportBytes ||
    after.serializedBytes < before.serializedBytes ||
    after.workUnits < before.workUnits ||
    after.proofCount < before.proofCount
  ) {
    throw new Error("conditional recovery budget regressed");
  }
}

export function createConditionalCatalogueProgress(input: {
  capability: ConditionalRecoveryCapability;
  walletScope: ConditionalRecoveryWalletScope;
}): ConditionalCatalogueProgress {
  const progress = freezeProgress({
    capability: decodeCapabilityRecord(input.capability),
    walletScope: decodeConditionalRecoveryWalletScope(input.walletScope),
    pageCount: 0,
    cursorDigests: [],
    budget: createConditionalRecoveryBudget(),
  });
  liveProgress.set(progress, {
    keysets: new Map(),
    terminalComplete: false,
    currentCursor: null,
  });
  return progress;
}

export function validateConditionalCataloguePage(input: {
  requestedCursor: string | null;
  response: unknown;
  responseBytes: number;
  progress: ConditionalCatalogueProgress;
}): ValidatedConditionalCataloguePage {
  const progress = requireLiveProgress(input.progress);
  const state = liveProgress.get(progress)!;
  if (state.terminalComplete) {
    throw new Error("conditional recovery catalogue is already complete");
  }
  const requestedCursor = decodeOptionalCursor(
    input.requestedCursor,
    "request cursor",
  );
  validateRequestedCatalogueCursor(progress, requestedCursor);
  if (progress.pageCount >= CONDITIONAL_RECOVERY_MAX_PAGES) {
    throw new Error("conditional recovery catalogue exceeded its page bound");
  }
  const response = requireObject(
    input.response,
    "conditional recovery catalogue page",
  );
  requireExactKeys(
    response,
    ["keysets", "next_cursor", "complete"],
    "conditional recovery catalogue page",
    ["next_cursor"],
  );
  if (!Array.isArray(response.keysets)) {
    throw new Error("conditional recovery catalogue keysets are invalid");
  }
  if (response.keysets.length > progress.capability.maxPageSize) {
    throw new Error(
      "conditional recovery catalogue page exceeded its negotiated limit",
    );
  }
  if (typeof response.complete !== "boolean") {
    throw new Error(
      "conditional recovery catalogue completion marker is invalid",
    );
  }
  if (!response.complete && response.keysets.length === 0) {
    throw new Error(
      "conditional recovery incomplete catalogue page made no item progress",
    );
  }
  const pageKeysets = deduplicatePageMetadata(response.keysets);
  const merged = new Map(state.keysets);
  for (const keyset of pageKeysets) {
    const prior = merged.get(keyset.id);
    if (
      prior !== undefined &&
      metadataFingerprint(prior) !== metadataFingerprint(keyset)
    ) {
      throw new Error(
        "conditional recovery catalogue repeated conflicting keyset metadata",
      );
    }
    if (prior === undefined) {
      if (merged.size >= CONDITIONAL_RECOVERY_MAX_KEYSETS) {
        throw new Error(
          "conditional recovery catalogue exceeded its keyset bound",
        );
      }
      merged.set(keyset.id, keyset);
    }
  }
  const nextCursor = decodePageContinuation(
    response.complete,
    response.next_cursor,
    requestedCursor,
  );
  const cursorDigests = [...progress.cursorDigests];
  if (nextCursor !== null) {
    const digest = digestCursor(nextCursor);
    if (cursorDigests.includes(digest)) {
      throw new Error("conditional recovery catalogue cursor cycle detected");
    }
    cursorDigests.push(digest);
  }
  const budget = chargeConditionalRecoveryBudget(progress.budget, {
    transportBytes: requireBoundedPageBytes(input.responseBytes),
    serializedBytes: boundedJsonBytes(
      response,
      CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
      "conditional recovery catalogue page",
    ),
    workUnits: checkedSafeAdd(
      checkedSafeMultiply(response.keysets.length, 4, "catalogue work"),
      1,
      "catalogue work",
    ),
  });
  const nextProgress = freezeProgress({
    capability: progress.capability,
    walletScope: progress.walletScope,
    pageCount: checkedSafeAdd(progress.pageCount, 1, "catalogue page count"),
    cursorDigests,
    budget,
  });
  const nextState = {
    keysets: merged,
    terminalComplete: response.complete,
    currentCursor: nextCursor,
  };
  liveProgress.set(nextProgress, nextState);
  const page = Object.freeze({
    keysets: Object.freeze(pageKeysets),
    complete: response.complete,
    nextCursor,
    progress: nextProgress,
  });
  livePages.set(page, nextState);
  return page;
}

export function snapshotConditionalCatalogueCheckpoint(
  value: ConditionalCatalogueProgress | ValidatedConditionalCataloguePage,
): ConditionalCatalogueCheckpoint {
  const pageState = isObject(value) ? livePages.get(value) : undefined;
  const progress = pageState
    ? (value as unknown as ValidatedConditionalCataloguePage).progress
    : requireLiveProgress(value);
  const state = pageState ?? liveProgress.get(progress)!;
  return Object.freeze({
    schemaVersion: CONDITIONAL_RECOVERY_CHECKPOINT_VERSION,
    capability: progress.capability,
    walletScope: progress.walletScope,
    pageCount: progress.pageCount,
    cursorDigests: Object.freeze([...progress.cursorDigests]),
    terminalComplete: state.terminalComplete,
    currentCursor: state.currentCursor,
    keysets: Object.freeze([...state.keysets.values()]),
    budget: progress.budget,
  });
}

export function encodeConditionalCatalogueCheckpoint(
  value: ConditionalCatalogueProgress | ValidatedConditionalCataloguePage,
): string {
  return encodeBoundedConditionalCheckpoint(
    snapshotConditionalCatalogueCheckpoint(value),
    CONDITIONAL_RECOVERY_MAX_CHECKPOINT_BYTES,
  );
}

export async function resumeConditionalCatalogueProgress(
  value: EncodedConditionalCatalogueCheckpoint,
  replayPort: ConditionalCatalogueReplayPort,
): Promise<ConditionalCatalogueProgress> {
  const checkpoint = decodeCatalogueCheckpoint(
    parseBoundedConditionalCheckpoint(
      value,
      CONDITIONAL_RECOVERY_MAX_CHECKPOINT_BYTES,
    ),
  );
  if (checkpoint.terminalComplete) {
    throw new Error(
      "conditional recovery persisted terminal checkpoint cannot grant finalization authority",
    );
  }
  let replayed = createConditionalCatalogueProgress({
    capability: checkpoint.capability,
    walletScope: checkpoint.walletScope,
  });
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < checkpoint.pageCount; pageIndex += 1) {
    const fetched = await replayPort.fetchPage({
      walletScope: checkpoint.walletScope,
      cursor,
      maxPageSize: checkpoint.capability.maxPageSize,
    });
    const page = validateConditionalCataloguePage({
      requestedCursor: cursor,
      response: fetched.response,
      responseBytes: fetched.responseBytes,
      progress: replayed,
    });
    if (page.complete) {
      throw new Error(
        "conditional recovery replay reached terminal state before checkpoint",
      );
    }
    replayed = page.progress;
    cursor = page.nextCursor;
  }
  const replayCheckpoint = snapshotConditionalCatalogueCheckpoint(replayed);
  if (
    replayCheckpoint.currentCursor !== checkpoint.currentCursor ||
    digestValue(replayCheckpoint.cursorDigests) !==
      digestValue(checkpoint.cursorDigests) ||
    digestValue(replayCheckpoint.keysets) !== digestValue(checkpoint.keysets) ||
    digestValue(replayCheckpoint.budget) !== digestValue(checkpoint.budget)
  ) {
    throw new Error(
      "conditional recovery persisted checkpoint does not match replayed transcript",
    );
  }
  return replayed;
}

export async function issueConditionalRecoveryAuthorityObservation(input: {
  subject:
    | ValidatedConditionalCataloguePage
    | CompletedConditionalRecoveryCatalogue;
  port: ConditionalRecoveryAuthorityPort;
}): Promise<ConditionalRecoveryAuthorityObservation> {
  const subject = requireAuthoritySubject(input.subject);
  const { capability, walletScope } = authoritySubjectContext(subject);
  const [mintInfo, nowMsValue] = await Promise.all([
    input.port.fetchMintInfo(walletScope),
    input.port.readWallClockMs(),
  ]);
  assertConditionalRecoveryCapabilityUnchanged(capability, mintInfo);
  const nowMs = requireSafeInteger(
    nowMsValue,
    "conditional recovery authority wall clock",
  );
  if (nowMs < 0) {
    throw new Error("conditional recovery authority wall clock is invalid");
  }
  const observedUnixSeconds = Math.floor(nowMs / 1_000);
  const effectiveTime = requireUnixSeconds(
    await input.port.advanceAndReadHighWater({
      scopeId: walletScope.scopeId,
      mintUrl: walletScope.mintUrl,
      unit: walletScope.unit,
      observedUnixSeconds,
    }),
    "conditional recovery authority high-water time",
  );
  if (effectiveTime < observedUnixSeconds) {
    throw new Error(
      "conditional recovery authority high-water update regressed",
    );
  }
  const observation = Object.freeze({
    walletScope,
    capability,
    effectiveTime,
  });
  authorityObservations.set(observation, { subject, issuedAtMs: Date.now() });
  return observation;
}

export function finalizeConditionalRecoveryCatalogue(input: {
  terminalPage: ValidatedConditionalCataloguePage;
  authority: ConditionalRecoveryAuthorityObservation;
  ordinaryKeysetIds: readonly string[];
}): CompletedConditionalRecoveryCatalogue {
  const terminalPage = requireTerminalPage(input.terminalPage);
  const authority = consumeAuthority(input.authority, terminalPage);
  const state = livePages.get(terminalPage)!;
  const keysets = Object.freeze([...state.keysets.values()]);
  validateNoOrdinaryConditionalKeysetCollisions(
    input.ordinaryKeysetIds,
    keysets,
  );
  const completed = Object.freeze({
    capability: authority.capability,
    walletScope: authority.walletScope,
    keysets,
    budget: terminalPage.progress.budget,
  });
  completedCatalogues.add(completed);
  return completed;
}

export function mergeConditionalRecoveryCatalogue(
  existing: readonly ConditionalRecoveryKeysetMetadata[],
  incoming: readonly ConditionalRecoveryKeysetMetadata[],
): readonly ConditionalRecoveryKeysetMetadata[] {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) {
    throw new Error("conditional recovery catalogue state is invalid");
  }
  const merged = new Map<string, ConditionalRecoveryKeysetMetadata>();
  for (const raw of [...existing, ...incoming]) {
    const keyset = decodeConditionalRecoveryKeysetMetadata(raw);
    const prior = merged.get(keyset.id);
    if (
      prior !== undefined &&
      metadataFingerprint(prior) !== metadataFingerprint(keyset)
    ) {
      throw new Error(
        "conditional recovery catalogue repeated conflicting keyset metadata",
      );
    }
    if (prior === undefined) {
      if (merged.size >= CONDITIONAL_RECOVERY_MAX_KEYSETS) {
        throw new Error(
          "conditional recovery catalogue exceeded its keyset bound",
        );
      }
      merged.set(keyset.id, keyset);
    }
  }
  return Object.freeze([...merged.values()]);
}

export function validateNoOrdinaryConditionalKeysetCollisions(
  ordinaryKeysetIds: readonly string[],
  conditionalKeysets: readonly ConditionalRecoveryKeysetMetadata[],
): void {
  if (!Array.isArray(ordinaryKeysetIds) || !Array.isArray(conditionalKeysets)) {
    throw new Error("conditional recovery keyset namespaces are invalid");
  }
  const ordinary = new Set<string>();
  for (const id of ordinaryKeysetIds) {
    requireNonEmptyBoundedString(id, 256, "ordinary keyset id");
    if (ordinary.has(id)) {
      throw new Error("ordinary recovery keyset list contains a duplicate id");
    }
    ordinary.add(id);
  }
  for (const value of conditionalKeysets) {
    const keyset = decodeConditionalRecoveryKeysetMetadata(value);
    if (ordinary.has(keyset.id)) {
      throw new Error(
        "conditional catalogue id collided with an ordinary keyset",
      );
    }
  }
}

export function decodeConditionalRecoveryKeysetMetadata(
  value: unknown,
): ConditionalRecoveryKeysetMetadata {
  const object = requireObject(value, "conditional recovery keyset metadata");
  requireExactKeys(
    object,
    [
      "id",
      "unit",
      "active",
      "inputFeePpk",
      "finalExpiry",
      "conditionId",
      "outcomeCollection",
      "outcomeCollectionId",
      "registeredAt",
    ],
    "conditional recovery keyset metadata",
  );
  return validateNormalizedMetadata(object);
}

export function computeRootOutcomeCollectionId(
  conditionId: string,
  outcomeCollection: string,
): string {
  const condition = requireLowerHex32(conditionId, "condition id");
  const outcome = requireNonEmptyBoundedString(
    outcomeCollection,
    CONDITIONAL_RECOVERY_MAX_OUTCOME_COLLECTION_BYTES,
    "conditional recovery outcome collection",
  );
  const tagged = sha256(
    concatBytes(
      OUTCOME_ID_TAG_HASH,
      OUTCOME_ID_TAG_HASH,
      hexToBytes(condition),
      utf8ToBytes(outcome),
    ),
  );
  return bytesToHex(hashToCurve(tagged).toBytes(true).slice(1));
}

export function validateConditionalRecoveryKeys(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  walletScope: ConditionalRecoveryWalletScope;
  keysetId: string;
  response: unknown;
  responseBytes: number;
  authority: ConditionalRecoveryAuthorityObservation;
  session: ConditionalRecoverySession;
}): ValidatedConditionalRecoveryTarget | null {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const authority = consumeAuthority(input.authority, catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    catalogue.walletScope,
    walletScope,
  );
  assertConditionalRecoveryWalletScopeMatches(
    authority.walletScope,
    walletScope,
  );
  const keysetId = requireV2KeysetId(input.keysetId);
  const metadata = catalogue.keysets.find((value) => value.id === keysetId);
  if (metadata === undefined) {
    throw new Error(
      "conditional recovery keyset is not in the completed catalogue",
    );
  }
  if (metadata.unit !== walletScope.unit) {
    throw new Error(
      "conditional recovery keyset belongs to a foreign wallet unit",
    );
  }
  const sessionPort = requireLiveSession(input.session, walletScope);
  const response = requireObject(
    input.response,
    "conditional recovery keys response",
  );
  requireExactKeys(response, ["keysets"], "conditional recovery keys response");
  if (!Array.isArray(response.keysets) || response.keysets.length !== 1) {
    throw new Error(
      "conditional recovery keys response must contain exactly one keyset",
    );
  }
  const raw = requireObject(response.keysets[0], "conditional recovery keys");
  requireExactKeys(
    raw,
    ["id", "unit", "active", "input_fee_ppk", "final_expiry", "keys"],
    "conditional recovery keys",
    ["input_fee_ppk", "final_expiry"],
  );
  const id = requireV2KeysetId(raw.id);
  const unit = requireBoundedUnit(raw.unit);
  if (typeof raw.active !== "boolean") {
    throw new Error("conditional recovery keys active flag is invalid");
  }
  const inputFeePpk = decodeOptionalSafeInteger(
    raw,
    "input_fee_ppk",
    "conditional recovery keys input fee",
    false,
  );
  const finalExpiry = decodeOptionalSafeInteger(
    raw,
    "final_expiry",
    "conditional recovery keys expiry",
    true,
  );
  if (
    id !== metadata.id ||
    unit !== metadata.unit ||
    raw.active !== metadata.active ||
    inputFeePpk !== metadata.inputFeePpk ||
    finalExpiry !== metadata.finalExpiry
  ) {
    throw new Error(
      "conditional recovery keys do not match catalogue metadata",
    );
  }
  const keys = decodeAmountKeys(raw.keys);
  const budget = chargeConditionalRecoveryBudget(input.session.budget, {
    transportBytes: requireBoundedPageBytes(input.responseBytes),
    serializedBytes: boundedJsonBytes(
      response,
      CONDITIONAL_RECOVERY_MAX_PAGE_BYTES,
      "conditional recovery keys response",
    ),
    workUnits: checkedSafeAdd(
      checkedSafeMultiply(Object.keys(keys).length, 3, "conditional keys work"),
      2,
      "conditional keys work",
    ),
  });
  const derived = deriveConditionalKeysetId({
    keys,
    input_fee_ppk: inputFeePpk ?? undefined,
    final_expiry: finalExpiry ?? undefined,
    unit,
    conditionId: metadata.conditionId,
    outcomeCollectionId: metadata.outcomeCollectionId,
  });
  if (derived !== metadata.id) {
    throw new Error(
      "conditional recovery keys derived id does not match catalogue metadata",
    );
  }
  if (
    !Keyset.verifyConditionalKeysetId(
      {
        id,
        unit,
        active: raw.active,
        input_fee_ppk: inputFeePpk ?? undefined,
        final_expiry: finalExpiry ?? undefined,
        keys,
      },
      {
        conditionId: metadata.conditionId,
        outcomeCollection: metadata.outcomeCollection,
        outcomeCollectionId: metadata.outcomeCollectionId,
        registeredAt: metadata.registeredAt,
      },
    )
  ) {
    throw new Error(
      "conditional recovery keys failed v2 keyset id verification",
    );
  }
  if (
    !isConditionalRecoveryKeysetRecoverable(metadata, authority.effectiveTime)
  ) {
    return null;
  }
  const catalogueOrdinal = catalogue.keysets.findIndex(
    (candidate) => candidate.id === metadata.id,
  );
  const session = advanceSession(
    input.session,
    sessionPort,
    "conditional-keys",
    digestValue([metadata.id, keys, authority.effectiveTime, budget]),
    budget,
    input.session.scan,
    {
      catalogueOrdinal,
      activeKeysetId: metadata.id,
      keysetMetadataDigest: metadataFingerprint(metadata),
      currentBatch: null,
      keysetTerminalEvidence: null,
      skipEvidence: null,
      terminalEvidence: null,
    },
  );
  const target = Object.freeze({
    walletScope,
    metadata,
    keys,
    validatedAt: authority.effectiveTime,
    budget,
    session,
  });
  validatedTargets.add(target);
  targetCatalogues.set(target, catalogue);
  targetSessionPorts.set(target, sessionPort);
  return target;
}

export function advanceConditionalRecoveryHighWater(
  persistedHighWater: number,
  nowMs: number,
): number {
  const persisted = requireUnixSeconds(
    persistedHighWater,
    "persisted recovery time",
  );
  const milliseconds = requireSafeInteger(nowMs, "recovery wall clock");
  if (milliseconds < 0)
    throw new Error("conditional recovery wall clock is invalid");
  return Math.max(persisted, Math.floor(milliseconds / 1_000));
}

export function isConditionalRecoveryKeysetRecoverable(
  metadata: ConditionalRecoveryKeysetMetadata,
  effectiveTime: number,
): boolean {
  const keyset = decodeConditionalRecoveryKeysetMetadata(metadata);
  const time = requireUnixSeconds(effectiveTime, "effective recovery time");
  return keyset.finalExpiry === null || keyset.finalExpiry > time;
}

export function createConditionalRecoverySession(input: {
  catalogue: CompletedConditionalRecoveryCatalogue;
  walletScope: ConditionalRecoveryWalletScope;
  cas: ConditionalRecoverySessionCasPort;
  startCounter?: number;
}): ConditionalRecoverySession {
  const catalogue = requireCompletedCatalogue(input.catalogue);
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  assertConditionalRecoveryWalletScopeMatches(
    catalogue.walletScope,
    walletScope,
  );
  const startCounter = requireSafeInteger(
    input.startCounter ?? 0,
    "conditional recovery session start counter",
  );
  if (startCounter < 0) {
    throw new Error("conditional recovery session start counter is invalid");
  }
  const session = freezeSession({
    walletScope,
    sequence: 0,
    predecessorDigest: null,
    transition: "completed-catalogue",
    evidenceDigest: digestValue([catalogue.capability, catalogue.keysets]),
    budget: catalogue.budget,
    completedKeysetProofCount: 0,
    catalogueOrdinal: null,
    activeKeysetId: null,
    keysetMetadataDigest: null,
    scan: initialConditionalRecoveryScan(startCounter),
    currentBatch: null,
    keysetTerminalEvidence: null,
    skipEvidence: null,
    terminalEvidence: null,
  });
  if (
    input.cas.compareAndSwap({
      walletScope,
      expectedDigest: null,
      successor: session,
    }) !== true
  ) {
    throw new Error("conditional recovery session initialization CAS failed");
  }
  liveSessions.set(session, input.cas);
  return session;
}

export function resumeConditionalRecoverySession(): never {
  throw new Error(
    "conditional recovery session row resume is unsupported; decode and rehydrate session-v2 bytes",
  );
}

function requireAuthoritySubject(
  value: unknown,
): ValidatedConditionalCataloguePage | CompletedConditionalRecoveryCatalogue {
  if (
    !isObject(value) ||
    (!livePages.has(value) && !completedCatalogues.has(value))
  ) {
    throw new Error("conditional recovery authority subject is invalid");
  }
  if (livePages.has(value) && !livePages.get(value)!.terminalComplete) {
    throw new Error(
      "conditional recovery authority requires a terminal catalogue page",
    );
  }
  return value as unknown as
    | ValidatedConditionalCataloguePage
    | CompletedConditionalRecoveryCatalogue;
}

function authoritySubjectContext(
  subject:
    | ValidatedConditionalCataloguePage
    | CompletedConditionalRecoveryCatalogue,
): {
  capability: ConditionalRecoveryCapability;
  walletScope: ConditionalRecoveryWalletScope;
} {
  if (completedCatalogues.has(subject)) {
    const catalogue = subject as CompletedConditionalRecoveryCatalogue;
    return {
      capability: catalogue.capability,
      walletScope: catalogue.walletScope,
    };
  }
  const page = subject as ValidatedConditionalCataloguePage;
  return {
    capability: page.progress.capability,
    walletScope: page.progress.walletScope,
  };
}

export function consumeAuthority(
  value: unknown,
  subject: object,
): ConditionalRecoveryAuthorityObservation {
  if (!isObject(value)) {
    throw new Error("conditional recovery authority observation is invalid");
  }
  const state = authorityObservations.get(value);
  if (
    state === undefined ||
    state.subject !== subject ||
    consumedAuthorityObservations.has(value)
  ) {
    throw new Error(
      "conditional recovery authority observation is foreign or already used",
    );
  }
  const authorityAge = Date.now() - state.issuedAtMs;
  if (
    authorityAge < 0 ||
    authorityAge > CONDITIONAL_RECOVERY_AUTHORITY_MAX_AGE_MS
  ) {
    throw new Error("conditional recovery authority observation is stale");
  }
  consumedAuthorityObservations.add(value);
  return value as unknown as ConditionalRecoveryAuthorityObservation;
}

function decodeCapabilityRecord(value: unknown): ConditionalRecoveryCapability {
  const capability = requireObject(
    value,
    "conditional recovery catalogue capability",
  );
  requireExactKeys(
    capability,
    ["version", "maxPageSize"],
    "conditional recovery catalogue capability",
  );
  if (capability.version !== CONDITIONAL_RECOVERY_CATALOGUE_VERSION) {
    throw new Error("conditional recovery catalogue version is unsupported");
  }
  const maxPageSize = requireSafeInteger(
    capability.maxPageSize,
    "conditional recovery catalogue page size",
  );
  if (maxPageSize < 1 || maxPageSize > CONDITIONAL_RECOVERY_MAX_PAGE_SIZE) {
    throw new Error("conditional recovery catalogue page size is invalid");
  }
  return Object.freeze({
    version: CONDITIONAL_RECOVERY_CATALOGUE_VERSION,
    maxPageSize,
  });
}

function freezeProgress(value: {
  capability: ConditionalRecoveryCapability;
  walletScope: ConditionalRecoveryWalletScope;
  pageCount: number;
  cursorDigests: readonly string[];
  budget: ConditionalRecoveryBudget;
}): ConditionalCatalogueProgress {
  return Object.freeze({
    capability: decodeCapabilityRecord(value.capability),
    walletScope: decodeConditionalRecoveryWalletScope(value.walletScope),
    pageCount: requireBudgetCounter(
      value.pageCount,
      CONDITIONAL_RECOVERY_MAX_PAGES,
      "page count",
    ),
    cursorDigests: Object.freeze([...value.cursorDigests]),
    budget: decodeConditionalRecoveryBudget(value.budget),
  });
}

function requireLiveProgress(value: unknown): ConditionalCatalogueProgress {
  if (!isObject(value) || !liveProgress.has(value)) {
    throw new Error("conditional recovery live catalogue progress is invalid");
  }
  return value as unknown as ConditionalCatalogueProgress;
}

function requireTerminalPage(
  value: unknown,
): ValidatedConditionalCataloguePage {
  if (!isObject(value) || !livePages.get(value)?.terminalComplete) {
    throw new Error(
      "conditional recovery finalization requires a live terminal page",
    );
  }
  return value as unknown as ValidatedConditionalCataloguePage;
}

export function requireCompletedCatalogue(
  value: unknown,
): CompletedConditionalRecoveryCatalogue {
  if (!isObject(value) || !completedCatalogues.has(value)) {
    throw new Error(
      "conditional recovery completed catalogue evidence is invalid",
    );
  }
  return value as unknown as CompletedConditionalRecoveryCatalogue;
}

export function requireValidatedTarget(
  value: unknown,
  catalogue: CompletedConditionalRecoveryCatalogue,
): ValidatedConditionalRecoveryTarget {
  if (
    !isObject(value) ||
    !validatedTargets.has(value) ||
    targetCatalogues.get(value) !== catalogue
  ) {
    throw new Error(
      "conditional recovery validated target evidence is invalid",
    );
  }
  return value as unknown as ValidatedConditionalRecoveryTarget;
}

function decodeCatalogueCheckpoint(
  value: unknown,
): ConditionalCatalogueCheckpoint {
  const row = requireObject(value, "conditional recovery catalogue checkpoint");
  requireExactKeys(
    row,
    [
      "schemaVersion",
      "capability",
      "walletScope",
      "pageCount",
      "cursorDigests",
      "terminalComplete",
      "currentCursor",
      "keysets",
      "budget",
    ],
    "conditional recovery catalogue checkpoint",
  );
  if (row.schemaVersion !== CONDITIONAL_RECOVERY_CHECKPOINT_VERSION) {
    throw new Error("conditional recovery checkpoint version is unsupported");
  }
  const capability = decodeCapabilityRecord(row.capability);
  const walletScope = decodeConditionalRecoveryWalletScope(row.walletScope);
  const pageCount = requireBudgetCounter(
    row.pageCount,
    CONDITIONAL_RECOVERY_MAX_PAGES,
    "page count",
  );
  if (typeof row.terminalComplete !== "boolean") {
    throw new Error(
      "conditional recovery checkpoint terminal marker is invalid",
    );
  }
  const currentCursor = decodeOptionalCursor(
    row.currentCursor,
    "checkpoint current cursor",
  );
  if (!Array.isArray(row.cursorDigests)) {
    throw new Error(
      "conditional recovery checkpoint cursor digests are invalid",
    );
  }
  const expectedDigestCount = row.terminalComplete ? pageCount - 1 : pageCount;
  if (
    expectedDigestCount < 0 ||
    row.cursorDigests.length !== expectedDigestCount
  ) {
    throw new Error(
      "conditional recovery checkpoint cursor lineage is inconsistent",
    );
  }
  if (
    (row.terminalComplete && currentCursor !== null) ||
    (!row.terminalComplete &&
      pageCount > 0 &&
      (currentCursor === null ||
        digestCursor(currentCursor) !== row.cursorDigests.at(-1)))
  ) {
    throw new Error(
      "conditional recovery checkpoint current cursor is inconsistent",
    );
  }
  const seen = new Set<string>();
  const cursorDigests = row.cursorDigests.map((digest) => {
    if (
      typeof digest !== "string" ||
      !LOWER_HEX_32.test(digest) ||
      seen.has(digest)
    ) {
      throw new Error(
        "conditional recovery checkpoint cursor digest is invalid",
      );
    }
    seen.add(digest);
    return digest;
  });
  if (!Array.isArray(row.keysets)) {
    throw new Error("conditional recovery checkpoint keysets are invalid");
  }
  const keysets = mergeConditionalRecoveryCatalogue([], row.keysets);
  if (
    keysets.length >
    checkedSafeMultiply(
      pageCount,
      capability.maxPageSize,
      "checkpoint item bound",
    )
  ) {
    throw new Error(
      "conditional recovery checkpoint keyset count is inconsistent",
    );
  }
  if (pageCount === 0 && keysets.length !== 0) {
    throw new Error("conditional recovery initial checkpoint is inconsistent");
  }
  return Object.freeze({
    schemaVersion: CONDITIONAL_RECOVERY_CHECKPOINT_VERSION,
    capability,
    walletScope,
    pageCount,
    cursorDigests: Object.freeze(cursorDigests),
    terminalComplete: row.terminalComplete,
    currentCursor,
    keysets,
    budget: decodeConditionalRecoveryBudget(row.budget),
  });
}

function validateRequestedCatalogueCursor(
  progress: ConditionalCatalogueProgress,
  requestedCursor: string | null,
): void {
  if (progress.pageCount === 0) {
    if (requestedCursor !== null || progress.cursorDigests.length !== 0) {
      throw new Error(
        "conditional recovery initial catalogue cursor is inconsistent",
      );
    }
    return;
  }
  if (requestedCursor === null) {
    throw new Error("conditional recovery resume cursor is missing");
  }
  if (digestCursor(requestedCursor) !== progress.cursorDigests.at(-1)) {
    throw new Error("conditional recovery resume cursor is foreign");
  }
}

function decodePageContinuation(
  complete: boolean,
  value: unknown,
  requestedCursor: string | null,
): string | null {
  if (complete) {
    if (value !== undefined) {
      throw new Error(
        "conditional recovery complete page included a continuation cursor",
      );
    }
    return null;
  }
  const cursor = decodeOptionalCursor(value, "continuation cursor");
  if (cursor === null) {
    throw new Error("conditional recovery incomplete page omitted its cursor");
  }
  if (cursor === requestedCursor) {
    throw new Error("conditional recovery catalogue made no cursor progress");
  }
  return cursor;
}

function deduplicatePageMetadata(
  values: unknown[],
): ConditionalRecoveryKeysetMetadata[] {
  const rows: ConditionalRecoveryKeysetMetadata[] = [];
  const positions = new Map<string, number>();
  for (const value of values) {
    const keyset = decodeWireMetadata(value);
    const position = positions.get(keyset.id);
    if (position === undefined) {
      positions.set(keyset.id, rows.length);
      rows.push(keyset);
    } else if (
      metadataFingerprint(rows[position]!) !== metadataFingerprint(keyset)
    ) {
      throw new Error(
        "conditional recovery catalogue page contained conflicting metadata",
      );
    }
  }
  return rows;
}

function decodeWireMetadata(value: unknown): ConditionalRecoveryKeysetMetadata {
  const raw = requireObject(value, "conditional recovery catalogue keyset");
  requireExactKeys(
    raw,
    [
      "id",
      "unit",
      "active",
      "input_fee_ppk",
      "final_expiry",
      "condition_id",
      "outcome_collection",
      "outcome_collection_id",
      "registered_at",
    ],
    "conditional recovery catalogue keyset",
    ["input_fee_ppk", "final_expiry"],
  );
  return validateNormalizedMetadata({
    id: raw.id,
    unit: raw.unit,
    active: raw.active,
    inputFeePpk: decodeOptionalSafeInteger(
      raw,
      "input_fee_ppk",
      "conditional recovery catalogue input fee",
      false,
    ),
    finalExpiry: decodeOptionalSafeInteger(
      raw,
      "final_expiry",
      "conditional recovery catalogue expiry",
      true,
    ),
    conditionId: raw.condition_id,
    outcomeCollection: raw.outcome_collection,
    outcomeCollectionId: raw.outcome_collection_id,
    registeredAt: raw.registered_at,
  });
}

function validateNormalizedMetadata(
  input: Record<string, unknown>,
): ConditionalRecoveryKeysetMetadata {
  const id = requireV2KeysetId(input.id);
  const unit = requireBoundedUnit(input.unit);
  if (typeof input.active !== "boolean") {
    throw new Error("conditional recovery catalogue active flag is invalid");
  }
  const inputFeePpk = requireNullableSafeInteger(
    input.inputFeePpk,
    "conditional recovery catalogue input fee",
    false,
  );
  const finalExpiry = requireNullableSafeInteger(
    input.finalExpiry,
    "conditional recovery catalogue expiry",
    true,
  );
  const conditionId = requireLowerHex32(input.conditionId, "condition id");
  const outcomeCollection = requireNonEmptyBoundedString(
    input.outcomeCollection,
    CONDITIONAL_RECOVERY_MAX_OUTCOME_COLLECTION_BYTES,
    "conditional recovery outcome collection",
  );
  const outcomeCollectionId = requireLowerHex32(
    input.outcomeCollectionId,
    "outcome collection id",
  );
  const registeredAt = requireUnixSeconds(
    input.registeredAt,
    "conditional recovery catalogue registered time",
  );
  if (
    computeRootOutcomeCollectionId(conditionId, outcomeCollection) !==
    outcomeCollectionId
  ) {
    throw new Error(
      "conditional recovery outcome collection id does not match zero-parent binding",
    );
  }
  return Object.freeze({
    id,
    unit,
    active: input.active,
    inputFeePpk,
    finalExpiry,
    conditionId,
    outcomeCollection,
    outcomeCollectionId,
    registeredAt,
  });
}

function decodeAmountKeys(value: unknown): Readonly<Record<string, string>> {
  const raw = requireObject(value, "conditional recovery amount keys");
  const entries = Object.entries(raw);
  if (
    entries.length < 1 ||
    entries.length > CONDITIONAL_RECOVERY_MAX_KEYS_PER_KEYSET
  ) {
    throw new Error("conditional recovery amount-key bound was exceeded");
  }
  const keys: Record<string, string> = {};
  for (const [amount, publicKey] of entries) {
    if (!CANONICAL_UINT.test(amount)) {
      throw new Error("conditional recovery denomination is invalid");
    }
    const parsed = BigInt(amount);
    if (parsed < 1n || parsed > UINT64_MAX) {
      throw new Error("conditional recovery denomination is outside uint64");
    }
    keys[amount] = requireCompressedSecpPublicKey(
      publicKey,
      "conditional recovery public key",
    );
  }
  return Object.freeze(keys);
}

function decodeConditionalRecoveryBudget(
  value: unknown,
): ConditionalRecoveryBudget {
  const budget = requireObject(value, "conditional recovery budget");
  requireExactKeys(
    budget,
    ["transportBytes", "serializedBytes", "workUnits", "proofCount"],
    "conditional recovery budget",
  );
  return freezeBudget({
    transportBytes: requireBudgetCounter(
      budget.transportBytes,
      CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
      "transport byte",
    ),
    serializedBytes: requireBudgetCounter(
      budget.serializedBytes,
      CONDITIONAL_RECOVERY_MAX_CATALOGUE_BYTES,
      "serialized byte",
    ),
    workUnits: requireBudgetCounter(
      budget.workUnits,
      CONDITIONAL_RECOVERY_MAX_WORK_UNITS,
      "work",
    ),
    proofCount: requireBudgetCounter(
      budget.proofCount,
      CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS,
      "proof",
    ),
  });
}

function freezeBudget(
  value: ConditionalRecoveryBudget,
): ConditionalRecoveryBudget {
  return Object.freeze({ ...value });
}

function metadataFingerprint(value: ConditionalRecoveryKeysetMetadata): string {
  return bytesToHex(sha256(encoder.encode(JSON.stringify(value))));
}

function digestCursor(cursor: string): string {
  return bytesToHex(sha256(encoder.encode(cursor)));
}

function decodeOptionalCursor(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return requireNonEmptyBoundedString(
    value,
    CONDITIONAL_RECOVERY_MAX_CURSOR_BYTES,
    "conditional recovery " + label,
  );
}

function decodeOptionalSafeInteger(
  object: Record<string, unknown>,
  key: string,
  label: string,
  rejectZero: boolean,
): number | null {
  if (!hasOwn(object, key) || object[key] === undefined) return null;
  if (object[key] === null) throw new Error(label + " is invalid");
  return requireNullableSafeInteger(object[key], label, rejectZero);
}

function requireNullableSafeInteger(
  value: unknown,
  label: string,
  rejectZero: boolean,
): number | null {
  if (value === null) return null;
  const integer = requireSafeInteger(value, label);
  if (integer < 0 || (rejectZero && integer === 0)) {
    throw new Error(label + " is invalid");
  }
  return integer;
}

export function requireV2KeysetId(value: unknown): string {
  if (typeof value !== "string" || !V2_KEYSET_ID.test(value)) {
    throw new Error(
      "conditional recovery requires a canonical v2 secp keyset id",
    );
  }
  return value;
}

export function requireLowerHex32(value: unknown, label: string): string {
  if (typeof value !== "string" || !LOWER_HEX_32.test(value)) {
    throw new Error(
      "conditional recovery " + label + " is not canonical lowercase hex",
    );
  }
  return value;
}

export function requireCompressedSecpPublicKey(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || !COMPRESSED_SECP_PUBLIC_KEY.test(value)) {
    throw new Error(label + " is invalid");
  }
  try {
    secp256k1.Point.fromHex(value);
  } catch {
    throw new Error(label + " is invalid");
  }
  return value;
}

function requireBoundedUnit(value: unknown): string {
  return requireNonEmptyBoundedString(
    value,
    CONDITIONAL_RECOVERY_MAX_UNIT_BYTES,
    "conditional recovery unit",
  );
}

export function requireNonEmptyBoundedString(
  value: unknown,
  maxBytes: number,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).length > maxBytes
  ) {
    throw new Error(label + " is invalid");
  }
  return value;
}

function requireUnixSeconds(value: unknown, label: string): number {
  const integer = requireSafeInteger(value, label);
  if (integer < 0) throw new Error(label + " is invalid");
  return integer;
}

export function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(label + " is invalid");
  }
  return value;
}

function requireBudgetCounter(
  value: unknown,
  limit: number,
  label: string,
): number {
  const count = requireSafeInteger(value, "conditional recovery " + label);
  if (count < 0 || count > limit) {
    throw new Error("conditional recovery " + label + " budget is invalid");
  }
  return count;
}

function requireCharge(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  const count = requireSafeInteger(
    value,
    "conditional recovery " + label + " charge",
  );
  if (count < 0)
    throw new Error("conditional recovery " + label + " charge is invalid");
  return count;
}

export function requireBoundedPageBytes(value: unknown): number {
  const bytes = requireSafeInteger(
    value,
    "conditional recovery page byte count",
  );
  if (bytes < 0 || bytes > CONDITIONAL_RECOVERY_MAX_PAGE_BYTES) {
    throw new Error("conditional recovery page byte bound was exceeded");
  }
  return bytes;
}

export function checkedSafeAdd(
  left: number,
  right: number,
  label: string,
): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error("conditional recovery " + label + " overflowed");
  }
  return result;
}

export function checkedSafeMultiply(
  left: number,
  right: number,
  label: string,
): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) {
    throw new Error("conditional recovery " + label + " overflowed");
  }
  return result;
}

function checkedBudgetAdd(
  current: number,
  count: number,
  limit: number,
  label: string,
): number {
  const next = checkedSafeAdd(current, count, label);
  if (next > limit) {
    throw new Error("conditional recovery exceeded its " + label + " bound");
  }
  return next;
}

export function boundedJsonBytes(
  value: unknown,
  limit: number,
  label: string,
): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(label + " is not serializable");
  }
  if (serialized === undefined) throw new Error(label + " is not serializable");
  const bytes = encoder.encode(serialized).length;
  if (bytes > limit) throw new Error(label + " exceeded its byte bound");
  return bytes;
}

export function requireObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error(label + " is invalid");
  }
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function requireExactKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedSet.has(key))) {
    throw new Error(label + " contains an unknown field");
  }
  const optionalSet = new Set(optional);
  if (allowed.some((key) => !optionalSet.has(key) && !hasOwn(object, key))) {
    throw new Error(label + " omitted a required field");
  }
}

export function canonicalAmount(value: unknown, label: string): string {
  try {
    const amount = Amount.from(value as never).toBigInt();
    if (amount < 1n || amount > UINT64_MAX) throw new Error();
    return amount.toString();
  } catch {
    throw new Error(label + " is invalid");
  }
}

export function canonicalRestoreOutputAmount(
  value: unknown,
  label: string,
): string {
  try {
    const amount = Amount.from(value as never).toBigInt();
    if (amount < 0n || amount > UINT64_MAX) throw new Error();
    return amount.toString();
  } catch {
    throw new Error(label + " is invalid");
  }
}

export function digestValue(value: unknown): string {
  return bytesToHex(sha256(encoder.encode(JSON.stringify(value))));
}

export function freezeSession(input: {
  walletScope: ConditionalRecoveryWalletScope;
  sequence: number;
  predecessorDigest: string | null;
  transition: ConditionalRecoverySessionTransition;
  evidenceDigest: string;
  budget: ConditionalRecoveryBudget;
  completedKeysetProofCount: number;
  catalogueOrdinal: number | null;
  activeKeysetId: string | null;
  keysetMetadataDigest: string | null;
  scan: ConditionalRecoverySession["scan"];
  currentBatch: ConditionalRecoveryBatchBinding | null;
  keysetTerminalEvidence: ConditionalRecoveryKeysetTerminalEvidence | null;
  skipEvidence: ConditionalRecoverySkipEvidence | null;
  terminalEvidence: ConditionalRecoveryTerminalEvidence | null;
}): ConditionalRecoverySession {
  const walletScope = decodeConditionalRecoveryWalletScope(input.walletScope);
  const sequence = requireSafeInteger(
    input.sequence,
    "conditional recovery session sequence",
  );
  if (sequence < 0)
    throw new Error("conditional recovery session sequence is invalid");
  const predecessorDigest =
    input.predecessorDigest === null
      ? null
      : requireLowerHex32(
          input.predecessorDigest,
          "session predecessor digest",
        );
  const transition = decodeConditionalRecoverySessionTransition(
    input.transition,
  );
  const evidenceDigest = requireLowerHex32(
    input.evidenceDigest,
    "session evidence digest",
  );
  const budget = decodeConditionalRecoveryBudget(input.budget);
  const scan = decodeConditionalRecoveryScan(input.scan, {
    maxBatchSize: CONDITIONAL_RECOVERY_MAX_PROOFS,
    maxTotalOutputs: CONDITIONAL_RECOVERY_MAX_TOTAL_PROOFS,
  });
  const completedKeysetProofCount = requireSafeInteger(
    input.completedKeysetProofCount,
    "conditional recovery completed-keyset proof count",
  );
  const candidate = {
    schemaVersion: CONDITIONAL_RECOVERY_SESSION_SCHEMA_VERSION,
    walletScope,
    sequence,
    predecessorDigest,
    transition,
    evidenceDigest,
    budget,
    completedKeysetProofCount,
    catalogueOrdinal: input.catalogueOrdinal,
    activeKeysetId: input.activeKeysetId,
    keysetMetadataDigest: input.keysetMetadataDigest,
    scan,
    currentBatch: input.currentBatch,
    keysetTerminalEvidence: input.keysetTerminalEvidence,
    skipEvidence: input.skipEvidence,
    terminalEvidence: input.terminalEvidence,
  } as const;
  validateConditionalRecoverySessionState(candidate);
  const digest = computeConditionalRecoverySessionDigest(candidate);
  return Object.freeze({ ...candidate, digest });
}

export function requireLiveSession(
  value: unknown,
  walletScope: ConditionalRecoveryWalletScope,
): ConditionalRecoverySessionCasPort {
  if (!isObject(value)) {
    throw new Error("conditional recovery session is invalid");
  }
  const port = liveSessions.get(value);
  if (port === undefined) {
    throw new Error(
      "conditional recovery session is stale or already consumed",
    );
  }
  assertConditionalRecoveryWalletScopeMatches(
    (value as unknown as ConditionalRecoverySession).walletScope,
    walletScope,
  );
  return port;
}

export function beginConditionalRecoverySessionCapabilityReplay(input: {
  readonly lineage: readonly ConditionalRecoverySession[];
  readonly sessionPort: ConditionalRecoverySessionCasPort;
}): ConditionalRecoverySession {
  if (!Array.isArray(input.lineage) || input.lineage.length === 0) {
    throw new Error("conditional recovery rehydration lineage is missing");
  }
  const [initial, ...successors] = input.lineage;
  if (initial === undefined || initial.sequence !== 0) {
    throw new Error("conditional recovery rehydration initial session is invalid");
  }
  if (initial.transition !== "completed-catalogue") {
    throw new Error("conditional recovery rehydration lineage starts at the wrong stage");
  }
  if (initial.digest !== computeConditionalRecoverySessionDigest(initial)) {
    throw new Error("conditional recovery rehydration initial digest is invalid");
  }
  let predecessor = initial;
  for (const successor of successors) {
    validateConditionalRecoverySessionSuccessor(predecessor, successor);
    predecessor = successor;
  }
  if (
    input.sessionPort.readCurrentDigest(predecessor.walletScope) !==
    predecessor.digest
  ) {
    throw new Error(
      "conditional recovery rehydration session is not the adapter latest",
    );
  }
  const boundPort = rehydratedSessionPorts.get(predecessor.walletScope.scopeId);
  if (boundPort !== undefined && boundPort !== input.sessionPort) {
    throw new Error(
      "conditional recovery rehydration cannot substitute a different session port",
    );
  }
  rehydratedSessionPorts.set(predecessor.walletScope.scopeId, input.sessionPort);
  liveSessions.set(initial, input.sessionPort);
  return initial;
}

export async function replayConditionalRecoverySessionSuccessor<T>(input: {
  readonly current: ConditionalRecoverySession;
  readonly successor: ConditionalRecoverySession;
  readonly sessionPort: ConditionalRecoverySessionCasPort;
  readonly rederive: () => T | Promise<T>;
  readonly readSession: (value: T) => ConditionalRecoverySession;
}): Promise<T> {
  if (liveSessions.get(input.current) !== input.sessionPort) {
    throw new Error(
      "conditional recovery rehydration uses a stale or foreign session",
    );
  }
  validateConditionalRecoverySessionSuccessor(input.current, input.successor);
  replaySuccessors.set(
    input.current,
    Object.freeze({
      successor: input.successor,
      port: input.sessionPort,
    }),
  );
  try {
    const value = await input.rederive();
    if (input.readSession(value) !== input.successor) {
      throw new Error(
        "conditional recovery rehydration produced a foreign successor",
      );
    }
    return value;
  } finally {
    replaySuccessors.delete(input.current);
  }
}

export function adoptConditionalRecoveryReplaySuccessor(
  current: ConditionalRecoverySession,
  candidate: ConditionalRecoverySession,
  port: ConditionalRecoverySessionCasPort,
): ConditionalRecoverySession | null {
  const replay = replaySuccessors.get(current);
  if (replay === undefined) return null;
  if (replay.port !== port || replay.successor.digest !== candidate.digest) {
    throw new Error(
      "conditional recovery rehydration successor does not match persisted evidence",
    );
  }
  liveSessions.delete(current);
  liveSessions.set(replay.successor, port);
  replaySuccessors.delete(current);
  return replay.successor;
}

export function advanceSession(
  current: ConditionalRecoverySession,
  port: ConditionalRecoverySessionCasPort,
  transition: ConditionalRecoverySessionTransition,
  evidenceDigest: string,
  budget: ConditionalRecoveryBudget,
  scan: ConditionalRecoverySession["scan"],
  patch: Partial<
    Pick<
      ConditionalRecoverySession,
      | "completedKeysetProofCount"
      | "catalogueOrdinal"
      | "activeKeysetId"
      | "keysetMetadataDigest"
      | "currentBatch"
      | "keysetTerminalEvidence"
      | "skipEvidence"
      | "terminalEvidence"
    >
  > = {},
): ConditionalRecoverySession {
  if (liveSessions.get(current) !== port) {
    throw new Error(
      "conditional recovery session is stale or already consumed",
    );
  }
  const successor = freezeSession({
    walletScope: current.walletScope,
    sequence: checkedSafeAdd(current.sequence, 1, "session sequence"),
    predecessorDigest: current.digest,
    transition,
    evidenceDigest,
    budget,
    completedKeysetProofCount:
      patch.completedKeysetProofCount === undefined
        ? current.completedKeysetProofCount
        : patch.completedKeysetProofCount,
    catalogueOrdinal:
      patch.catalogueOrdinal === undefined
        ? current.catalogueOrdinal
        : patch.catalogueOrdinal,
    activeKeysetId:
      patch.activeKeysetId === undefined
        ? current.activeKeysetId
        : patch.activeKeysetId,
    keysetMetadataDigest:
      patch.keysetMetadataDigest === undefined
        ? current.keysetMetadataDigest
        : patch.keysetMetadataDigest,
    scan,
    currentBatch:
      patch.currentBatch === undefined ? current.currentBatch : patch.currentBatch,
    keysetTerminalEvidence:
      patch.keysetTerminalEvidence === undefined
        ? current.keysetTerminalEvidence
        : patch.keysetTerminalEvidence,
    skipEvidence:
      patch.skipEvidence === undefined ? current.skipEvidence : patch.skipEvidence,
    terminalEvidence:
      patch.terminalEvidence === undefined
        ? current.terminalEvidence
        : patch.terminalEvidence,
  });
  validateConditionalRecoverySessionSuccessor(current, successor);
  const replayed = adoptConditionalRecoveryReplaySuccessor(
    current,
    successor,
    port,
  );
  if (replayed !== null) return replayed;
  if (
    port.compareAndSwap({
      walletScope: current.walletScope,
      expectedDigest: current.digest,
      successor,
    }) !== true
  ) {
    throw new Error("conditional recovery session CAS failed");
  }
  liveSessions.delete(current);
  liveSessions.set(successor, port);
  return successor;
}
export function adoptExternallyCommittedConditionalRecoverySession(
  current: ConditionalRecoverySession,
  successor: ConditionalRecoverySession,
  port: ConditionalRecoverySessionCasPort,
): void {
  if (liveSessions.get(current) !== port) {
    throw new Error(
      "conditional recovery externally committed session uses a foreign port",
    );
  }
  validateConditionalRecoverySessionSuccessor(current, successor);
  liveSessions.delete(current);
  liveSessions.set(successor, port);
}


export function completeConditionalRecoveryKeyset(input: {
  session: ConditionalRecoverySession;
  sessionPort: ConditionalRecoverySessionCasPort;
  gapLimit?: number;
  evidenceDigest: string;
}): ConditionalRecoverySession {
  const keysetId = requireV2KeysetId(input.session.activeKeysetId);
  const evidenceDigest = requireLowerHex32(
    input.evidenceDigest,
    "keyset completion evidence digest",
  );
  let keysetTerminalEvidence: ConditionalRecoveryKeysetTerminalEvidence;
  switch (input.session.transition) {
    case "nut09-response": {
      const gapLimit = requireSafeInteger(
        input.gapLimit,
        "conditional recovery gap limit",
      );
      if (gapLimit < 1) {
        throw new Error("conditional recovery gap limit is invalid");
      }
      keysetTerminalEvidence = {
        kind: "gap-limit",
        keysetId,
        gapLimit,
        digest: evidenceDigest,
      };
      break;
    }
    case "expired-keyset-retention": {
      const stagedBatchId = input.session.currentBatch?.stagedBatchId;
      if (stagedBatchId === null || stagedBatchId === undefined) {
        throw new Error(
          "conditional recovery retained keyset has no staged batch",
        );
      }
      keysetTerminalEvidence = {
        kind: "expired-retention",
        keysetId,
        stagedBatchId,
        digest: evidenceDigest,
      };
      break;
    }
    default:
      throw new Error(
        "conditional recovery keyset cannot complete from this transition",
      );
  }
  return advanceSession(
    input.session,
    input.sessionPort,
    "keyset-completed",
    evidenceDigest,
    input.session.budget,
    initialConditionalRecoveryScan(input.session.scan.nextCounter),
    {
      completedKeysetProofCount: input.session.budget.proofCount,
      activeKeysetId: null,
      keysetMetadataDigest: null,
      currentBatch: null,
      keysetTerminalEvidence,
      skipEvidence: null,
      terminalEvidence: null,
    },
  );
}

export function completeConditionalRecoverySession(input: {
  session: ConditionalRecoverySession;
  sessionPort: ConditionalRecoverySessionCasPort;
  catalogueLength: number;
  evidenceDigest: string;
}): ConditionalRecoverySession {
  const catalogueLength = requireSafeInteger(
    input.catalogueLength,
    "conditional recovery catalogue length",
  );
  if (
    catalogueLength < 0 ||
    (input.session.catalogueOrdinal === null
      ? catalogueLength !== 0
      : input.session.catalogueOrdinal + 1 !== catalogueLength)
  ) {
    throw new Error(
      "conditional recovery completion catalogue length is inconsistent",
    );
  }
  const evidenceDigest = requireLowerHex32(
    input.evidenceDigest,
    "recovery completion evidence digest",
  );
  return advanceSession(
    input.session,
    input.sessionPort,
    "recovery-completed",
    evidenceDigest,
    input.session.budget,
    initialConditionalRecoveryScan(input.session.scan.nextCounter),
    {
      completedKeysetProofCount: input.session.budget.proofCount,
      activeKeysetId: null,
      keysetMetadataDigest: null,
      currentBatch: null,
      keysetTerminalEvidence: null,
      skipEvidence: null,
      terminalEvidence: {
        kind: "completed",
        catalogueLength,
        digest: evidenceDigest,
      },
    },
  );
}

export function failConditionalRecoverySessionClosed(input: {
  session: ConditionalRecoverySession;
  sessionPort: ConditionalRecoverySessionCasPort;
  reasonDigest: string;
}): ConditionalRecoverySession {
  const reasonDigest = requireLowerHex32(
    input.reasonDigest,
    "failed-closed reason digest",
  );
  return advanceSession(
    input.session,
    input.sessionPort,
    "recovery-failed-closed",
    reasonDigest,
    input.session.budget,
    input.session.scan,
    {
      terminalEvidence: {
        kind: "failed-closed",
        reasonDigest,
      },
      skipEvidence: null,
      keysetTerminalEvidence: null,
    },
  );
}

export function retireConditionalRecoverySession(
  session: ConditionalRecoverySession,
): void {
  if (!liveSessions.delete(session)) {
    throw new Error(
      "conditional recovery session is stale or already consumed",
    );
  }
}
