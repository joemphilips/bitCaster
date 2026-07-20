import type { DatabaseSync } from 'node:sqlite'
import {
  acceptConditionalRecoveryNut09Response,
  authorizeConditionalRecoveryAdmission,
  authorizeConditionalRecoveryNut09Request,
  completeConditionalRecoveryKeyset,
  completeConditionalRecoverySession,
  createSeedDerivedConditionalRecoveryPlan,
  fetchConditionalRecoveryNut07CommitAuthority,
  isConditionalRecoveryKeysetRecoverable,
  issueConditionalRecoveryAuthorityObservation,
  issueConditionalRecoveryFreshExpiryEvidence,
  rehydrateConditionalRecoverySessionCapabilities,
  retainExpiredConditionalRecoveryKeyset,
  skipFreshlyIneligibleConditionalRecoveryKeyset,
  validateConditionalRecoveryKeys,
  verifyConditionalRecoveryProofs,
  type CompletedConditionalRecoveryCatalogue,
  type ConditionalRecoveryAuthorityPort,
  type ConditionalRecoveryNut07TransportPort,
  type ConditionalRecoveryNut09TransportPort,
  type ConditionalRecoveryNut13DerivationPort,
  type ConditionalRecoverySessionCapabilities,
  type ConditionalRecoverySessionRehydrationEvidence,
  type ConditionalRecoverySessionCasPort,
  type ConditionalRecoveryWalletScope,
} from '@bitcaster-market/client-sdk/emergencyConditionalSeedRecovery'
import {
  persistConditionalRecoveryKeysResponse,
  readCurrentConditionalRecoveryEvidence,
} from './conditionalSeedRecoverySqlite.ts'

export type ConditionalRecoveryCoordinatorResult =
  | Readonly<{
      kind: 'no-current-session'
    }>
  | Readonly<{
      kind: 'terminal'
      transition: 'recovery-completed' | 'recovery-failed-closed'
    }>
  | Readonly<{
      kind: 'yielded'
      capabilities: ConditionalRecoverySessionCapabilities
    }>

export interface ConditionalRecoveryCoordinatorInput {
  database: DatabaseSync
  recoveryId: string
  walletScope: ConditionalRecoveryWalletScope
  sessionPort: ConditionalRecoverySessionCasPort
  catalogue: CompletedConditionalRecoveryCatalogue
  derivationPort: ConditionalRecoveryNut13DerivationPort
  keysResponse?: unknown
}


export interface ConditionalRecoveryKeysPort {
  fetchKeys(input: {
    walletScope: ConditionalRecoveryWalletScope
    keysetId: string
  }): Promise<{ response: unknown; responseBytes: number }>
}

export interface DriveConditionalRecoveryInput
  extends Omit<ConditionalRecoveryCoordinatorInput, 'keysResponse'> {
  authorityPort: ConditionalRecoveryAuthorityPort
  keysPort: ConditionalRecoveryKeysPort
  nut09Transport: ConditionalRecoveryNut09TransportPort
  nut07Transport: ConditionalRecoveryNut07TransportPort
  batchSize: number
  maxSteps: number
}

export type DrivenConditionalRecoveryResult =
  | Readonly<{ kind: 'terminal'; transition: 'recovery-completed' | 'recovery-failed-closed' }>
  | Readonly<{ kind: 'safely-yielded'; transition: string; steps: number }>
  | Readonly<{ kind: 'no-current-session' }>
/**
 * Reopens exactly one canonical current session and binds every reconstructed
 * capability to the authenticated SQLite port supplied for this profile open.
 * The bounded coordinator yields after rehydration; the caller may invoke only
 * SDK producers exposed by the returned discriminated capabilities.
 */
