import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  buildAssetMonitoringHoldingsFromProofFacts,
  computeAssetMonitoringOutcomeUniverseDigest,
  type AssetMonitoringProofFact,
  type AssetMonitoringReportedHolding,
  type AssetMonitoringReportRequest,
} from "@bitcaster/client-sdk/assetMonitoring";
import { readAllocationBoundedJsonResponse } from "@bitcaster/client-sdk/boundedJsonResponse";
import { EngineClientError } from "@bitcaster/client-sdk/engineClient";
import {
  COLLATERAL_UNIT_REGISTRY,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import { canonicalizeOutcomeSet } from "@bitcaster/client-sdk/outcomeSets";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { normalizeUrl } from "@/lib/url";
import { isCtfProof, type StoredProof } from "@/stores/proof-db";

export const ASSET_MONITORING_CONDITIONS_MAX = 200;
const MARKET_CATALOGUE_PAGE_IDS_MAX = 50;
const MARKET_CATALOGUE_RESPONSE_BYTES_MAX = 512 * 1024;
const CANONICAL_CONDITION_ID = /^[0-9a-f]{64}$/;

const ROOT_CONDITION_ID = "0".repeat(64);

export interface AssetMonitoringCatalogueEntry {
  readonly conditionId: string;
  readonly outcomes: readonly string[];
}

export interface AssetMonitoringSnapshotInput {
  readonly proofs: readonly StoredProof[];
  readonly catalogue: readonly AssetMonitoringCatalogueEntry[];
}

export interface AssetMonitoringReporterRemote {
  submitAssetMonitoringReport(request: AssetMonitoringReportRequest): Promise<void>;
}

export interface AssetMonitoringReporterInput {
  readonly walletId: string;
  readonly buildHoldings: () => Promise<readonly AssetMonitoringReportedHolding[] | null>;
  readonly remote: AssetMonitoringReporterRemote;
  readonly hasPendingSubmittedOrder: () => Promise<boolean>;
  readonly isCurrent: () => boolean;
  readonly createReportId?: () => string;
}

/**
 * Builds one complete local monitoring snapshot.
 *
 * This function keeps proof bodies in local variables only. It returns only
 * canonical holding data. A missing or conflicting condition catalogue entry
 * aborts the whole snapshot.
 */
export function buildAssetMonitoringHoldings(
  input: AssetMonitoringSnapshotInput,
): AssetMonitoringReportedHolding[] | null {
  const conditions = new Set<string>();
  for (const proof of input.proofs) {
    if (!isCurrentProof(proof)) continue;
    if (isCtfProof(proof)) {
      const conditionId = conditionalMetadata(proof)?.conditionId;
      if (!conditionId) return null;
      conditions.add(conditionId);
      if (conditions.size > ASSET_MONITORING_CONDITIONS_MAX) return null;
    }
  }

  const catalogue = catalogueByCondition(input.catalogue, conditions);
  if (catalogue === null) return null;

  try {
    const facts: AssetMonitoringProofFact[] = [];
    for (const proof of input.proofs) {
      if (!isCurrentProof(proof)) continue;
      const asset = assetForProof(proof, catalogue);
      if (asset === null) return null;
      facts.push({
        proofIdentity: proofIdentity(proof),
        asset,
        keysetId: proof.id,
        amount: amountToNumber(proof.amount),
        state: proof.reservedBy ? "pending" : "available",
      });
    }
    return buildAssetMonitoringHoldingsFromProofFacts(facts);
  } catch {
    return null;
  }
}

/** Fetches the raw catalogue entries needed to resolve at most 200 conditions. */
export async function fetchAssetMonitoringCatalogue(
  conditionIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<AssetMonitoringCatalogueEntry[]> {
  const unique = uniqueConditionIds(conditionIds);
  if (unique.length > ASSET_MONITORING_CONDITIONS_MAX) {
    throw new Error("asset-monitoring condition catalogue is too large");
  }
  if (unique.length === 0) return [];
  const pages = await Promise.all(
    chunks(unique, MARKET_CATALOGUE_PAGE_IDS_MAX).map((ids) => fetchCataloguePage(ids, fetchImpl)),
  );
  return pages.flat();
}

/** Serializes fail-open reports for one captured wallet profile. */
export class AssetMonitoringReporter {
  readonly #input: AssetMonitoringReporterInput;
  readonly #createReportId: () => string;
  #requestedRevision = 0;
  #queued = false;
  #running = false;
  #stopped = false;

  constructor(input: AssetMonitoringReporterInput) {
    this.#input = input;
    this.#createReportId = input.createReportId ?? (() => crypto.randomUUID());
  }

  request(): void {
    if (this.#stopped) return;
    this.#requestedRevision += 1;
    this.#queued = true;
    if (!this.#running) void this.#run();
  }

  stop(): void {
    this.#stopped = true;
    this.#requestedRevision += 1;
    this.#queued = false;
  }

  async #run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queued && !this.#stopped) {
        this.#queued = false;
        const revision = this.#requestedRevision;
        const holdings = await this.#input.buildHoldings().catch(() => null);
        if (!this.#isCurrentRevision(revision) || holdings === null) continue;
        await this.#submitFrozen(revision, holdings);
      }
    } finally {
      this.#running = false;
      if (this.#queued && !this.#stopped) void this.#run();
    }
  }

  async #submitFrozen(
    revision: number,
    holdings: readonly AssetMonitoringReportedHolding[],
  ): Promise<void> {
    const request = this.#request(holdings, false);
    try {
      await this.#input.remote.submitAssetMonitoringReport(request);
      return;
    } catch (error) {
      if (!(error instanceof EngineClientError) || error.status !== 409) return;
    }
    if (!this.#isCurrentRevision(revision)) return;

    let pendingOrder: boolean;
    try {
      pendingOrder = await this.#input.hasPendingSubmittedOrder();
    } catch {
      return;
    }
    if (pendingOrder || !this.#isCurrentRevision(revision)) return;

    try {
      await this.#input.remote.submitAssetMonitoringReport(this.#request(holdings, true));
    } catch {
      // Monitoring is fail-open. A local change or next startup can repair it.
    }
  }

  #request(
    holdings: readonly AssetMonitoringReportedHolding[],
    startsNewInterval: boolean,
  ): AssetMonitoringReportRequest {
    return {
      walletId: this.#input.walletId,
      reportId: this.#createReportId(),
      startsNewInterval,
      holdings: holdings.map((holding) => ({ ...holding })),
    };
  }

  #isCurrentRevision(revision: number): boolean {
    return !this.#stopped && this.#input.isCurrent() && revision === this.#requestedRevision;
  }
}

function catalogueByCondition(
  entries: readonly AssetMonitoringCatalogueEntry[],
  conditions: ReadonlySet<string>,
): Map<string, AssetMonitoringCatalogueEntry> | null {
  const catalogue = new Map<string, AssetMonitoringCatalogueEntry>();
  for (const entry of entries) {
    if (!conditions.has(entry.conditionId) || catalogue.has(entry.conditionId)) return null;
    catalogue.set(entry.conditionId, entry);
  }
  return catalogue.size === conditions.size ? catalogue : null;
}

function assetForProof(
  proof: StoredProof,
  catalogue: ReadonlyMap<string, AssetMonitoringCatalogueEntry>,
): AssetMonitoringProofFact["asset"] | null {
  const unit = parseCashuProofUnit(proof.unit);
  if (unit === null) return null;
  const canonicalMintUrl = normalizeUrl(proof.mintUrl);
  const displayBaseAsset = COLLATERAL_UNIT_REGISTRY[unit].baseAsset;
  if (normalizeMarketBaseAsset(proof.baseAsset) !== displayBaseAsset) return null;
  if (!isCtfProof(proof)) {
    return { canonicalMintUrl, kind: "collateral", cashuUnit: unit, displayBaseAsset };
  }
  const metadata = conditionalMetadata(proof);
  if (metadata === null) return null;
  const entry = catalogue.get(metadata.conditionId);
  if (!entry || !isCanonicalOutcomeSet(metadata.outcomeCollection, entry.outcomes)) return null;
  return {
    canonicalMintUrl,
    kind: "conditional",
    cashuUnit: unit,
    displayBaseAsset,
    conditionId: metadata.conditionId,
    parentConditionId: ROOT_CONDITION_ID,
    outcomeUniverseDigest: computeAssetMonitoringOutcomeUniverseDigest(entry.outcomes),
    internalOutcomeSetId: metadata.outcomeCollection,
  };
}

function conditionalMetadata(
  proof: StoredProof,
): { conditionId: string; outcomeCollection: string } | null {
  const candidate = proof as StoredProof & {
    condition_id?: unknown;
    outcome_collection?: unknown;
  };
  if (
    (candidate.conditionId !== undefined &&
      candidate.condition_id !== undefined &&
      candidate.conditionId !== candidate.condition_id) ||
    (candidate.outcomeCollection !== undefined &&
      candidate.outcome_collection !== undefined &&
      candidate.outcomeCollection !== candidate.outcome_collection)
  ) {
    return null;
  }
  const conditionId = candidate.conditionId ?? candidate.condition_id;
  const outcomeCollection = candidate.outcomeCollection ?? candidate.outcome_collection;
  return typeof conditionId === "string" && typeof outcomeCollection === "string"
    ? { conditionId, outcomeCollection }
    : null;
}

function isCanonicalOutcomeSet(value: string, universe: readonly string[]): boolean {
  const selected = value.split("|");
  return (
    selected.length >= 1 &&
    selected.length < universe.length &&
    canonicalizeOutcomeSet(selected) === value &&
    selected.every((outcome) => universe.includes(outcome))
  );
}

function isCurrentProof(proof: StoredProof): boolean {
  return (
    proof.terminalOperationId === undefined &&
    (proof as { selectability?: unknown }).selectability !== "spent"
  );
}

function proofIdentity(proof: StoredProof): string {
  return bytesToHex(sha256(utf8ToBytes(`${proof.id}\u0000${proof.C}`)));
}

async function fetchCataloguePage(
  ids: readonly string[],
  fetchImpl: typeof fetch,
): Promise<AssetMonitoringCatalogueEntry[]> {
  const query = new URLSearchParams({
    ids: ids.join(","),
    state: "All",
    page_size: String(ids.length),
  });
  const response = await fetchImpl(`/api/v1/markets/query?${query}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("asset-monitoring condition catalogue is unavailable");
  const body = (await readAllocationBoundedJsonResponse(
    response,
    MARKET_CATALOGUE_RESPONSE_BYTES_MAX,
  )) as { markets?: unknown };
  if (!Array.isArray(body.markets))
    throw new Error("asset-monitoring condition catalogue is invalid");
  if (body.markets.length > ids.length) {
    throw new Error("asset-monitoring condition catalogue exceeds its page bound");
  }
  return body.markets.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !Array.isArray((entry as { outcomes?: unknown }).outcomes) ||
      typeof (entry as { conditionId?: unknown }).conditionId !== "string" ||
      !CANONICAL_CONDITION_ID.test((entry as { conditionId: string }).conditionId)
    ) {
      throw new Error("asset-monitoring condition catalogue is invalid");
    }
    return {
      conditionId: (entry as { conditionId: string }).conditionId,
      outcomes: (entry as { outcomes: unknown[] }).outcomes.map((outcome) => {
        if (typeof outcome !== "string") {
          throw new Error("asset-monitoring condition catalogue is invalid");
        }
        return outcome;
      }),
    };
  });
}

function uniqueConditionIds(conditionIds: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const conditionId of conditionIds) {
    if (!CANONICAL_CONDITION_ID.test(conditionId)) {
      throw new Error("asset-monitoring condition catalogue has an invalid condition ID");
    }
    unique.add(conditionId);
  }
  return [...unique];
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
