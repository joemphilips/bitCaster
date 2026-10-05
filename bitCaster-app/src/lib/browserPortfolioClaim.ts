import { getActiveRegularKeyset } from "@bitcaster/client-sdk/ctfRedeem";
import { summarizeConditionOracleEvidence } from "@bitcaster/client-sdk/conditionOracleEvidence";
import { restoreOutputGroups } from "@bitcaster/client-sdk/ctfSplit";
import { db } from "../stores/proof-db";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import { createActiveBrowserWalletCounterSource } from "../stores/browser-wallet-counter-db";
import { getWalletForMnemonicUnit, useWalletStore } from "../stores/wallet";
import { activeBrowserWalletScopeId } from "./browserWalletProfile";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import {
  claimBrowserCanonicalCtfPosition,
  type BrowserCanonicalCtfPositionClaimContext,
  type BrowserCanonicalCtfPositionClaimTarget,
} from "./browserCtfPositionClaim";
import { ensureWalletKeysetCounterReady, WalletKeysetCounterReadinessError } from "./cashu";
import {
  BrowserCtfClaimBoundaryError,
  browserCtfClaimBoundaryError,
  createBrowserCtfClaimAttemptRef,
  type BrowserCtfClaimFailureCategory,
} from "./browserCtfRedeemCoordinator";
import { toSeed } from "./bip39";
import { normalizeUrl } from "./url";
import { withWalletProfileLock } from "./walletProfileLock";
import { resolveBrowserConditionOracleEvidence } from "./browserConditionOracleEvidence";

export async function claimPortfolioPosition(input: {
  readonly mintUrl: string;
  readonly conditionId: string;
  readonly outcomeCollection: string;
  readonly targets?: readonly BrowserCanonicalCtfPositionClaimTarget[];
  readonly stopOnCommittedPayout?: boolean;
  readonly onCommittedLeg?: BrowserCanonicalCtfPositionClaimContext["onCommittedLeg"];
}) {
  const attemptRef = createBrowserCtfClaimAttemptRef();
  let failureCategory: BrowserCtfClaimFailureCategory = "profile-ownership";
  const completedClaim: {
    value: Awaited<ReturnType<typeof claimBrowserCanonicalCtfPosition>> | null;
  } = { value: null };
  try {
    const mnemonic = useWalletStore.getState().mnemonic;
    if (!mnemonic) throw new BrowserCtfClaimBoundaryError("profile-ownership");
    const seed = toSeed(mnemonic.trim().split(/\s+/));
    const scope = browserWalletScope(seed);
    const database = db;
    const mintUrl = normalizeUrl(input.mintUrl);
    const requireProfile = () => {
      if (activeBrowserWalletScopeId() !== scope.scopeId || db !== database) {
        throw new BrowserCtfClaimBoundaryError("profile-ownership");
      }
    };
    requireProfile();
    return await withWalletProfileLock(scope.scopeId, async () => {
      requireProfile();
      failureCategory = "keyset-authority";
      const wallet = await getWalletForMnemonicUnit(mintUrl, "msat", mnemonic);
      requireProfile();
      const adapter = new BrowserDurableCustodyAdapter(database);
      const observedAtMs = Date.now();
      failureCategory = "profile-ownership";
      const owner = await adapter.claimScope(scope, {
        incarnationId: `browser-portfolio-claim:${attemptRef}`,
        observedAtMs,
        leaseExpiresAtMs: observedAtMs + 10 * 60 * 1_000,
      });
      try {
        failureCategory = "persisted-recovery";
        completedClaim.value = await claimBrowserCanonicalCtfPosition({
          position: { conditionId: input.conditionId, outcomeCollection: input.outcomeCollection },
          targets: input.targets,
          stopOnCommittedPayout: input.stopOnCommittedPayout,
          walletProfileLockHeld: true,
          attemptRef,
          context: {
            seed,
            mintUrl,
            database,
            adapter,
            owner,
            wallet,
            observedAtMs,
            prepareNewLegAuthority: async () => {
              requireProfile();
              const [regularKeyset, resolution] = await Promise.all([
                getActiveRegularKeyset(wallet, "msat").catch(() => {
                  throw new BrowserCtfClaimBoundaryError("keyset-authority");
                }),
                resolveBrowserConditionOracleEvidence({
                  binding: {
                    scopeId: scope.scopeId,
                    normalizedMint: mintUrl,
                    unit: "msat",
                    conditionId: input.conditionId,
                    canonicalParentCollectionId: null,
                  },
                  wallet,
                }),
              ]);
              requireProfile();
              try {
                await ensureWalletKeysetCounterReady({
                  scopeId: scope.scopeId,
                  mintUrl,
                  unit: "msat",
                  keyset: {
                    id: regularKeyset.id,
                    canonicalMintUrl: mintUrl,
                    unit: "msat",
                    active: true,
                    keys: regularKeyset.keys,
                    inputFeePpk: regularKeyset.input_fee_ppk ?? 0,
                    finalExpiry: regularKeyset.final_expiry ?? null,
                  },
                  profileLockHeld: true,
                });
              } catch (error) {
                if (error instanceof WalletKeysetCounterReadinessError) {
                  throw new BrowserCtfClaimBoundaryError("counter-readiness");
                }
                throw browserCtfClaimBoundaryError(error, "counter-readiness");
              }
              requireProfile();
              return {
                regularKeyset,
                oracleWitness:
                  resolution.evidence.status === "verified"
                    ? resolution.evidence.canonicalOracleWitness
                    : "",
                oracleEvidence: summarizeConditionOracleEvidence(resolution.evidence),
                ...(resolution.evidence.status === "verified"
                  ? { oracleResolutionContext: resolution.evidence.context }
                  : {}),
              };
            },
            counterSource: createActiveBrowserWalletCounterSource(database, scope.scopeId, {
              mintUrl,
              unit: "msat",
            }),
            restoreOutputs: (url, outputs, keyset) => restoreOutputGroups(url, outputs, [keyset]),
            onCommittedLeg: async (leg) => {
              requireProfile();
              await input.onCommittedLeg?.(leg);
            },
          },
        });
        return completedClaim.value;
      } finally {
        try {
          await adapter.releaseScope(scope, { ...owner, observedAtMs: Date.now() });
        } catch {
          throw new BrowserCtfClaimBoundaryError("profile-ownership");
        }
      }
    });
  } catch (error) {
    const priorClaim = completedClaim.value;
    if (priorClaim !== null && priorClaim.kind !== "completed") return priorClaim;
    const failure = browserCtfClaimBoundaryError(error, failureCategory);
    const committed = priorClaim ?? {
      committedPayoutAmount: 0,
      committedLegs: 0,
      losingLegs: 0,
      pendingLegs: 0,
    };
    return {
      kind: "error" as const,
      committedPayoutAmount: committed.committedPayoutAmount,
      committedLegs: committed.committedLegs,
      losingLegs: committed.losingLegs,
      pendingLegs: committed.pendingLegs,
      ...(priorClaim?.oracleEvidence === undefined
        ? {}
        : { oracleEvidence: priorClaim.oracleEvidence }),
      error: {
        code: "claim-failed" as const,
        category: failure.category,
        message: failure.message,
        attemptRef,
        ...(failure.operationRef === undefined ? {} : { operationRef: failure.operationRef }),
      },
    };
  }
}
