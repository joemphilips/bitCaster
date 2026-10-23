import { expect, it, vi } from "vitest";
import {
  Amount,
  Mint,
  Wallet,
  OutputData,
  CheckStateEnum,
  deriveKeysetId,
  createBlindSignature,
  createDLEQProof,
  hashToCurve,
  pointFromHex,
  type Proof,
} from "@cashu/cashu-ts";
import { bytesToHex } from "@noble/curves/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { deriveMarketFundingProductBinding } from "@bitcaster/client-sdk/marketFundingDelivery";
import { BitcasterDB, decodeBrowserOutgoingCashuTransferRow } from "../../stores/proof-db";
import { BrowserWalletCounterDexieStore } from "../../stores/browser-wallet-counter-db";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import { prepareBrowserDeterministicOutgoingCashuSend } from "../browserDeterministicOutgoingCashu";
import {
  executeBrowserDurableOutgoingCashuTransfer,
  type BrowserDurableOutgoingCashuContext,
} from "../browserDurableOutgoingCashuTransfer";

const state = vi.hoisted(() => ({
  createDraft: undefined as
    | ((input: {
        seed: Uint8Array;
        counterSource: import("@cashu/cashu-ts").CounterSource;
      }) => Promise<Wallet>)
    | undefined,
}));

vi.mock("../../stores/wallet", () => ({
  createUncachedWalletForSeedUnit: async (input: {
    seed: Uint8Array;
    counterSource: import("@cashu/cashu-ts").CounterSource;
  }) => {
    if (state.createDraft === undefined) throw new Error("draft wallet factory is not configured");
    return state.createDraft(input);
  },
}));

vi.mock("@/lib/cashu", () => ({ restoreExactMintOutputs: async () => [] }));

vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: async () => undefined,
}));

const SEED = new Uint8Array(64).fill(41);
const SCOPE = browserWalletScope(SEED);
const MINT_URL = "https://mint.test";
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 9]);
const PUBLIC_KEYS = { "1": bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) };
const KEYSET_ID = deriveKeysetId(PUBLIC_KEYS, { unit: "msat", versionByte: 1 });
const MARKET_SUBJECT = "browser-outgoing-subject";
const MARKET_CONDITION = "ab".repeat(32);
const MARKET_DIVISIBILITY = 1_000;
const MARKET_BINDING = deriveMarketFundingProductBinding({
  accountSubject: MARKET_SUBJECT,
  conditionId: MARKET_CONDITION,
  divisibility: MARKET_DIVISIBILITY,
});

