import { conditionIdFromMarketId } from "@bitcaster/client-sdk/orderRoute";

const MAX_CONDITION_COOLDOWNS = 64;

const cooldownsByCondition = new Map<string, number>();

export function cooldownConditionForMarketId(marketId: string): string {
  try {
    return conditionIdFromMarketId(marketId);
  } catch {
    return marketId;
  }
}

export function cooldownDelayMs(conditionId: string | null, now = Date.now()): number {
  if (conditionId === null) return 0;
  const until = cooldownsByCondition.get(conditionId);
  if (until === undefined) return 0;
  if (until <= now) {
    cooldownsByCondition.delete(conditionId);
    return 0;
  }
  return until - now;
}

export function recordCooldown(
  conditionId: string | null,
  retryAfterSeconds: number | null,
  now = Date.now(),
): void {
  if (conditionId === null || retryAfterSeconds === null || retryAfterSeconds <= 0) return;
  const until = now + Math.ceil(retryAfterSeconds * 1_000);
  const current = cooldownsByCondition.get(conditionId);
  if (current === undefined && cooldownsByCondition.size >= MAX_CONDITION_COOLDOWNS) {
    pruneCooldowns(now);
    if (cooldownsByCondition.size >= MAX_CONDITION_COOLDOWNS) {
      const oldest = cooldownsByCondition.keys().next().value;
      if (oldest !== undefined) cooldownsByCondition.delete(oldest);
    }
  }
  cooldownsByCondition.set(conditionId, Math.max(current ?? 0, until));
}

function pruneCooldowns(now: number): void {
  for (const [conditionId, until] of cooldownsByCondition) {
    if (until <= now) cooldownsByCondition.delete(conditionId);
  }
}

export function clearFokPreviewCooldownsForTests(): void {
  cooldownsByCondition.clear();
}
