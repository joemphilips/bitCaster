import { describe, expect, it, vi } from "vitest";
import type { WalletRecoveryTag } from "@bitcaster/client-sdk/walletRecoveryStatus";
import {
  beginWalletRecoveryPass,
  getWalletRecoveryPassSummary,
  subscribeWalletRecoveryPassSummary,
  walletRecoveryMintUrls,
  walletRecoveryTag,
} from "../walletRecoveryPassSummary";

// The record lives in page memory for the whole test file. Each test uses its
// own epoch, so an earlier test's record is another tag.
let nextEpoch = 1_000;
function freshTag(mintUrls: readonly string[] = ["https://mint.example"]): WalletRecoveryTag {
  nextEpoch += 1;
  return walletRecoveryTag({ scopeId: "scope-a", epoch: nextEpoch }, mintUrls);
}

const RETRY_AT = 5_000;

describe("walletRecoveryPassSummary", () => {
  it("normalizes the mint set with the rule that keys the durable rows", () => {
    expect(
      walletRecoveryMintUrls(["https://mint.example/", "", "https://mint.example", " "]),
    ).toEqual(["https://mint.example"]);
    const activation = { scopeId: "scope-a", epoch: 1 };
    expect(walletRecoveryTag(activation, ["https://b.example/", "https://a.example"])).toEqual(
      walletRecoveryTag(activation, ["https://a.example", "https://b.example"]),
    );
  });

  it("shows each stage result at once and counts the pass only after every stage", () => {
    const tag = freshTag();
    const pass = beginWalletRecoveryPass(tag, () => true);

    pass.walletStage("receives", { state: "completed" });

    expect(getWalletRecoveryPassSummary()).toMatchObject({
      tag,
      passSeq: 0,
      wallet: { receives: { state: "completed", coverage: "full" }, mints: null },
    });
    pass.complete();
    expect(getWalletRecoveryPassSummary()?.passSeq).toBe(1);

    const second = beginWalletRecoveryPass(tag, () => true);
    second.complete();
    expect(getWalletRecoveryPassSummary()).toMatchObject({
      passSeq: 2,
      wallet: { receives: { state: "completed" } },
    });
  });

  it("replaces the record when the activation epoch or the mint set changes", () => {
    const tag = freshTag();
    const pass = beginWalletRecoveryPass(tag, () => true);
    pass.walletStage("receives", { state: "completed" });
    pass.complete();

    const otherMints = walletRecoveryTag(tag.activation, ["https://other.example"]);
    beginWalletRecoveryPass(otherMints, () => true).discard();
    expect(getWalletRecoveryPassSummary()).toMatchObject({
      tag: otherMints,
      passSeq: 0,
      wallet: { receives: null },
    });

    const sameMints = walletRecoveryTag(tag.activation, ["https://mint.example/"]);
    beginWalletRecoveryPass(sameMints, () => true).discard();
    expect(getWalletRecoveryPassSummary()?.tag).toEqual(sameMints);
    expect(getWalletRecoveryPassSummary()?.passSeq).toBe(0);
  });

  it("drops every write of a discarded pass", () => {
    const tag = freshTag();
    const first = beginWalletRecoveryPass(tag, () => true);
    first.walletStage("receives", { state: "completed" });
    first.complete();

    const second = beginWalletRecoveryPass(tag, () => true);
    second.walletStage("receives", { state: "failed", retryAtMs: RETRY_AT });
    second.walletStage("mints", { state: "completed" });
    expect(getWalletRecoveryPassSummary()?.wallet.mints).not.toBeNull();
    second.discard();

    expect(getWalletRecoveryPassSummary()).toMatchObject({
      passSeq: 1,
      wallet: { receives: { state: "completed" }, mints: null },
    });
    // A discarded pass cannot count.
    second.complete();
    expect(getWalletRecoveryPassSummary()?.passSeq).toBe(1);
  });

  it("drops a write and every later write once the pass is not current", () => {
    const tag = freshTag();
    let current = true;
    const pass = beginWalletRecoveryPass(tag, () => current);
    pass.walletStage("receives", { state: "completed" });
    current = false;
    pass.walletStage("mints", { state: "completed" });
    current = true;
    pass.walletStage("rangeOrders", { state: "completed" });
    pass.complete();

    expect(getWalletRecoveryPassSummary()).toMatchObject({
      passSeq: 0,
      wallet: { receives: null, mints: null, rangeOrders: null },
    });
  });

  it("ignores the writer of an earlier pass when a new pass of the tag begins", () => {
    const tag = freshTag();
    const stale = beginWalletRecoveryPass(tag, () => true);
    stale.walletStage("receives", { state: "completed" });
    const fresh = beginWalletRecoveryPass(tag, () => true);

    expect(getWalletRecoveryPassSummary()?.wallet.receives).toBeNull();
    stale.walletStage("mints", { state: "completed" });
    stale.complete();
    expect(getWalletRecoveryPassSummary()).toMatchObject({ passSeq: 0, wallet: { mints: null } });
    fresh.complete();
    expect(getWalletRecoveryPassSummary()?.passSeq).toBe(1);
  });

  it("counts consecutive failures of one stage and resets the count after a success", () => {
    const tag = freshTag();
    const fail = () => {
      const pass = beginWalletRecoveryPass(tag, () => true);
      pass.walletStage("receives", { state: "failed", retryAtMs: RETRY_AT });
      pass.complete();
    };
    fail();
    fail();
    expect(getWalletRecoveryPassSummary()?.wallet.receives).toEqual({
      stage: "receives",
      state: "failed",
      consecutiveFailures: 2,
      retryAtMs: RETRY_AT,
    });

    const pass = beginWalletRecoveryPass(tag, () => true);
    pass.walletStage("receives", { state: "completed" });
    pass.complete();
    fail();
    expect(getWalletRecoveryPassSummary()?.wallet.receives).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  it("keeps the keysets of a counter result that is neither complete nor failed", () => {
    const tag = freshTag(["https://mint.example"]);
    const pass = beginWalletRecoveryPass(tag, () => true);

    pass.regularCounters(
      "https://mint.example/",
      {
        scannedKeysets: ["k1"],
        complete: false,
        failed: false,
        pendingKeysets: ["k1"],
        postponedKeysets: ["k2"],
      },
      RETRY_AT,
    );

    expect(getWalletRecoveryPassSummary()?.mints.get("https://mint.example")).toEqual({
      regularCounters: {
        observation: {
          stage: "regularCounters https://mint.example",
          state: "pending",
          reason: "operation",
          retryAtMs: null,
        },
        pendingKeysets: ["k1"],
        postponedKeysets: ["k2"],
      },
      resyncPass: null,
      seedRestorePass: null,
    });

    pass.regularCounters("https://mint.example", "error", RETRY_AT);
    pass.regularCounters(
      "https://mint.example",
      { scannedKeysets: [], complete: false, failed: true },
      RETRY_AT,
    );
    expect(
      getWalletRecoveryPassSummary()?.mints.get("https://mint.example")?.regularCounters,
    ).toEqual({
      observation: {
        stage: "regularCounters https://mint.example",
        state: "failed",
        consecutiveFailures: 2,
        retryAtMs: RETRY_AT,
      },
      pendingKeysets: [],
      postponedKeysets: [],
    });
  });

  it("maps a seed restore pass result and keeps a start-limit time", () => {
    const tag = freshTag(["https://mint.example"]);
    const pass = beginWalletRecoveryPass(tag, () => true);
    const restore = () =>
      getWalletRecoveryPassSummary()?.mints.get("https://mint.example")?.seedRestorePass;

    pass.seedRestorePass(
      "https://mint.example",
      { status: "waiting", retryAtMs: 9_000, hintsSettled: false },
      RETRY_AT,
    );
    expect(restore()).toEqual({
      observation: {
        stage: "seedRestorePass https://mint.example",
        state: "completed",
        coverage: "full",
      },
      startLimitRetryAtMs: 9_000,
    });

    pass.seedRestorePass(
      "https://mint.example",
      { status: "more", retryAtMs: null, hintsSettled: true },
      RETRY_AT,
    );
    expect(restore()).toEqual({
      observation: {
        stage: "seedRestorePass https://mint.example",
        state: "pending",
        reason: "scan-continues",
        retryAtMs: RETRY_AT,
      },
      startLimitRetryAtMs: null,
    });

    pass.seedRestorePass("https://mint.example", "error", RETRY_AT);
    expect(restore()?.observation).toEqual({
      stage: "seedRestorePass https://mint.example",
      state: "failed",
      consecutiveFailures: 1,
      retryAtMs: RETRY_AT,
    });
  });

  it("notifies subscribers of each change and keeps the snapshot between changes", () => {
    const tag = freshTag();
    const listener = vi.fn();
    const unsubscribe = subscribeWalletRecoveryPassSummary(listener);
    const pass = beginWalletRecoveryPass(tag, () => true);
    const calls = listener.mock.calls.length;
    const snapshot = getWalletRecoveryPassSummary();
    expect(getWalletRecoveryPassSummary()).toBe(snapshot);

    pass.walletStage("receives", { state: "completed" });
    expect(listener).toHaveBeenCalledTimes(calls + 1);
    expect(getWalletRecoveryPassSummary()).not.toBe(snapshot);
    unsubscribe();
    pass.complete();
    expect(listener).toHaveBeenCalledTimes(calls + 1);
  });
});