export async function reopenConditionalSeedRecovery(
  input: ConditionalRecoveryCoordinatorInput,
): Promise<ConditionalRecoveryCoordinatorResult> {
  const persisted = readCurrentConditionalRecoveryEvidence(
    input.database,
    input.recoveryId,
    input.walletScope,
  )
  if (persisted === null) return { kind: 'no-current-session' }
  const { session } = persisted
  if (
    session.transition === 'recovery-completed' ||
    session.transition === 'recovery-failed-closed'
  ) {
    return { kind: 'terminal', transition: session.transition }
  }

  const keysEvidence = input.keysResponse ?? persisted.keysResponse
  let evidence: ConditionalRecoverySessionRehydrationEvidence
  switch (session.transition) {
    case 'completed-catalogue':
    case 'keyset-completed':
    case 'keyset-skipped':
    case 'expired-keyset-retention':
      evidence = { stage: session.transition, catalogue: input.catalogue } as const
      break
    case 'conditional-keys':
    case 'atomic-admission':
      evidence = {
        stage: session.transition,
        catalogue: input.catalogue,
        keysResponse: requireKeysResponse(keysEvidence),
      } as const
      break
    case 'nut13-plan':
      evidence = {
        stage: session.transition,
        catalogue: input.catalogue,
        keysResponse: requireKeysResponse(keysEvidence),
        derivationPort: input.derivationPort,
      } as const
      break
    case 'nut09-request':
      evidence = {
        stage: session.transition,
        catalogue: input.catalogue,
        keysResponse: requireKeysResponse(keysEvidence),
        derivationPort: input.derivationPort,
        requestBytes: requireArtifact(persisted.requestBytes, 'NUT-09 request'),
      } as const
      break
    case 'nut09-response':
    case 'proof-verification':
      evidence = {
        stage: session.transition,
        catalogue: input.catalogue,
        keysResponse: requireKeysResponse(keysEvidence),
        derivationPort: input.derivationPort,
        requestBytes: requireArtifact(persisted.requestBytes, 'NUT-09 request'),
        responseBytes: requireArtifact(persisted.responseBytes, 'NUT-09 response'),
        stagedProofRows: persisted.stagedProofRows,
      } as const
      break
  }

  return {
    kind: 'yielded',
    capabilities: await rehydrateConditionalRecoverySessionCapabilities(
      session,
      evidence,
      input.sessionPort,
    ),
  }
}

/**
 * Drives one canonical session through SDK-owned producers only. Every loop
 * iteration reopens SQLite and rehydrates capabilities, so no process-local
 * predecessor lineage is treated as authority after a committed CAS.
 */