it("uses one real IndexedDB commit for output counters and transfer authority", async () => {
  let database = new BitcasterDB(browserWalletDatabaseName(SCOPE.scopeId));
  const competitorDb = new BitcasterDB(database.name);
  const counterStore = () =>
    new BrowserWalletCounterDexieStore({
      database,
      scopeId: SCOPE.scopeId,
      isCurrentProfile: () => true,
    });
  const competitor = () =>
    new BrowserWalletCounterDexieStore({
      database: competitorDb,
      scopeId: SCOPE.scopeId,
      isCurrentProfile: () => true,
    });
  let drafts = 0;
  let stealOneCounter = false;
  let activeWallet: Wallet;
  const makeWallet = async (
    counterSource?: import("@cashu/cashu-ts").CounterSource,
    seed = SEED,
  ) => {
    const mint = new Mint(MINT_URL);
    mint.getInfo = async () => ({
      name: "fixture",
      pubkey: PUBLIC_KEYS["1"],
      version: "fixture",
      contact: [],
      nuts: {
        "3": { methods: [], disabled: false },
        "4": { methods: [], disabled: false },
        "5": { methods: [], disabled: false },
      },
    });
    mint.getKeySets = async () => ({
      keysets: [{ id: KEYSET_ID, unit: "msat", active: true, input_fee_ppk: 0 }],
    });
    mint.getKeys = async () => ({ keysets: [{ id: KEYSET_ID, unit: "msat", keys: PUBLIC_KEYS }] });
    const wallet = new Wallet(mint, {
      unit: "msat",
      bip39seed: seed,
      keysetId: KEYSET_ID,
      counterSource,
    });
    await wallet.loadMint();
    return wallet;
  };

  try {
    await counterStore().restoreInContext(
      { mintUrl: MINT_URL, unit: "msat" },
      KEYSET_ID,
      0,
      false,
      () => undefined,
    );
    const output = OutputData.createSingleData(1, KEYSET_ID, "outgoing-input", 7n);
    const signature = createBlindSignature(
      pointFromHex(output.blindedMessage.B_),
      PRIVATE_KEY,
      KEYSET_ID,
    );
    const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY);
    const proof: Proof = output.toProof(
      {
        id: KEYSET_ID,
        amount: Amount.from(1),
        C_: signature.C_.toHex(true),
        dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
      },
      { id: KEYSET_ID, keys: PUBLIC_KEYS },
    );
    const proofRow = createBrowserCustodyProofRow({
      scopeId: SCOPE.scopeId,
      normalizedMint: MINT_URL,
      unit: "msat",
      proof,
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    await database.custodyProofs.put(proofRow);
    await database.custodyProofBackupAuthorities.put(
      createBrowserProofBackupAuthorityRow(proofRow, 1, null, "initial-admission"),
    );

    activeWallet = await makeWallet();
    vi.spyOn(activeWallet, "completeSwap").mockRejectedValue(new Error("fixture mint offline"));
    vi.spyOn(activeWallet, "checkProofsStates").mockResolvedValue([
      { Y: "fixture-input", state: CheckStateEnum.UNSPENT, witness: null },
    ]);
    state.createDraft = async ({ seed, counterSource }) => {
      drafts += 1;
      const wallet = await makeWallet(counterSource, Uint8Array.from(seed));
      if (stealOneCounter && drafts === 1) {
        const prepare = wallet.prepareSwapToSend.bind(wallet);
        wallet.prepareSwapToSend = async (...args) => {
          const preview = await prepare(...args);
          await competitor().reserveInContext(
            { mintUrl: MINT_URL, unit: "msat" },
            KEYSET_ID,
            1,
            true,
          );
          return preview;
        };
      }
      return wallet;
    };
    const context: {
      -readonly [P in keyof BrowserDurableOutgoingCashuContext]: BrowserDurableOutgoingCashuContext[P];
    } = {
      seed: SEED,
      database,
      requireCapturedProfile: () => undefined,
      lockManager: {
        request: async (_name: string, _options: LockOptions, action: () => Promise<unknown>) =>
          action(),
      } as Pick<LockManager, "request">,
    };
    const keepProofDerivationLocators: Array<
      | import("@bitcaster/client-sdk/durableWalletProofDerivationLocator").DurableWalletProofDerivationLocator
      | null
    > = [];
    const prepare = () =>
      prepareBrowserDeterministicOutgoingCashuSend({
        operationId: "wallet-send:browser-atomic",
        amount: 1,
        proofs: [proof],
        mintUrl: MINT_URL,
        unit: "msat",
        seed: SEED,
        wallet: activeWallet,
        database,
        requireCapturedProfile: context.requireCapturedProfile,
        keepProofDerivationLocators,
        diagnosticLabel: "browser outgoing test",
      });
    const run = () =>
      executeBrowserDurableOutgoingCashuTransfer({
        marketFundingAttempt: {
          expectedPreviousTransferId: null,
          conditionId: MARKET_CONDITION,
          divisibility: MARKET_DIVISIBILITY,
          requireCredited: async () => undefined,
        },
        transfer: {
          transferId: "browser-atomic-outgoing",
          mintUrl: MINT_URL,
          unit: "msat",
          requestedAmount: "1",
          recipientSequence: { predecessorTransferId: null },
          deliveryIntent: {
            policy: "durable-recipient-ack",
            expectedSubject: MARKET_SUBJECT,
            opaqueProductBinding: MARKET_BINDING,
            tokenBytesLimit: 8192,
            tokenProofLimit: 8,
          },
        },
        prepareWalletSendOperation: prepare,
        preflightFundedAsset: async () => undefined,
        keepProofDerivationLocators,
        wallet: activeWallet,
        restoreExactOutputs: async () => ({ send: [], keep: [] }),
        context,
      });

    context.injectBindFault = "before-commit";
    const before = await outgoingFacts(database, SCOPE.scopeId, KEYSET_ID);
    await expect(run()).rejects.toThrow("injected browser custody fault before commit");
    expect(await outgoingFacts(database, SCOPE.scopeId, KEYSET_ID)).toBe(before);
    expect(await database.walletCounterCursors.get([SCOPE.scopeId, KEYSET_ID])).toBeUndefined();
    context.injectBindFault = undefined;

    stealOneCounter = true;
    drafts = 0;
    await expect(run()).rejects.toThrow("fixture mint offline");
    expect(drafts).toBe(2);
    const savedRow = await database.outgoingCashuTransfers.get([
      SCOPE.scopeId,
      "browser-atomic-outgoing",
    ]);
    expect(savedRow).toBeDefined();
    const saved = decodeBrowserOutgoingCashuTransferRow(SCOPE.scopeId, savedRow!);
    const expected = OutputData.createSingleDeterministicData(1, SEED, 1, KEYSET_ID);
    expect(saved.walletSendOperation.preview.sendOutputs[0]?.secret).toBe(
      new TextDecoder().decode(expected.secret),
    );
    const outputCount =
      saved.walletSendOperation.preview.sendOutputs.length +
      saved.walletSendOperation.preview.keepOutputs.length;
    expect((await database.walletCounterCursors.get([SCOPE.scopeId, KEYSET_ID]))?.next).toBe(
      1 + outputCount,
    );

    database.close();
    database = new BitcasterDB(browserWalletDatabaseName(SCOPE.scopeId));
    await database.open();
    expect(
      (await database.outgoingCashuTransfers.get([SCOPE.scopeId, "browser-atomic-outgoing"]))
        ?.scopeId,
    ).toBe(SCOPE.scopeId);
    expect(await database.marketFundingHeads.get([SCOPE.scopeId, MARKET_BINDING])).toMatchObject({
      transferId: "browser-atomic-outgoing",
      revision: 1,
    });
    expect((await database.walletCounterCursors.get([SCOPE.scopeId, KEYSET_ID]))?.next).toBe(
      1 + outputCount,
    );
    const replayOutputSecret = saved.walletSendOperation.preview.sendOutputs[0]?.secret;
    const draftsBeforeReplay = drafts;
    await expect(run()).rejects.toThrow();
    expect(drafts).toBe(draftsBeforeReplay);
    const replayed = decodeBrowserOutgoingCashuTransferRow(
      SCOPE.scopeId,
      (await database.outgoingCashuTransfers.get([SCOPE.scopeId, "browser-atomic-outgoing"]))!,
    );
    expect(replayed.walletSendOperation.preview.sendOutputs[0]?.secret).toBe(replayOutputSecret);
    expect((await database.walletCounterCursors.get([SCOPE.scopeId, KEYSET_ID]))?.next).toBe(
      1 + outputCount,
    );
  } finally {
    competitorDb.close();
    database.close();
    await database.delete();
  }
});

it("recovers a bind whose commit reply was lost without preparing or spending twice", async () => {
  const fixture = await createOutgoingScenario(53);
  try {
    fixture.context.injectBindFault = "after-commit";
    await expect(fixture.run()).rejects.toThrow("injected browser custody fault after commit");
    expect(fixture.draftCount()).toBe(1);
    const firstRow = await fixture.readTransfer();
    expect(firstRow).toBeDefined();
    const first = decodeBrowserOutgoingCashuTransferRow(fixture.scopeId, firstRow!);
    const outputCount = countOutputs(first);
    expect(
      (await fixture.database.walletCounterCursors.get([fixture.scopeId, KEYSET_ID]))?.next,
    ).toBe(outputCount);
    expect(
      await fixture.database.marketFundingHeads.get([fixture.scopeId, MARKET_BINDING]),
    ).toMatchObject({ transferId: fixture.transferId, revision: 1 });

    fixture.context.injectBindFault = undefined;
    await expect(fixture.run()).rejects.toThrow("fixture mint offline");
    expect(fixture.draftCount()).toBe(1);
    const replayRow = await fixture.readTransfer();
    expect(replayRow).toBeDefined();
    const replay = decodeBrowserOutgoingCashuTransferRow(fixture.scopeId, replayRow!);
    expect(replay.walletSendOperation.preview.sendOutputs[0]?.secret).toBe(
      first.walletSendOperation.preview.sendOutputs[0]?.secret,
    );
    expect(
      (await fixture.database.walletCounterCursors.get([fixture.scopeId, KEYSET_ID]))?.next,
    ).toBe(outputCount);
    expect(
      await fixture.database.marketFundingHeads.get([fixture.scopeId, MARKET_BINDING]),
    ).toMatchObject({ transferId: fixture.transferId, revision: 1 });
  } finally {
    await fixture.dispose();
  }
});

it("leaves only competing cursor advances after three counter conflicts", async () => {
  const fixture = await createOutgoingScenario(59, 3);
  try {
    const before = await outgoingFacts(fixture.database, fixture.scopeId, KEYSET_ID);
    await expect(fixture.run()).rejects.toThrow("browser wallet counter snapshot changed");
    expect(fixture.draftCount()).toBe(3);
    expect(JSON.parse(await fixture.outgoingFacts()) as Record<string, unknown>).toMatchObject({
      operations: 0,
      artifacts: 0,
      proofs: 1,
      reservations: 0,
      transfers: 0,
      admissions: 0,
      fundingHeads: 0,
    });
    expect(
      (await fixture.database.walletCounterCursors.get([fixture.scopeId, KEYSET_ID]))?.next,
    ).toBe(3);
    const withoutCursor = (facts: string) => {
      const parsed = JSON.parse(facts) as Record<string, unknown>;
      delete parsed.counter;
      return parsed;
    };
    expect(withoutCursor(await fixture.outgoingFacts())).toEqual(withoutCursor(before));
  } finally {
    await fixture.dispose();
  }
});

async function createOutgoingScenario(seedByte: number, conflicts = 0) {
  const seed = new Uint8Array(64).fill(seedByte);
  const scopeId = browserWalletScope(seed).scopeId;
  const transferId = `browser-atomic-${seedByte}`;
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  const competitorDb = new BitcasterDB(database.name);
  const counterStore = () =>
    new BrowserWalletCounterDexieStore({ database, scopeId, isCurrentProfile: () => true });
  const competitor = () =>
    new BrowserWalletCounterDexieStore({
      database: competitorDb,
      scopeId,
      isCurrentProfile: () => true,
    });
  let drafts = 0;
  let conflictsRemaining = conflicts;
  await counterStore().restoreInContext(
    { mintUrl: MINT_URL, unit: "msat" },
    KEYSET_ID,
    0,
    false,
    () => undefined,
  );
  const output = OutputData.createSingleData(1, KEYSET_ID, `outgoing-input-${seedByte}`, 7n);
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    KEYSET_ID,
  );
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY);
  const proof: Proof = output.toProof(
    {
      id: KEYSET_ID,
      amount: Amount.from(1),
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: KEYSET_ID, keys: PUBLIC_KEYS },
  );
  const proofRow = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT_URL,
    unit: "msat",
    proof,
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
  await database.custodyProofs.put(proofRow);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(proofRow, 1, null, "initial-admission"),
  );
  const makeWallet = async (
    counterSource?: import("@cashu/cashu-ts").CounterSource,
    walletSeed = seed,
  ) => {
    const mint = new Mint(MINT_URL);
    mint.getInfo = async () => ({
      name: "fixture",
      pubkey: PUBLIC_KEYS["1"],
      version: "fixture",
      contact: [],
      nuts: {
        "3": { methods: [], disabled: false },
        "4": { methods: [], disabled: false },
        "5": { methods: [], disabled: false },
      },
    });
    mint.getKeySets = async () => ({
      keysets: [{ id: KEYSET_ID, unit: "msat", active: true, input_fee_ppk: 0 }],
    });
    mint.getKeys = async () => ({ keysets: [{ id: KEYSET_ID, unit: "msat", keys: PUBLIC_KEYS }] });
    const wallet = new Wallet(mint, {
      unit: "msat",
      bip39seed: walletSeed,
      keysetId: KEYSET_ID,
      counterSource,
    });
    await wallet.loadMint();
    return wallet;
  };
  const activeWallet = await makeWallet();
  vi.spyOn(activeWallet, "completeSwap").mockRejectedValue(new Error("fixture mint offline"));
  vi.spyOn(activeWallet, "checkProofsStates").mockImplementation(async (proofs) =>
    proofs.map((candidate) => ({
      Y: hashToCurve(new TextEncoder().encode(candidate.secret)).toHex(true),
      state: CheckStateEnum.UNSPENT,
      witness: null,
    })),
  );
  state.createDraft = async ({ seed: draftSeed, counterSource }) => {
    drafts += 1;
    const wallet = await makeWallet(counterSource, Uint8Array.from(draftSeed));
    if (conflictsRemaining > 0) {
      const prepareSwap = wallet.prepareSwapToSend.bind(wallet);
      wallet.prepareSwapToSend = async (...args) => {
        const preview = await prepareSwap(...args);
        await competitor().reserveInContext(
          { mintUrl: MINT_URL, unit: "msat" },
          KEYSET_ID,
          1,
          true,
        );
        conflictsRemaining -= 1;
        return preview;
      };
    }
    return wallet;
  };
  const context: {
    -readonly [P in keyof BrowserDurableOutgoingCashuContext]: BrowserDurableOutgoingCashuContext[P];
  } = {
    seed,
    database,
    requireCapturedProfile: () => undefined,
    lockManager: {
      request: async (_name: string, _options: LockOptions, action: () => Promise<unknown>) =>
        action(),
    } as Pick<LockManager, "request">,
  };
  const keepProofDerivationLocators: Array<
    | import("@bitcaster/client-sdk/durableWalletProofDerivationLocator").DurableWalletProofDerivationLocator
    | null
  > = [];
  const prepare = () =>
    prepareBrowserDeterministicOutgoingCashuSend({
      operationId: `wallet-send:${seedByte}`,
      amount: 1,
      proofs: [proof],
      mintUrl: MINT_URL,
      unit: "msat",
      seed,
      wallet: activeWallet,
      database,
      requireCapturedProfile: context.requireCapturedProfile,
      keepProofDerivationLocators,
      diagnosticLabel: "browser outgoing test",
    });
  return {
    database,
    scopeId,
    transferId,
    context,
    draftCount: () => drafts,
    outgoingFacts: () => outgoingFacts(database, scopeId, KEYSET_ID),
    readTransfer: () => database.outgoingCashuTransfers.get([scopeId, transferId]),
    run: () =>
      executeBrowserDurableOutgoingCashuTransfer({
        marketFundingAttempt: {
          expectedPreviousTransferId: null,
          conditionId: MARKET_CONDITION,
          divisibility: MARKET_DIVISIBILITY,
          requireCredited: async () => undefined,
        },
        transfer: {
          transferId,
          mintUrl: MINT_URL,
          unit: "msat",
          requestedAmount: "1",
          recipientSequence: { predecessorTransferId: null },
          deliveryIntent: {
            policy: "durable-recipient-ack",
            expectedSubject: MARKET_SUBJECT,
            opaqueProductBinding: MARKET_BINDING,
            tokenBytesLimit: 8192,
            tokenProofLimit: 8,
          },
        },
        prepareWalletSendOperation: prepare,
        preflightFundedAsset: async () => undefined,
        keepProofDerivationLocators,
        wallet: activeWallet,
        restoreExactOutputs: async () => ({ send: [], keep: [] }),
        context,
      }),
    dispose: async () => {
      competitorDb.close();
      database.close();
      await database.delete();
    },
  };
}

