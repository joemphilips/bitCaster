import {
  bindRangePreparationCapability,
  encodeCanonicalRangePreparation,
  insertRangePreparation,
  transitionRangePreparation,
} from '../../src/ctfRangeOrderJournalSqlite.ts'
import { withDaemonStateSqliteTransaction } from '../../src/stateSqlite.ts'

export async function retainNativeOrderLink(
  directory: string,
  scopeId: string,
  orderId: string,
  marketId: string,
  clientOrderId: string,
  terminal = false,
): Promise<void> {
  await withDaemonStateSqliteTransaction(directory, (database) => {
    const rangeOperationId = `range:${clientOrderId}`
    insertRangePreparation(database, {
      scopeId,
      rangeOperationId,
      sourceOperationId: `source:${clientOrderId}`,
      authorizationId: `authorization:${clientOrderId}`,
      clientOrderId,
      orderRouteId: marketId,
      normalizedMint: 'https://mint.example',
      conditionId: marketId.slice(0, marketId.lastIndexOf('-')),
      unit: 'msat',
      tokenSide: 'Outcome',
      side: 'Buy',
      priceSubunits: 500,
      amountSubunits: 1_000,
      minimumFillAmountSubunits: 1_000,
      consolidateProofs: false,
      divisibility: 1_000,
      authorizationExpiresAtUnixSeconds: 2_000_000_000,
      preparationBytes: encodeCanonicalRangePreparation({ rangeOperationId }),
      feeConsentBytes: null,
      createdAtMs: 1,
    })
    transitionRangePreparation(database, {
      scopeId,
      rangeOperationId,
      expectedRevision: 0,
      from: 'prepared',
      to: 'capability-requested',
      updatedAtMs: 2,
    })
    bindRangePreparationCapability(database, {
      scopeId,
      rangeOperationId,
      expectedRevision: 1,
      updatedAtMs: 3,
      capability: {
        artifactId: '11111111-1111-4111-8111-111111111111',
        bindingDigest: '22'.repeat(32),
        artifactDigest: '33'.repeat(32),
        orderId,
      },
    })
    if (terminal)
      transitionRangePreparation(database, {
        scopeId,
        rangeOperationId,
        expectedRevision: 2,
        from: 'capability-bound',
        to: 'terminal',
        updatedAtMs: 4,
      })
  })
}
