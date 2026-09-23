import { getActiveRegularKeyset } from "@bitcaster/client-sdk/ctfRedeem";
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
import { fetchConditionAttestation } from "./cashu";
import { toSeed } from "./bip39";
import { normalizeUrl } from "./url";
import { withWalletProfileLock } from "./walletProfileLock";

export async function claimPortfolioPosition(input: {
  readonly mintUrl: string;
  readonly conditionId: string;
  readonly outcomeCollection: string;
  readonly targets?: readonly BrowserCanonicalCtfPositionClaimTarget[];
  readonly stopOnCommittedPayout?: boolean;
  readonly onCommittedLeg?: BrowserCanonicalCtfPositionClaimContext["onCommittedLeg"];
}) {
  const mnemonic = useWalletStore.getState().mnemonic;
  if (!mnemonic) throw new Error("The wallet profile is unavailable.");
  const seed = toSeed(mnemonic.trim().split(/\s+/));
  const scope = browserWalletScope(seed);
  const database = db;
  const mintUrl = normalizeUrl(input.mintUrl);
  const requireProfile = () => {
    if (activeBrowserWalletScopeId() !== scope.scopeId || db !== database) {
      throw new Error("The wallet profile changed during the claim.");
    }
  };
  requireProfile();
  return withWalletProfileLock(scope.scopeId, async () => {
    requireProfile();
    const wallet = await getWalletForMnemonicUnit(mintUrl, "msat", mnemonic);
    requireProfile();
    const adapter = new BrowserDurableCustodyAdapter(database);
    const observedAtMs = Date.now();
    const owner = await adapter.claimScope(scope, {
      incarnationId: `browser-portfolio-claim:${crypto.randomUUID()}`,
      observedAtMs,
      leaseExpiresAtMs: observedAtMs + 10 * 60 * 1_000,
    });
    try {
      return await claimBrowserCanonicalCtfPosition({
        position: { conditionId: input.conditionId, outcomeCollection: input.outcomeCollection },
        targets: input.targets,
        stopOnCommittedPayout: input.stopOnCommittedPayout,
        walletProfileLockHeld: true,
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
            const [regularKeyset, attestation] = await Promise.all([
              getActiveRegularKeyset(wallet, "msat"),
              fetchConditionAttestation(input.conditionId),
            ]);
            requireProfile();
            return {
              regularKeyset,
              oracleWitness: attestation.witnessJson,
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
    } finally {
      await adapter.releaseScope(scope, { ...owner, observedAtMs: Date.now() });
    }
  });
}
