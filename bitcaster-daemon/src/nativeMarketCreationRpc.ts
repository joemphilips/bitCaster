import { createHash } from 'node:crypto'
import {
  MAX_CONDITION_REGISTRATION_FEE_SUBUNITS,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  normalizeMarketCreationInput,
  parseCtfSettingsFromMintInfo,
  readPublicMintMetadata,
  registrationFeeForPolicy,
  requiredMarketCreationOutcomeCollections,
  validateMarketCreateEngineUrl,
} from '@bitcaster-market/client-sdk'
import { createAuthenticatedBitcasterEngineClient } from './engineClient.ts'
import { DaemonDurableOutgoingCashuCoordinator } from './durableOutgoingCashuCoordinator.ts'
import { publishNativeOracleBackup } from './nativeOracleBackup.ts'
import { publishNativeOracleBackupEvent } from './nativeOracleBackupRelay.ts'
import { completeNativeMarketCreation } from './nativeMarketCreation.ts'
import {
  createNativeOracleCreationStore,
  NativeOracleSignerUnavailableError,
} from './nativeOracleCreationStore.ts'
import { NativeOracleSignerRequiredError } from './nativeMarketOracle.ts'
import { createNativeOracleHelperAdapter } from './nativeOracleHelper.ts'
import { normalizeOracleRelayUrls } from './nativeOraclePublication.ts'
import type { NativeMarketCreationInput } from './nativeMarketOracle.ts'
import { readMarketThumbnail } from './marketThumbnail.ts'
import { profileDir, readProfile } from './profile.ts'
import { readSecrets, readSelectedDaemonSigner } from './secrets.ts'
import { createWallet, type WalletOpsDependencies } from './walletOps.ts'
import type { DaemonCommand, DaemonResponse } from './protocol.ts'

type CreationCommand = Extract<
  DaemonCommand,
  {
    method:
      | 'market.create-native'
      | 'market.creation-resume'
      | 'market.creation-status'
      | 'market.creation-quote'
  }
>

export async function dispatchNativeMarketCreation(
  command: CreationCommand,
  deps: WalletOpsDependencies,
): Promise<DaemonResponse> {
  try {
    return await runNativeMarketCreationCommand(command, deps)
  } catch (error) {
    if (
      error instanceof NativeOracleSignerRequiredError ||
      error instanceof NativeOracleSignerUnavailableError
    )
      return { ok: false, code: 'oracle-signer-required', error: error.message }
    // Mint errors can echo submitted fee proofs. Do not forward raw downstream error text.
    return {
      ok: false,
      code: 'market-creation-incomplete',
      error:
        'Market creation did not complete. Check creation-status and retry the same creation ID. Use creation-quote before approving a registration fee.',
    }
  }
}

