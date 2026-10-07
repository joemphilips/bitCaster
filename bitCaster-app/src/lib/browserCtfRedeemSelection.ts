import type { Proof } from "@cashu/cashu-ts";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import type { BrowserCustodyProofRow } from "../stores/durable-custody-types";
import { decodeBrowserCustodyConditionalKeysetRow } from "../stores/durable-custody-types";
import {
  CANONICAL_CTF_PROOF_PAGE_LIMIT_MAX,
  db,
  getCanonicalCtfProofPage,
  storedProofFromCustodyRow,
  type BitcasterDB,
} from "../stores/proof-db";
import { normalizeUrl } from "./url";

export interface BrowserCtfRedeemLeg {
  readonly keyset: ReturnType<typeof decodeBrowserCustodyConditionalKeysetRow>;
  readonly rows: readonly BrowserCustodyProofRow[];
  readonly proofs: readonly Proof[];
}

export async function* readBrowserCanonicalCtfRedeemLegs(input: {
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly conditionId: string;
  readonly outcomeCollection: string;
  readonly database?: BitcasterDB;
  readonly pageLimit?: number;
}): AsyncGenerator<BrowserCtfRedeemLeg> {
  const database = input.database ?? db;
  const normalizedMint = normalizeUrl(input.mintUrl);
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: input.conditionId,
    outcomeCollection: input.outcomeCollection,
  });
  const pageLimit = input.pageLimit ?? CANONICAL_CTF_PROOF_PAGE_LIMIT_MAX;
  let afterProofId: string | null = null;
  do {
    const page = await getCanonicalCtfProofPage(
      normalizedMint,
      {
        scopeId: input.scopeId,
        conditionId: input.conditionId,
        selectability: "selectable",
        afterProofId,
        limit: pageLimit,
      },
      database,
    );
    const groups = new Map<string, BrowserCustodyProofRow[]>();
    for (const row of page.proofs) {
      const group = groups.get(row.keysetId) ?? [];
      group.push(row);
      groups.set(row.keysetId, group);
    }
    for (const [keysetId, rows] of groups) {
      const raw = await database.custodyConditionalKeysets.get([
        input.scopeId,
        normalizedMint,
        "msat",
        keysetId,
      ]);
      if (!raw) throw new Error("canonical CTF redeem keyset authority is missing");
      const keyset = decodeBrowserCustodyConditionalKeysetRow(raw);
      if (
        keyset.scopeId !== input.scopeId ||
        keyset.normalizedMint !== normalizedMint ||
        keyset.unit !== "msat" ||
        keyset.keysetId !== keysetId ||
        keyset.conditionId !== input.conditionId ||
        rows.some(
          (row) =>
            row.conditionId !== keyset.conditionId ||
            row.outcomeCollection !== keyset.outcomeCollection,
        )
      ) {
        throw new Error("canonical CTF redeem proof and keyset authority conflict");
      }
      if (keyset.outcomeCollection !== input.outcomeCollection) continue;
      if (keyset.outcomeCollectionId !== outcomeCollectionId) {
        throw new Error("canonical CTF redeem asset authority conflict");
      }
      yield {
        keyset,
        rows,
        proofs: rows.map(storedProofFromCustodyRow),
      };
    }
    afterProofId = page.nextProofId;
  } while (afterProofId !== null);
}
