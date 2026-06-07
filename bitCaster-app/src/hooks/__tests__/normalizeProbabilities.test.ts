import { describe, it, expect, vi } from 'vitest'
import type { WizardOutcome } from '@/types/market-creation'

// Mock transitive dependencies that useMarketCreationState imports
vi.mock('@/lib/oracle', () => ({ fetchOracleAnnouncements: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/markets', () => ({
  registerCondition: vi.fn(),
  requiredMarketCreationOutcomeCollections: vi.fn(),
  uploadThumbnail: vi.fn(),
  registerLiquidity: vi.fn(),
}))
// The real `@/stores/wallet` transitively imports `@cashu/cashu-ts`, which
// fails to load cleanly under Vitest's ESM resolver. This test only exercises
// the pure `normalizeProbabilities` helper, so a bare stub is sufficient.
vi.mock('@/stores/wallet', () => ({
  useWalletStore: { getState: () => ({ mnemonic: null }) },
}))
vi.mock('@/lib/nip17', () => ({
  deriveNostrKeyPair: () => ({
    privateKeyHex: '00'.repeat(32),
    publicKey: '11'.repeat(32),
  }),
}))

// Must import after mocks are declared
const { normalizeProbabilities } = await import('../useMarketCreationState')

function makeOutcomes(probabilities: number[]): WizardOutcome[] {
  return probabilities.map((p, i) => ({
    id: `o${i}`,
    label: `Outcome ${i}`,
    description: '',
    probability: p,
  }))
}

function sumProbabilities(outcomes: WizardOutcome[]): number {
  return outcomes.reduce((sum, o) => sum + (o.probability ?? 0), 0)
}

describe('normalizeProbabilities', () => {
  it('keeps two equal values at [50, 50]', () => {
    const result = normalizeProbabilities(makeOutcomes([50, 50]))
    expect(result.map((o) => o.probability)).toEqual([50, 50])
    expect(sumProbabilities(result)).toBe(100)
  })

  it('normalizes three equal values to sum exactly 100', () => {
    const result = normalizeProbabilities(makeOutcomes([33, 33, 33]))
    expect(sumProbabilities(result)).toBe(100)
    // Each should be 33 or 34
    for (const o of result) {
      expect(o.probability).toBeGreaterThanOrEqual(33)
      expect(o.probability).toBeLessThanOrEqual(34)
    }
  })

  it('returns outcomes unchanged when all probabilities are zero', () => {
    const input = makeOutcomes([0, 0, 0])
    const result = normalizeProbabilities(input)
    expect(result.map((o) => o.probability)).toEqual([0, 0, 0])
  })

  it('handles single non-zero with others at zero', () => {
    const result = normalizeProbabilities(makeOutcomes([100, 0, 0]))
    expect(result.map((o) => o.probability)).toEqual([100, 0, 0])
    expect(sumProbabilities(result)).toBe(100)
  })

  it('keeps values already summing to 100 unchanged', () => {
    const result = normalizeProbabilities(makeOutcomes([75, 25]))
    expect(result.map((o) => o.probability)).toEqual([75, 25])
  })

  it('normalizes small equal values to sum exactly 100', () => {
    const result = normalizeProbabilities(makeOutcomes([1, 1, 1]))
    expect(sumProbabilities(result)).toBe(100)
  })

  it('normalizes mixed values proportionally to sum 100', () => {
    const result = normalizeProbabilities(makeOutcomes([10, 20, 30]))
    expect(sumProbabilities(result)).toBe(100)
    // 10/60*100=16.67, 20/60*100=33.33, 30/60*100=50
    expect(result[0].probability).toBeGreaterThanOrEqual(16)
    expect(result[0].probability).toBeLessThanOrEqual(17)
    expect(result[2].probability).toBe(50)
  })

  it('handles five outcomes summing to exactly 100', () => {
    const result = normalizeProbabilities(makeOutcomes([10, 10, 10, 10, 10]))
    expect(sumProbabilities(result)).toBe(100)
    expect(result.map((o) => o.probability)).toEqual([20, 20, 20, 20, 20])
  })

  it('handles undefined probabilities as zero', () => {
    const outcomes: WizardOutcome[] = [
      { id: 'a', label: 'A', description: '', probability: undefined },
      { id: 'b', label: 'B', description: '', probability: 50 },
    ]
    const result = normalizeProbabilities(outcomes)
    expect(sumProbabilities(result)).toBe(100)
    expect(result[0].probability).toBe(0)
    expect(result[1].probability).toBe(100)
  })

  it('preserves non-probability fields', () => {
    const outcomes: WizardOutcome[] = [
      { id: 'yes', label: 'Yes', description: 'desc-yes', probability: 60 },
      { id: 'no', label: 'No', description: 'desc-no', probability: 40 },
    ]
    const result = normalizeProbabilities(outcomes)
    expect(result[0].id).toBe('yes')
    expect(result[0].label).toBe('Yes')
    expect(result[0].description).toBe('desc-yes')
  })
})