async function outgoingFacts(
  database: BitcasterDB,
  scopeId: string,
  keysetId: string,
): Promise<string> {
  const [
    operations,
    artifacts,
    proofs,
    authorities,
    associations,
    counters,
    desiredAssets,
    transfers,
    admissions,
    fundingHeads,
    reservations,
  ] = await Promise.all([
    database.custodyOperations.toArray(),
    database.custodyArtifacts.toArray(),
    database.custodyProofs.toArray(),
    database.custodyProofBackupAuthorities.toArray(),
    database.walletCounterAssociations.toArray(),
    database.walletCounterCursors.toArray(),
    database.encryptedWalletBackupV2DesiredAssets.toArray(),
    database.outgoingCashuTransfers.toArray(),
    database.outgoingCashuTransferAdmissions.toArray(),
    database.marketFundingHeads.toArray(),
    database.custodyReservations.toArray(),
  ]);
  return JSON.stringify({
    operations: operations.filter((row) => row.record.scope.scopeId === scopeId).length,
    artifacts: artifacts.filter((row) => row.scopeId === scopeId).length,
    proofs: proofs.filter((row) => row.scopeId === scopeId).length,
    authorities: authorities.filter((row) => row.scopeId === scopeId).length,
    associations: associations.filter((row) => row.scopeId === scopeId).length,
    counter:
      counters.find((row) => row.scopeId === scopeId && row.keysetId === keysetId)?.next ?? null,
    desiredAssets: desiredAssets.filter((row) => row.scopeId === scopeId).length,
    transfers: transfers.filter((row) => row.scopeId === scopeId).length,
    admissions: admissions.filter((row) => row.scopeId === scopeId).length,
    fundingHeads: fundingHeads.filter((row) => row.scopeId === scopeId).length,
    reservations: reservations.filter((row) => row.scopeId === scopeId).length,
  });
}

function countOutputs(transfer: ReturnType<typeof decodeBrowserOutgoingCashuTransferRow>): number {
  return (
    transfer.walletSendOperation.preview.sendOutputs.length +
    transfer.walletSendOperation.preview.keepOutputs.length
  );
}
