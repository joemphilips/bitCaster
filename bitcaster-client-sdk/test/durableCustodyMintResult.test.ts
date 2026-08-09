import assert from 'node:assert/strict'
import test from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  OutputData,
  MintOperationError,
  createBlindSignature,
  createBlindSignatureBls,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
  pointFromHexG1,
  type Proof,
  type MintKeys,
} from '@cashu/cashu-ts'
import {
  applyDurableCustodyTransaction,
  isDurableCustodyProofReservationActive,
  deriveDurableCustodyScopeId,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyScopeState,
} from '../src/durableCustody.ts'
import {
  prepareDurableCustodyAuthenticatedTerminalMintRejection,
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  readDurableCustodyVerifiedMintResult,
  reconcileDurableCustodyAuthenticatedTerminalMintRejection,
  stageDurableCustodyPreparedMintResult,
} from '../src/durableCustodyMintResult.ts'
import { serializeDurableCustodyOutput } from '../src/durableCustodyProofOperation.ts'
import {
  redeemOutcomeLegWithOperation,
  type AuthenticatedCtfRedeemTerminalEvidence,
} from '../src/ctfRedeem.ts'
import type {
  CtfPrepareProofOperationInput,
  CtfProofOperationCompletion,
  CtfProofOperationRecord,
  CtfProofOperationStore,
} from '../src/ctfSplit.ts'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from '../src/durableCustodyProofOperationRecord.ts'
import { FaultInjectingDurableCustodyAdapter } from './support/faultInjectingDurableCustodyAdapter.ts'

const MINT_URL = 'https://mint.example'
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEYS = { '1': bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) }
const KEYSET_ID = deriveKeysetId(KEYS)
const BLS_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 2])
const BLS_KEYS = {
  '1': bytesToHex(bls12_381.G2.Point.BASE.multiply(2n).toBytes(true)),
}
const BLS_KEYSET_ID = deriveKeysetId(BLS_KEYS, { versionByte: 2, unit: 'sat' })
const scopeInput = {
  scopeKind: 'condition-inventory' as const,
  conditionId: 'condition-1',
  inventoryAccountId: 'condition:condition-1',
  normalizedMint: MINT_URL,
  unit: 'sat' as const,
}
const SCOPE = { ...scopeInput, scopeId: deriveDurableCustodyScopeId(scopeInput) }
const OWNER: DurableCustodyOwnerAuthorization = {
  incarnationId: 'wallet-service-1',
  fencingEpoch: 1,
  observedAtMs: 10,
}

test('binds, verifies, stages, and restores exact persisted output proofs', () => {
  const prepared = preparedSend('send:1')
  const adapter = new FaultInjectingDurableCustodyAdapter(scopeState())
  adapter.run((transaction) =>
    bindDurableCustodyProofOperation(transaction, prepared.record, prepared.artifacts),
  )
  const record = adapter.readOperation()!
  const result = prepareDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: prepared.exactAuthority,
    result: { keep: [proofForOutput(prepared.output)] },
  })
  adapter.run((transaction) =>
    stageDurableCustodyPreparedMintResult({
      transaction,
      record,
      prepared: result,
      authorization: OWNER,
    }),
  )
  const staged = adapter.readOperation()!
  const persisted = adapter
    .readArtifacts()
    .find(
      ({ reference }) => reference.artifactId === staged.operation.result.exactResult!.artifactId,
    )!
  const recovered = readDurableCustodyVerifiedMintResult({
    record: staged,
    exactAuthority: prepared.exactAuthority,
    exactResult: persisted.artifact,
  })

  assert.equal(result.proofs[0]!.dleqState, 'verified')
  assert.deepEqual(recovered.selectedSuccessorProofIds, result.selectedSuccessorProofIds)
  assert.equal(recovered.resultFingerprint, result.resultFingerprint)
})