export async function driveConditionalSeedRecovery(
  input: DriveConditionalRecoveryInput,
): Promise<DrivenConditionalRecoveryResult> {
  if (
    !Number.isSafeInteger(input.batchSize) ||
    input.batchSize < 1 ||
    !Number.isSafeInteger(input.maxSteps) ||
    input.maxSteps < 1
  ) {
    throw new Error('conditional recovery coordinator bounds are invalid')
  }
  let keysResponse: unknown
  for (let steps = 0; steps < input.maxSteps; steps += 1) {
    const reopened = await reopenConditionalSeedRecovery({ ...input, keysResponse })
    if (reopened.kind === 'no-current-session') return reopened
    if (reopened.kind === 'terminal') return reopened
    const capabilities = reopened.capabilities
    const { session, catalogue, target, plan, request, proofBatch, verifiedProofs } =
      capabilities
    switch (session.transition) {
      case 'completed-catalogue':
      case 'keyset-completed':
      case 'keyset-skipped': {
        const nextOrdinal =
          session.catalogueOrdinal === null ? 0 : session.catalogueOrdinal + 1
        if (nextOrdinal === catalogue.keysets.length) {
          completeConditionalRecoverySession({
            session,
            sessionPort: input.sessionPort,
            catalogue,
          })
          keysResponse = undefined
          break
        }
        const metadata = catalogue.keysets[nextOrdinal]
        if (metadata === undefined) {
          throw new Error('conditional recovery catalogue ordinal is corrupt')
        }
        const fetched = await input.keysPort.fetchKeys({
          walletScope: input.walletScope,
          keysetId: metadata.id,
        })
        persistConditionalRecoveryKeysResponse({
          database: input.database,
          recoveryId: input.recoveryId,
          walletScope: input.walletScope,
          keysetId: metadata.id,
          response: fetched.response,
        })
        const authority = await issueConditionalRecoveryAuthorityObservation({
          subject: catalogue,
          port: input.authorityPort,
        })
        const selected = validateConditionalRecoveryKeys({
          catalogue,
          walletScope: input.walletScope,
          keysetId: metadata.id,
          response: fetched.response,
          responseBytes: fetched.responseBytes,
          authority,
          session,
        })
        keysResponse = fetched.response
        if ('reason' in selected) {
          skipFreshlyIneligibleConditionalRecoveryKeyset(selected)
          keysResponse = undefined
        }
        break
      }
      case 'conditional-keys':
      case 'atomic-admission': {
        if (target === null) {
          throw new Error('conditional recovery target capability is missing')
        }
        await createSeedDerivedConditionalRecoveryPlan({
          catalogue,
          target,
          walletScope: input.walletScope,
          startCounter: session.scan.nextCounter,
          count: input.batchSize,
          derivationPort: input.derivationPort,
          session,
        })
        break
      }
      case 'nut13-plan': {
        if (target === null || plan === null) {
          throw new Error('conditional recovery plan capability is missing')
        }
        const authority = await issueConditionalRecoveryAuthorityObservation({
          subject: catalogue,
          port: input.authorityPort,
        })
        await authorizeConditionalRecoveryNut09Request({
          catalogue,
          target,
          plan,
          walletScope: input.walletScope,
          authority,
        })
        break
      }
      case 'nut09-request': {
        if (request === null) {
          throw new Error('conditional recovery request capability is missing')
        }
        const authority = await issueConditionalRecoveryAuthorityObservation({
          subject: catalogue,
          port: input.authorityPort,
        })
        await acceptConditionalRecoveryNut09Response({
          request,
          transport: input.nut09Transport,
          authority,
        })
        break
      }
      case 'nut09-response': {
        if (target === null || proofBatch === null) {
          throw new Error('conditional recovery response capability is missing')
        }
        if (proofBatch.proofCount === 0) {
          if (session.scan.consecutiveEmptyOutputs >= input.batchSize) {
            completeConditionalRecoveryKeyset({
              session,
              sessionPort: input.sessionPort,
              gapLimit: input.batchSize,
              evidenceDigest: session.evidenceDigest,
            })
          } else {
            await createSeedDerivedConditionalRecoveryPlan({
              catalogue,
              target,
              walletScope: input.walletScope,
              startCounter: session.scan.nextCounter,
              count: input.batchSize,
              derivationPort: input.derivationPort,
              session,
            })
          }
          break
        }
        const decision = await issueConditionalRecoveryAuthorityObservation({
          subject: catalogue,
          port: input.authorityPort,
        })
        const expired = !isConditionalRecoveryKeysetRecoverable(
          target.metadata,
          decision.effectiveTime,
        )
        const expiryEvidence = expired
          ? issueConditionalRecoveryFreshExpiryEvidence({
              catalogue,
              target,
              authority: decision,
            })
          : undefined
        const verificationAuthority = expired
          ? await issueConditionalRecoveryAuthorityObservation({
              subject: catalogue,
              port: input.authorityPort,
            })
          : decision
        verifyConditionalRecoveryProofs({
          catalogue,
          target,
          walletScope: input.walletScope,
          proofBatch,
          authority: verificationAuthority,
          expiryEvidence,
        })
        break
      }
      case 'proof-verification': {
        if (
          target === null ||
          proofBatch === null ||
          verifiedProofs === null
        ) {
          throw new Error('conditional recovery verified capability is missing')
        }
        const nut07Authority =
          await fetchConditionalRecoveryNut07CommitAuthority({
            catalogue,
            target,
            walletScope: input.walletScope,
            proofBatch,
            transport: input.nut07Transport,
          })
        const decision = await issueConditionalRecoveryAuthorityObservation({
          subject: catalogue,
          port: input.authorityPort,
        })
        if (
          isConditionalRecoveryKeysetRecoverable(
            target.metadata,
            decision.effectiveTime,
          )
        ) {
          authorizeConditionalRecoveryAdmission({
            catalogue,
            target,
            verifiedProofs,
            nut07Authority,
            walletScope: input.walletScope,
            proofs: proofBatch.proofs,
            authority: decision,
            admissionPort: input.sessionPort,
          })
        } else {
          const expiryAuthority = issueConditionalRecoveryFreshExpiryEvidence({
            catalogue,
            target,
            authority: decision,
          })
          retainExpiredConditionalRecoveryKeyset({
            catalogue,
            target,
            verifiedProofs,
            nut07Authority,
            walletScope: input.walletScope,
            proofs: proofBatch.proofs,
            expiryAuthority,
            sessionPort: input.sessionPort,
          })
        }
        break
      }
      case 'expired-keyset-retention':
        completeConditionalRecoveryKeyset({
          session,
          sessionPort: input.sessionPort,
          evidenceDigest: session.evidenceDigest,
        })
        keysResponse = undefined
        break
    }
  }
  const current = readCurrentConditionalRecoveryEvidence(
    input.database,
    input.recoveryId,
    input.walletScope,
  )
  if (current === null) return { kind: 'no-current-session' }
  return {
    kind: 'safely-yielded',
    transition: current.session.transition,
    steps: input.maxSteps,
  }
}

export function conditionalRecoveryFundedWorkAllowed(
  result: DrivenConditionalRecoveryResult,
): boolean {
  return (
    result.kind === 'no-current-session' ||
    (result.kind === 'terminal' && result.transition === 'recovery-completed')
  )
}


function requireKeysResponse(value: unknown): unknown {
  if (value === undefined) {
    throw new Error('conditional recovery current stage requires key evidence')
  }
  return value
}

function requireArtifact(value: Uint8Array | null, label: string): Uint8Array {
  if (value === null) {
    throw new Error(`conditional recovery current stage requires ${label}`)
  }
  return value
}