async function runNativeMarketCreationCommand(
  command: CreationCommand,
  deps: WalletOpsDependencies,
): Promise<DaemonResponse> {
  const profile = await readProfile()
  const secrets = await readSecrets()
  if (!profile || !secrets) return { ok: false, error: 'daemon profile is not initialized' }
  let store: ReturnType<typeof createNativeOracleCreationStore> | undefined
  const getStore = () => (store ??= createNativeOracleCreationStore(profileDir()))
  if (command.method === 'market.creation-status') {
    const record = await getStore().readCreation(command.params.creationId)
    return {
      ok: true,
      result:
        record === null
          ? null
          : {
              creationId: record.creationId,
              eventId: record.eventId,
              conditionId: record.announcement?.conditionId ?? null,
              announcementPrepared: record.announcement !== null,
              chosenOutcome: record.chosenOutcome,
              attestationPrepared: record.attestation !== null,
              relayPublished: record.relayPublished,
              engineSynchronized: record.engineEvidence !== null,
              explanationPrepared: record.explanationEventJson !== null,
              explanationDraftSaved: record.explanationDraft !== null,
              explanationRelayPublished: record.explanationRelayPublished,
              mintRegistered: record.marketCreation?.mintConfirmed ?? false,
              engineRegistered: record.marketCreation?.engineResult != null,
            },
    }
  }
  const selectedSigner = await readSelectedDaemonSigner()
  if (!selectedSigner.enabled && command.method === 'market.create-native')
    return { ok: false, error: 'Application signer is disconnected.' }
  const validation = validateMarketCreateEngineUrl(profile.engineBaseUrl, true)
  if (!validation.ok) return { ok: false, error: validation.error, code: validation.code }
  if (!deps.getCustodyFence)
    return { ok: false, error: 'Market creation requires custody authority.' }
  const getCustodyFence = deps.getCustodyFence
  let coordinator: DaemonDurableOutgoingCashuCoordinator | undefined
  const payment = {
    get coordinator() {
      return (coordinator ??= new DaemonDurableOutgoingCashuCoordinator(
        profileDir(),
        getCustodyFence,
        deps,
      ))
    },
  }
  if (command.method === 'market.creation-quote') {
    const registration = await readRegistrationPolicy(profile.mintUrl, command.params.outcomes)
    if (registration.requiredFeeMsat === 0)
      return {
        ok: true,
        result: {
          requiredFeeMsat: 0,
          sendPreparationFeeMsat: 0,
          totalWalletDebitMsat: 0,
        },
      }
    const wallet = createWallet(profile.mintUrl, secrets, deps, 'sat', 'msat')
    await wallet.loadMint()
    const quote = await payment.coordinator.quoteSend({
      amountMsat: registration.requiredFeeMsat,
      mintUrl: profile.mintUrl,
      wallet,
    })
    return { ok: true, result: { requiredFeeMsat: registration.requiredFeeMsat, ...quote } }
  }
  let thumbnail =
    command.params.thumbnailPath === undefined
      ? undefined
      : await readMarketThumbnail(command.params.thumbnailPath)
  let input: NativeMarketCreationInput
  if (command.method === 'market.creation-resume') {
    const record = await getStore().readCreation(command.params.creationId)
    if (record === null) return { ok: false, error: 'Native market creation was not found.' }
    thumbnail ??= record.marketCreation?.thumbnail ?? undefined
    input = {
      ...JSON.parse(record.canonicalInput),
      creationId: record.creationId,
      eventId: record.eventId,
    }
    if (
      input.destination.engineBaseUrl !== profile.engineBaseUrl ||
      input.destination.mintUrl !== profile.mintUrl
    ) {
      return { ok: false, error: 'Resume requires the original engine and mint configuration.' }
    }
  } else {
    const normalized = normalizeMarketCreationInput(command.params.market)
    const saved = await getStore().readCreation(command.params.creationId)
    thumbnail ??= saved?.marketCreation?.thumbnail ?? undefined
    const registration =
      saved === null
        ? await readRegistrationPolicy(profile.mintUrl, normalized.outcomeLabels)
        : (JSON.parse(saved.canonicalInput) as NativeMarketCreationInput).registration
    input = {
      creationId: command.params.creationId,
      eventId: command.params.eventId,
      market: command.params.market,
      registration,
      destination: {
        engineBaseUrl: profile.engineBaseUrl,
        mintUrl: profile.mintUrl,
        relayUrls: normalizeOracleRelayUrls(command.params.relayUrls),
        ...(thumbnail === undefined
          ? {}
          : {
              thumbnailSha256: createHash('sha256')
                .update(thumbnail.data as Uint8Array)
                .digest('hex'),
              thumbnailFilename: thumbnail.filename,
              thumbnailContentType: thumbnail.contentType,
            }),
      },
    }
  }
  const savedCreation = await getStore().readCreation(input.creationId)
  const walletId = deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex'))
  const walletScopeId = deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId })
  if (
    savedCreation !== null &&
    (savedCreation.walletId !== walletId || savedCreation.walletScopeId !== walletScopeId)
  )
    return { ok: false, error: 'Resume requires the original wallet.' }
  const creationSigner =
    savedCreation === null
      ? { publicKeyHex: secrets.nostrPublicKeyHex, secretKeyHex: secrets.nostrSecretKeyHex }
      : await getStore().readCreationSigner(input.creationId)
  const wallet =
    input.registration.requiredFeeMsat > 0
      ? createWallet(profile.mintUrl, secrets, deps, 'sat', 'msat')
      : undefined
  if (wallet) await wallet.loadMint()
  const result = await completeNativeMarketCreation(
    {
      oracle: {
        get store() {
          return getStore()
        },
        helper: createNativeOracleHelperAdapter(),
        oracleSecretKeyHex: creationSigner.secretKeyHex,
        nonceSeedHex: secrets.nativeOracleNonceSeedHex,
      },
      get coordinator() {
        return payment.coordinator
      },
      wallet,
      seed: Buffer.from(secrets.walletSeedHex, 'hex'),
      engine: createAuthenticatedBitcasterEngineClient({
        baseUrl: profile.engineBaseUrl,
        nostrSecretKeyHex: creationSigner.secretKeyHex,
      }),
      creatorPubkey: creationSigner.publicKeyHex,
    },
    input,
    { thumbnail, maxWalletDebitMsat: command.params.maxWalletDebitMsat },
  )
  // Owner installation has completed. Backup does not affect fees or the primary result.
  try {
    const owner = await getStore().readCreation(input.creationId)
    if (
      result.status === 'created' &&
      owner?.announcement !== null &&
      owner?.announcement !== undefined
    )
      await publishNativeOracleBackup(
        {
          store: getStore(),
          helper: createNativeOracleHelperAdapter(),
          nowSeconds: () => Math.floor(Date.now() / 1000),
          publishRelay: publishNativeOracleBackupEvent,
        },
        owner.announcement.conditionId,
      )
  } catch {
    /* Pending preparation is reconstructed from durable owner status. */
  }
  return { ok: true, result }
}

async function readRegistrationPolicy(mintUrl: string, outcomes: readonly string[]) {
  normalizeMarketCreationInput({
    title: 'Quote',
    description: 'Quote',
    outcomeType: 'categorical',
    outcomeDetails: outcomes.map((name) => ({ name })),
    maturityEpoch: 1,
    categoryTags: [],
    baseAsset: 'sat',
  })
  const { info } = await readPublicMintMetadata(mintUrl)
  const settings = parseCtfSettingsFromMintInfo(info as unknown as Record<string, unknown>)
  const requiredFeeMsat = registrationFeeForPolicy(outcomes, settings, 'msat')
  if (requiredFeeMsat > MAX_CONDITION_REGISTRATION_FEE_SUBUNITS)
    throw new Error('Mint registration fee exceeds the supported limit.')
  return {
    requiredFeeMsat,
    ...(settings.defaultKeysetCreation === 'none'
      ? { outcomeCollections: requiredMarketCreationOutcomeCollections(outcomes) }
      : {}),
  }
}
