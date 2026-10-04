import {
  assertCreatedResultMatches,
  assertMarketCreationBinding,
  assertMarketCreationPreparationEqual,
  snapshotMarketCreationPreparation,
  deriveDurableCustodyArtifactFingerprint,
  type CreateMarketResponse,
  type MarketCreationBinding,
  type MarketCreationPreparation,
  type MarketCreationRecord,
  type MarketCreationStore,
} from "@bitcaster/client-sdk";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import type { BitcasterDB } from "./proof-db";

export class BrowserMarketCreationStore implements MarketCreationStore {
  constructor(
    private readonly database: BitcasterDB,
    private readonly binding: MarketCreationBinding,
    private readonly requireCurrentBinding: () => MarketCreationBinding,
  ) {
    if (database.name !== browserWalletDatabaseName(binding.walletScopeId)) {
      throw new Error("Creation database belongs to a different wallet.");
    }
    this.requireBinding();
  }

  async read(creationId: string): Promise<MarketCreationRecord | null> {
    this.requireBinding();
    const record = await this.database.marketCreations.get(this.key(creationId));
    this.requireBinding();
    return record === undefined ? null : this.validate(record);
  }

  async reserve(input: MarketCreationPreparation): Promise<MarketCreationRecord> {
    this.requireBinding();
    const preparation = snapshotMarketCreationPreparation(input);
    assertMarketCreationBinding(preparation, this.binding);
    const record = await this.database.transaction(
      "rw",
      this.database.marketCreations,
      async () => {
        this.requireBinding();
        const existing = await this.database.marketCreations.get(this.key(preparation.creationId));
        if (existing !== undefined) {
          const retained = this.validate(existing);
          assertMarketCreationPreparationEqual(retained, preparation);
          return retained;
        }
        const created: MarketCreationRecord = {
          ...preparation,
          mintConfirmed: false,
          engineResult: null,
        };
        await this.database.marketCreations.add(created);
        this.requireBinding();
        return created;
      },
    );
    this.requireBinding();
    return record;
  }

  confirmMint(creationId: string): Promise<MarketCreationRecord> {
    return this.update(creationId, (record) => ({
      ...record,
      mintConfirmed: true,
    }));
  }

  confirmEngine(creationId: string, result: CreateMarketResponse): Promise<MarketCreationRecord> {
    return this.update(creationId, (record) => {
      if (!record.mintConfirmed) throw new Error("Mint registration is not confirmed.");
      assertCreatedResultMatches(result, record);
      if (
        record.engineResult !== null &&
        deriveDurableCustodyArtifactFingerprint(record.engineResult) !==
          deriveDurableCustodyArtifactFingerprint(result)
      )
        throw new Error("Engine confirmation conflicts with the retained creation.");
      return record.engineResult === null
        ? { ...record, engineResult: structuredClone(result) }
        : record;
    });
  }

  private async update(
    creationId: string,
    transition: (record: MarketCreationRecord) => MarketCreationRecord,
  ): Promise<MarketCreationRecord> {
    this.requireBinding();
    const updated = await this.database.transaction(
      "rw",
      this.database.marketCreations,
      async () => {
        this.requireBinding();
        const existing = await this.database.marketCreations.get(this.key(creationId));
        if (existing === undefined) throw new Error("Creation preparation is unavailable.");
        const next = this.validate(transition(this.validate(existing)));
        await this.database.marketCreations.put(next);
        this.requireBinding();
        return next;
      },
    );
    this.requireBinding();
    return updated;
  }

  private validate(record: MarketCreationRecord): MarketCreationRecord {
    const detached = snapshotMarketCreationPreparation(record);
    assertMarketCreationBinding(detached, this.binding);
    if (
      typeof record.mintConfirmed !== "boolean" ||
      (!record.mintConfirmed && record.engineResult !== null)
    ) {
      throw new Error("Creation progress is invalid.");
    }
    if (record.engineResult !== null) assertCreatedResultMatches(record.engineResult, detached);
    return {
      ...detached,
      mintConfirmed: record.mintConfirmed,
      engineResult: structuredClone(record.engineResult),
    };
  }

  private requireBinding(): void {
    assertMarketCreationBinding(this.binding, this.requireCurrentBinding());
  }

  private key(creationId: string): [string, string] {
    return [this.binding.walletScopeId, creationId];
  }
}