test('rejects a foreign output, absent DLEQ, and a changed authority', () => {
  const prepared = preparedSend('send:2')
  const foreign = OutputData.createSingleData(1, KEYSET_ID, 'foreign-secret', 13n)
  assert.throws(
    () =>
      prepareDurableCustodyVerifiedMintResult({
        record: prepared.record,
        exactAuthority: prepared.exactAuthority,
        result: { keep: [proofForOutput(foreign)] },
      }),
    /differs from its persisted output/,
  )

  const withoutDleq = { ...proofForOutput(prepared.output), dleq: undefined }
  assert.throws(
    () =>
      prepareDurableCustodyVerifiedMintResult({
        record: prepared.record,
        exactAuthority: prepared.exactAuthority,
        result: { keep: [withoutDleq] },
      }),
    /differs from its persisted output/,
  )

  const foreignEphemeralKey = {
    ...proofForOutput(prepared.output),
    p2pk_e: `02${'3'.repeat(64)}`,
  }
  assert.throws(
    () =>
      prepareDurableCustodyVerifiedMintResult({
        record: prepared.record,
        exactAuthority: prepared.exactAuthority,
        result: { keep: [foreignEphemeralKey] },
      }),
    /differs from its persisted output/,
  )

  const changed = prepareDurableCustodyMintOperationAuthority({
    operation: { ...prepared.operation, operationId: 'foreign-operation' },
    keysets: prepared.authority.keysets,
  })
  assert.throws(
    () =>
      prepareDurableCustodyVerifiedMintResult({
        record: prepared.record,
        exactAuthority: changed.exactAuthority,
        result: { keep: [proofForOutput(prepared.output)] },
      }),
    /artifact does not match its exact reference/,
  )
})

test('requires the exact input and output keyset authority', () => {
  const prepared = preparedSend('send:3')
  assert.throws(
    () =>
      prepareDurableCustodyMintOperationAuthority({
        operation: prepared.operation,
        keysets: [],
      }),
    /keyset authority is incomplete/,
  )
  assert.throws(
    () =>
      prepareDurableCustodyMintOperationAuthority({
        operation: prepared.operation,
        keysets: [{ ...prepared.authority.keysets[0]!, keys: { '1': `02${'1'.repeat(64)}` } }],
      }),
    /keyset identity is invalid/,
  )
})

test('accepts an exact CTF range refund as a mint-verified operation', () => {
  const prepared = preparedSend('refund:1')
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation: { ...prepared.operation, kind: 'ctf-range-refund' },
    keysets: prepared.authority.keysets,
  })

  assert.equal(authority.authority.operation.kind, 'ctf-range-refund')
  assert.equal(authority.facts.binding.stage, 'refund')
})

test('accepts and verifies an exact CTF split operation', () => {
  const send = preparedSend('ctf-split:1')
  const operation = { ...send.operation, kind: 'ctf-split' as const }
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation,
    keysets: send.authority.keysets,
  })
  const record = createDurableCustodyProofOperation({
    scope: SCOPE,
    operation,
    facts: authority.facts,
    inventoryAccountId: SCOPE.inventoryAccountId,
    exactBoundary: {
      method: 'POST',
      path: '/v1/ctf/convert',
      idempotencyKey: operation.operationId,
      requestBody: authority.exactRequest,
      output: authority.exactOutput,
      privateMaterial: authority.exactAuthority,
    },
  })
  const result = prepareDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: authority.exactAuthority,
    result: { keep: [proofForOutput(send.output)] },
  })

  assert.equal(authority.facts.binding.stage, 'ctf-split')
  assert.equal(result.proofs.length, 1)
})

test('reconciles exact authenticated CTF redeem rejection without successors', async () => {
  const prepared = preparedCtfRedeem('redeem:losing')
  const adapter = new FaultInjectingDurableCustodyAdapter(scopeState())
  adapter.run((transaction) =>
    bindDurableCustodyProofOperation(transaction, prepared.record, prepared.artifacts),
  )
  const rejection = prepareDurableCustodyAuthenticatedTerminalMintRejection({
    record: adapter.readOperation()!,
    exactAuthority: prepared.exactAuthority,
    evidence: await captureTerminalRedeemEvidence(prepared.operation.operationId, MINT_URL),
  })
  adapter.run((transaction) =>
    applyDurableCustodyTransaction(
      transaction,
      {
        scope: SCOPE,
        owner: OWNER,
        operationRows: [
          {
            operationId: prepared.record.operation.operationId,
            expectedRevision: adapter.readOperation()!.revision,
          },
        ],
      },
      (selected) =>
        reconcileDurableCustodyAuthenticatedTerminalMintRejection({
          transaction: selected,
          record: adapter.readOperation()!,
          prepared: rejection,
          authorization: OWNER,
        }),
    ),
  )
  const terminal = adapter.readOperation()!

  assert.equal(terminal.operation.state, 'aborted')
  assert.equal(terminal.operation.result.state, 'none')
  assert.equal(terminal.operation.terminalMintRejection?.code, 13015)
  assert.equal(terminal.operation.terminalMintRejection?.predecessorDisposition, 'retain')
  assert.equal(rejection.authority.predecessorDisposition, 'retain')
  assert.deepEqual(terminal.operation.terminalMintRejection?.selectedSuccessorProofIds, [])
  assert.equal(terminal.operation.proofStorage.lineage.successorAdmission, null)
  assert.equal(isDurableCustodyProofReservationActive(terminal), false)

  const revision = terminal.revision
  adapter.run((transaction) =>
    reconcileDurableCustodyAuthenticatedTerminalMintRejection({
      transaction,
      record: terminal,
      prepared: rejection,
      authorization: OWNER,
    }),
  )
  assert.equal(adapter.readOperation()?.revision, revision)
})

