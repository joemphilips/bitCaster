import type { WalletRecoveryStatus } from "@bitcaster/client-sdk/walletRecoveryStatus";
import type { BrowserSeedPositionRestorePassResult } from "@/lib/browserSeedPositionRestore";
import {
  beginWalletRecoveryPass,
  getWalletRecoveryPassSummary,
  walletRecoveryMintUrls,
  walletRecoveryTag,
} from "@/lib/walletRecoveryPassSummary";
import {
  browserWalletRecoveryStatus,
  readWalletRecoveryDurableRows,
} from "@/hooks/useWalletRecoveryStatus";

/** An epoch that no wallet activation uses, so this fixture's pass is not the coordinator's. */
const FIXTURE_EPOCH = -1;

/**
 * The wallet recovery status of the durable rows of one scope, after a pass
 * of this page ran every stage. Every pass stage completed except the seed
 * restore pass, which returned `seedRestore`. The durable rows then decide
 * the status.
 */
export async function durableWalletRecoveryStatus(input: {
  readonly scopeId: string;
  readonly mintUrls: readonly string[];
  readonly seedRestore?: BrowserSeedPositionRestorePassResult;
}): Promise<WalletRecoveryStatus> {
  const mintUrls = walletRecoveryMintUrls(input.mintUrls);
  const tag = walletRecoveryTag({ scopeId: input.scopeId, epoch: FIXTURE_EPOCH }, mintUrls);
  const pass = beginWalletRecoveryPass(tag, () => true);
  for (const stage of ["receives", "mints", "rangeOrders", "outgoing"] as const) {
    pass.walletStage(stage, { state: "completed" });
  }
  for (const mintUrl of mintUrls) {
    pass.regularCounters(mintUrl, { scannedKeysets: [], complete: true }, 0);
    pass.resyncPass(mintUrl, { state: "completed" });
    pass.seedRestorePass(
      mintUrl,
      input.seedRestore ?? { status: "complete", retryAtMs: null, hintsSettled: true },
      0,
    );
  }
  pass.complete();
  return browserWalletRecoveryStatus({
    current: tag,
    mintUrls,
    summary: getWalletRecoveryPassSummary(),
    durable: await readWalletRecoveryDurableRows(tag, mintUrls),
  });
}
