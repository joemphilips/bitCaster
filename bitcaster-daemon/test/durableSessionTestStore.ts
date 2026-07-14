import {
  createDaemonSecrets,
  readSecrets,
  writeSecrets,
} from '../src/secrets.ts'
import { writeState, type DaemonState } from '../src/state.ts'

const TEST_SESSION_PRIVATE_KEY = '11'.repeat(32)
export const TEST_SESSION_PUBLIC_KEY =
  '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa'

/** Persists realistic retained-key authorities before FK-bound test sessions. */
export async function writeStateWithDurableSessionKeys(
  state: DaemonState,
): Promise<void> {
  const secrets =
    (await readSecrets()) ?? createDaemonSecrets('2026-07-14T00:00:00.000Z')
  for (const session of Object.values(state.durableTradeSessions)) {
    session.ephemeralKeyHandle.keyId = session.tradeId
    session.localProtocolPubkey = TEST_SESSION_PUBLIC_KEY
    session.ephemeralKeyHandle.localProtocolPubkey = TEST_SESSION_PUBLIC_KEY
    const swap = state.swaps[session.tradeId]
    secrets.orderEphemeralKeys[session.tradeId] = {
      orderId: swap?.orderId ?? session.tradeId,
      tradeId: session.tradeId,
      marketId: swap?.marketId ?? 'test-market',
      privateKeyHex: TEST_SESSION_PRIVATE_KEY,
      publicKeyHex: TEST_SESSION_PUBLIC_KEY,
      createdAt: '2026-07-14T00:00:00.000Z',
    }
  }
  await writeSecrets(secrets)
  await writeState(state)
}
