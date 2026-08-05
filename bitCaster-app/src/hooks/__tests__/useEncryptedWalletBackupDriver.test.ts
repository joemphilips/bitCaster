// @vitest-environment node
import { expect, it } from "vitest";
import {
  createEncryptedWalletBackupBackgroundCycleSignal,
  ENCRYPTED_WALLET_BACKUP_BACKGROUND_CYCLE_DEADLINE_MILLISECONDS,
} from "../../lib/encryptedWalletBackupDriver";

it("covers eighteen head pages plus one mutation request deadline", () => {
  const maximumRequestStages = 18 + 1;
  expect(ENCRYPTED_WALLET_BACKUP_BACKGROUND_CYCLE_DEADLINE_MILLISECONDS).toBeGreaterThanOrEqual(
    maximumRequestStages * 15_000,
  );
});

it("aborts a background cycle when cleanup or its finite deadline fires", async () => {
  const cleanup = new AbortController();
  const cleanupBound = createEncryptedWalletBackupBackgroundCycleSignal(cleanup.signal, 1_000);
  cleanup.abort();
  expect(cleanupBound.aborted).toBe(true);

  const deadlineBound = createEncryptedWalletBackupBackgroundCycleSignal(
    new AbortController().signal,
    10,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expect(deadlineBound.aborted).toBe(true);
});
