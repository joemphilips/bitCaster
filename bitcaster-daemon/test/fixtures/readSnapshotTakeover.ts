import { claimCustodyScopeLease } from '../../src/profileFencing.ts'

const [directory, scopeId, observedAtMs] = process.argv.slice(2)
if (!directory || !scopeId || !observedAtMs)
  throw new Error('snapshot takeover fixture input missing')
const fence = await claimCustodyScopeLease(directory, {
  scopeId,
  incarnationId: 'snapshot-takeover-owner',
  observedAtMs: Number(observedAtMs),
})
process.stdout.write(JSON.stringify(fence))