test('rejects foreign terminal mint rejections and leaves unknown failures active', async () => {
  const redeem = preparedCtfRedeem('redeem:strict')
  const send = preparedSend('send:not-redeem')
  const evidence = await captureTerminalRedeemEvidence(redeem.operation.operationId, MINT_URL)
  const sendEvidence = await captureTerminalRedeemEvidence('redeem:foreign', MINT_URL)
  const foreignMintEvidence = await captureTerminalRedeemEvidence(
    redeem.operation.operationId,
    'https://foreign-mint.example',
  )
  assert.throws(
    () =>
      prepareDurableCustodyAuthenticatedTerminalMintRejection({
        record: redeem.record,
        exactAuthority: redeem.exactAuthority,
        evidence: {
          transportProvenance: 'authenticated-mint-transport',
          rejectionBody: { code: 13014 },
        } as unknown as AuthenticatedCtfRedeemTerminalEvidence,
      }),
    /terminal evidence is invalid/,
  )
  assert.throws(
    () =>
      prepareDurableCustodyAuthenticatedTerminalMintRejection({
        record: redeem.record,
        exactAuthority: redeem.exactAuthority,
        evidence: new Error(
          'transport failed',
        ) as unknown as AuthenticatedCtfRedeemTerminalEvidence,
      }),
    /terminal evidence is invalid/,
  )
  assert.throws(
    () =>
      prepareDurableCustodyAuthenticatedTerminalMintRejection({
        record: send.record,
        exactAuthority: send.exactAuthority,
        evidence,
      }),
    /only valid for CTF redeem/,
  )
  assert.throws(
    () =>
      prepareDurableCustodyAuthenticatedTerminalMintRejection({
        record: redeem.record,
        exactAuthority: redeem.exactAuthority,
        evidence: sendEvidence,
      }),
    /transport authority is foreign/,
  )
  assert.throws(
    () =>
      prepareDurableCustodyAuthenticatedTerminalMintRejection({
        record: redeem.record,
        exactAuthority: redeem.exactAuthority,
        evidence: foreignMintEvidence,
      }),
    /transport authority is foreign/,
  )
  assert.equal(redeem.record.operation.state, 'dispatch-intent')
  assert.equal(isDurableCustodyProofReservationActive(redeem.record), true)
})

test('accepts and verifies an exact wallet receive operation', () => {
  const send = preparedSend('receive:1')
  const operation = { ...send.operation, kind: 'wallet-receive' as const }
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation,
    keysets: send.authority.keysets,
  })
  const record = createDurableCustodyProofOperation({
    scope: SCOPE,
    operation,
    facts: authority.facts,
    inventoryAccountId: SCOPE.inventoryAccountId,
    exactBoundary: {
      method: 'POST',
      path: '/v1/swap',
      idempotencyKey: operation.operationId,
      requestBody: authority.exactRequest,
      output: authority.exactOutput,
      privateMaterial: authority.exactAuthority,
    },
  })
  const result = prepareDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: authority.exactAuthority,
    result: { keep: [proofForOutput(send.output)] },
  })

  assert.equal(authority.authority.operation.kind, 'wallet-receive')
  assert.equal(authority.facts.binding.stage, 'receive')
  assert.equal(result.proofs.length, 1)
})

test('verifies an exact persisted BLS output without secp DLEQ material', () => {
  const prepared = preparedSend('send:bls', {
    id: BLS_KEYSET_ID,
    keys: BLS_KEYS,
    proof: proofForBlsOutput,
  })
  const result = prepareDurableCustodyVerifiedMintResult({
    record: prepared.record,
    exactAuthority: prepared.exactAuthority,
    result: { keep: [proofForBlsOutput(prepared.output)] },
  })

  assert.equal(result.proofs[0]!.dleqState, 'not-present')
})

