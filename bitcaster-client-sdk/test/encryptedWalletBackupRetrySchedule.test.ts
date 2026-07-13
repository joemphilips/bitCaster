import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS,
  ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX,
  planEncryptedWalletBackupRetry,
} from "../src/encryptedWalletBackupRetrySchedule.ts";

const VAULT_ID = "00".repeat(32);
const ATTEMPT_ID = "11".repeat(16);

function plan(input: {
  currentStreak: number;
  minimumDelayMilliseconds: number;
  vaultId?: string;
}) {
  return planEncryptedWalletBackupRetry({
    realm: "production",
    vaultId: input.vaultId ?? VAULT_ID,
    attemptId: ATTEMPT_ID,
    currentStreak: input.currentStreak,
    minimumDelayMilliseconds: input.minimumDelayMilliseconds,
  });
}

test("backup retry schedule freezes deterministic cross-client vectors", () => {
  assert.deepEqual(
    plan({ currentStreak: 0, minimumDelayMilliseconds: 5_000 }),
    {
      streak: 1,
      delayMilliseconds: 5_682,
    },
  );
  assert.deepEqual(
    plan({ currentStreak: 1, minimumDelayMilliseconds: 5_000 }),
    {
      streak: 2,
      delayMilliseconds: 10_796,
    },
  );
  assert.deepEqual(
    plan({ currentStreak: 0, minimumDelayMilliseconds: 17_000 }),
    {
      streak: 1,
      delayMilliseconds: 17_142,
    },
  );
});

test("persisted retry streak survives reload, grows exponentially, and caps", () => {
  let streak = 0;
  for (let index = 0; index < 20; index += 1) {
    const scheduled = plan({
      currentStreak: streak,
      minimumDelayMilliseconds: 5_000,
    });
    const exponential = Math.min(
      ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS,
      5_000 * 2 ** Math.min(scheduled.streak - 1, 10),
    );
    assert.ok(scheduled.streak >= streak);
    assert.ok(scheduled.delayMilliseconds >= exponential);
    assert.ok(
      scheduled.delayMilliseconds <=
        Math.min(
          ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS,
          exponential + Math.floor(exponential / 5),
        ),
    );
    streak = scheduled.streak;
  }
  assert.equal(streak, 20);
  assert.equal(
    plan({ currentStreak: streak, minimumDelayMilliseconds: 5_000 })
      .delayMilliseconds,
    ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS,
  );
  assert.equal(
    plan({
      currentStreak: ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX,
      minimumDelayMilliseconds: 5_000,
    }).streak,
    ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX,
  );
});

test("server backoff is never shortened and deterministic jitter stays within twenty percent", () => {
  for (const minimum of [5_000, 17_000, 60_000, 3_000_000]) {
    const scheduled = plan({
      currentStreak: 0,
      minimumDelayMilliseconds: minimum,
    });
    assert.ok(scheduled.delayMilliseconds >= minimum);
    assert.ok(
      scheduled.delayMilliseconds <=
        Math.min(
          ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS,
          minimum + Math.floor(minimum / 5),
        ),
    );
  }
});

test("many vaults deterministically spread retry wakeups without mutable randomness", () => {
  for (const currentStreak of [0, 4, 8]) {
    const nextStreak = currentStreak + 1;
    const exponential = Math.min(
      ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS,
      5_000 * 2 ** Math.min(nextStreak - 1, 10),
    );
    const jitterRoom = Math.floor(exponential / 5);
    const buckets = new Uint32Array(20);
    const delays = new Set<number>();
    for (let index = 0; index < 4_096; index += 1) {
      const vaultId = index.toString(16).padStart(64, "0");
      const first = plan({
        currentStreak,
        minimumDelayMilliseconds: 5_000,
        vaultId,
      });
      const replayed = plan({
        currentStreak,
        minimumDelayMilliseconds: 5_000,
        vaultId,
      });
      assert.deepEqual(replayed, first);
      delays.add(first.delayMilliseconds);
      const bucket = Math.min(
        buckets.length - 1,
        Math.floor(
          ((first.delayMilliseconds - exponential) * buckets.length) /
            (jitterRoom + 1),
        ),
      );
      buckets[bucket] += 1;
    }
    const counts = [...buckets];
    assert.ok(delays.size > 800);
    assert.ok(Math.min(...counts) > 100);
    assert.ok(Math.max(...counts) < 310);
  }
});

test("invalid retry identities and persisted bounds fail closed", () => {
  assert.throws(() =>
    planEncryptedWalletBackupRetry({
      realm: "",
      vaultId: VAULT_ID,
      attemptId: ATTEMPT_ID,
      currentStreak: 0,
      minimumDelayMilliseconds: 5_000,
    }),
  );
  assert.throws(() =>
    plan({ currentStreak: -1, minimumDelayMilliseconds: 5_000 }),
  );
  assert.throws(() =>
    plan({ currentStreak: 0, minimumDelayMilliseconds: 3_600_001 }),
  );
  assert.throws(() =>
    planEncryptedWalletBackupRetry({
      realm: "Production",
      vaultId: VAULT_ID,
      attemptId: ATTEMPT_ID,
      currentStreak: 0,
      minimumDelayMilliseconds: 5_000,
    }),
  );
});
