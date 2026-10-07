import { readFileSync } from 'node:fs'
import { deriveConditionalKeysetId } from '@cashu/cashu-ts'
import {
  bindRegisteredDlcConditionAuthority,
  requireVerifiedConditionOracleEvidence,
} from '../../src/conditionOracleEvidence.ts'
import { prepareDlcConditionResolutionEvidence } from '../../src/managedConditionInventory.ts'
import { deriveDurableCustodyScopeId } from '../../src/durableCustody.ts'

const registration = JSON.parse(
  readFileSync(new URL('../fixtures/d4/registered-authority.json', import.meta.url), 'utf8'),
)
const info = JSON.parse(
  readFileSync(new URL('../fixtures/d4/condition-info.json', import.meta.url), 'utf8'),
)
export const D4_CONDITION = registration.conditionId as string
export const D4_COLLECTION_ID = 'ed848394ad54a8c03f7de381c5b75fe2aca450a6a822b00838939a5e19861f04'
export function d4OracleContext(
  unit: 'sat' | 'msat' = 'sat',
  normalizedMint = 'https://mint.example',
) {
  const binding = {
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'condition-inventory',
      conditionId: D4_CONDITION,
      inventoryAccountId: 'd4-tests',
      normalizedMint,
      unit,
    }),
    normalizedMint,
    unit,
    conditionId: D4_CONDITION,
    canonicalParentCollectionId: null,
  }
  return requireVerifiedConditionOracleEvidence({
    registered: bindRegisteredDlcConditionAuthority(binding, registration),
    evidence: prepareDlcConditionResolutionEvidence('YES', {
      oracle_sigs: info.attestation.oracle_sigs,
    }).evidence,
  }).context
}
export function d4ConditionalKeyset(
  keys: Readonly<Record<string, string>>,
  unit: 'sat' | 'msat' = 'sat',
  normalizedMint = 'https://mint.example',
) {
  return {
    canonicalMintUrl: normalizedMint,
    id: deriveConditionalKeysetId({
      keys: { ...keys },
      unit,
      conditionId: D4_CONDITION,
      outcomeCollectionId: D4_COLLECTION_ID,
    }),
    unit,
    keys,
    inputFeePpk: 0,
    finalExpiry: null,
    identity: {
      kind: 'conditional' as const,
      conditionId: D4_CONDITION,
      outcomeCollection: 'NO',
      outcomeCollectionId: D4_COLLECTION_ID,
    },
  }
}