function preparedSend(
  operationId: string,
  fixture: { id: string; keys: Record<string, string>; proof: (output: OutputData) => Proof } = {
    id: KEYSET_ID,
    keys: KEYS,
    proof: proofForOutput,
  },
) {
  const input = OutputData.createSingleData(1, fixture.id, `input:${operationId}`, 7n)
  const output = OutputData.createSingleData(1, fixture.id, `output:${operationId}`, 11n)
  const operation = {
    operationId,
    kind: 'wallet-send' as const,
    mintUrl: MINT_URL,
    inputs: [fixture.proof(input)],
    outputs: { keep: [serializeDurableCustodyOutput(output)] },
    metadata: { unit: 'sat' },
  }
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation,
    keysets: [
      {
        canonicalMintUrl: MINT_URL,
        id: fixture.id,
        unit: 'sat',
        keys: fixture.keys,
        inputFeePpk: 0,
        finalExpiry: null,
        identity: { kind: 'regular' },
      },
    ],
  })
  const artifacts = {
    requestBody: authority.exactRequest,
    output: authority.exactOutput,
    privateMaterial: authority.exactAuthority,
  }
  const record = createDurableCustodyProofOperation({
    scope: SCOPE,
    operation,
    facts: authority.facts,
    inventoryAccountId: SCOPE.inventoryAccountId,
    exactBoundary: {
      method: 'POST',
      path: '/v1/swap',
      idempotencyKey: operationId,
      ...artifacts,
    },
  })
  return { ...authority, artifacts, record, operation, output }
}

function preparedCtfRedeem(operationId: string) {
  const send = preparedSend(operationId)
  const operation = { ...send.operation, kind: 'ctf-redeem' as const }
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation,
    keysets: send.authority.keysets,
  })
  const artifacts = {
    requestBody: authority.exactRequest,
    output: authority.exactOutput,
    privateMaterial: authority.exactAuthority,
  }
  const record = createDurableCustodyProofOperation({
    scope: SCOPE,
    operation,
    facts: authority.facts,
    inventoryAccountId: SCOPE.inventoryAccountId,
    exactBoundary: {
      method: 'POST',
      path: '/v1/ctf/redeem',
      idempotencyKey: operationId,
      ...artifacts,
    },
  })
  return { ...authority, artifacts, operation, record }
}

async function captureTerminalRedeemEvidence(
  operationId: string,
  mintUrl: string,
): Promise<AuthenticatedCtfRedeemTerminalEvidence> {
  let record: CtfProofOperationRecord | null = null
  let evidence: AuthenticatedCtfRedeemTerminalEvidence | null = null
  const store: CtfProofOperationStore = {
    getProofOperation: async () => record,
    prepareProofOperation: async (input: CtfPrepareProofOperationInput) => {
      record = { ...input, state: 'prepared', createdAt: 1, updatedAt: 1 }
      return record
    },
    markProofOperationCompleted: async (
      _operationId: string,
      _completion: CtfProofOperationCompletion,
    ) => {
      throw new Error('terminal rejection must not complete the operation')
    },
    markProofOperationFailed: async (_operationId, _message, terminalEvidence) => {
      evidence = terminalEvidence
      record = { ...record!, state: 'Failed', failureCode: 13015, updatedAt: 2 }
      return record
    },
  }
  const regularKeyset: MintKeys = {
    id: KEYSET_ID,
    unit: 'sat',
    active: true,
    input_fee_ppk: 0,
    keys: KEYS,
  }
  await redeemOutcomeLegWithOperation({
    mintUrl,
    operationId,
    wallet: {
      loadMint: async () => undefined,
      redeemOutcomeProofs: async () => {
        throw new MintOperationError(13015, 'oracle not attested')
      },
    },
    proofOperationStore: store,
    conditionId: 'condition-1',
    outcome: 'losing-outcome',
    unit: 'sat',
    oracleWitness: '{}',
    proofs: [proofForOutput(OutputData.createSingleData(1, KEYSET_ID, 'capture-input', 17n))],
    outcomeKeyset: regularKeyset,
    regularKeyset,
  })
  if (evidence === null) throw new Error('terminal redeem evidence was not captured')
  return evidence
}

function proofForBlsOutput(output: OutputData): Proof {
  const signature = createBlindSignatureBls(
    pointFromHexG1(output.blindedMessage.B_),
    BLS_PRIVATE_KEY,
    BLS_KEYSET_ID,
  )
  return output.toProof(
    {
      id: BLS_KEYSET_ID,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
    },
    { id: BLS_KEYSET_ID, keys: BLS_KEYS },
  )
}

function proofForOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    KEYSET_ID,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY)
  return output.toProof(
    {
      id: KEYSET_ID,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: KEYSET_ID, keys: KEYS },
  )
}

function scopeState(): DurableCustodyScopeState {
  return {
    schemaVersion: 1,
    scope: SCOPE,
    fencingEpoch: OWNER.fencingEpoch,
    owner: { incarnationId: OWNER.incarnationId, leaseExpiresAtMs: 1_000 },
    effectiveClock: { highWaterMarkMs: 0 },
  }
}
