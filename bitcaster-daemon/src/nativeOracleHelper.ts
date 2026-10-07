import { accessSync, constants, lstatSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  snapshotOraclePrivateAuthority,
  type OracleBackupValidator,
  type OraclePrivateAuthority,
  type OracleEnumAuthoritySummary,
} from '@bitcaster-market/client-sdk/oracleBackup'
import { announcementContentFromTlv } from '@bitcaster-market/client-sdk/oracleAnnouncementEncoding'

export const NATIVE_ORACLE_HELPER_INPUT_BYTES_MAX = 1024 * 1024
export const NATIVE_ORACLE_HELPER_OUTPUT_BYTES_MAX = 1024 * 1024
export const NATIVE_ORACLE_HELPER_STDERR_BYTES_MAX = 4 * 1024
export const NATIVE_ORACLE_HELPER_TIMEOUT_MS = 15_000
export const NATIVE_ORACLE_HELPER_TITLE_BYTES_MAX = 256 * 1024
export const NATIVE_ORACLE_HELPER_DESCRIPTION_BYTES_MAX = 256 * 1024
export const NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX = 256 * 1024
export const NATIVE_ORACLE_HELPER_HEX_TEXT_BYTES_MAX = 48 * 1024
export const NATIVE_ORACLE_HELPER_OUTCOME_BYTES_MAX = 191
export const NATIVE_ORACLE_NONCE_INDEX_LIMIT = 2 ** 31

const PRIVATE_AUTHORITY_BYTES_MAX = 65_535

const HELPER_NAME = 'bitcaster-oracle-helper'
const HELPER_ERROR_CODES = [
  'invalid-request',
  'invalid-announcement',
  'nonce-mismatch',
  'invalid-outcome',
  'internal-failure',
] as const

type HelperErrorCode = (typeof HELPER_ERROR_CODES)[number]
type NativeOracleHelperErrorReason =
  | 'unsupported-platform'
  | 'helper-unavailable'
  | 'invalid-request'
  | 'helper-rejected'
  | 'process-failure'
  | 'timed-out'
  | 'output-limit'
  | 'malformed-response'

const ERROR_MESSAGES: Readonly<Record<NativeOracleHelperErrorReason, string>> = {
  'unsupported-platform': 'native oracle helper does not support this platform',
  'helper-unavailable': 'native oracle helper is unavailable',
  'invalid-request': 'native oracle helper request is invalid',
  'helper-rejected': 'native oracle helper rejected the request',
  'process-failure': 'native oracle helper process failed',
  'timed-out': 'native oracle helper timed out',
  'output-limit': 'native oracle helper exceeded an output limit',
  'malformed-response': 'native oracle helper returned an invalid response',
}

const require = createRequire(import.meta.url)
const nostrTools = require('nostr-tools/pure') as {
  getPublicKey(secretKey: Uint8Array): string
  verifyEvent(event: unknown): boolean
}

export interface NativeOracleCreateEnumRequest {
  readonly oracleSecretKeyHex: string
  readonly nonceSeedHex: string
  readonly reservedNonceIndex: number
  readonly eventId: string
  readonly outcomes: readonly string[]
  readonly eventMaturityEpoch: number
  readonly title: string
  readonly description: string
}

export interface NativeOracleSignEnumRequest {
  readonly oracleSecretKeyHex: string
  readonly nonceSeedHex: string
  readonly reservedNonceIndex: number
  readonly eventId: string
  readonly chosenOutcome: string
  readonly announcementTlvHex: string
  readonly announcementNostrEventJson: string
}

export interface NativeOracleExportEnumAuthorityRequest extends Omit<
  OraclePrivateAuthority,
  'schemaVersion' | 'nonceScalarHex'
> {
  readonly oracleSecretKeyHex: string
  readonly nonceSeedHex: string
  readonly reservedNonceIndex: number
}

export interface NativeOracleSignExplicitEnumRequest {
  readonly oracleSecretKeyHex: string
  readonly privateDtoJson: string
  readonly chosenOutcome: string
}

export interface NativeOracleVerifyEnumRequest {
  readonly eventId: string
  readonly oraclePublicKeyHex: string
  readonly chosenOutcome: string
  readonly announcementTlvHex: string
  readonly announcementNostrEventJson: string
  readonly attestationHex: string
  readonly attestationNostrEventJson: string
}

export interface NativeOracleVerifyEnumResponse {
  readonly eventId: string
  readonly oraclePublicKeyHex: string
  readonly chosenOutcome: string
  readonly announcementNostrEventId: string
  readonly attestationNostrEventId: string
  readonly noncePointHex: string
  readonly oracleSignatureHex: string
}

export interface NativeOracleCreateEnumResponse {
  readonly eventId: string
  readonly oraclePublicKeyHex: string
  readonly announcementTlvHex: string
  readonly announcementNostrEventId: string
  readonly announcementNostrEventJson: string
}

export interface NativeOracleSignEnumResponse {
  readonly eventId: string
  readonly chosenOutcome: string
  readonly attestationHex: string
  readonly attestationNostrEventId: string
  readonly attestationNostrEventJson: string
}

export interface NativeOracleHelper extends OracleBackupValidator {
  exportEnumAuthority(request: NativeOracleExportEnumAuthorityRequest): Promise<string>
  signExplicitEnum(
    request: NativeOracleSignExplicitEnumRequest,
  ): Promise<NativeOracleSignEnumResponse>
  assertAvailable(): void
  createEnum(request: NativeOracleCreateEnumRequest): Promise<NativeOracleCreateEnumResponse>
  signEnum(request: NativeOracleSignEnumRequest): Promise<NativeOracleSignEnumResponse>
  verifyEnum(request: NativeOracleVerifyEnumRequest): Promise<NativeOracleVerifyEnumResponse>
}

export class NativeOracleHelperError extends Error {
  readonly reason: NativeOracleHelperErrorReason
  readonly uncertain: boolean
  readonly helperCode?: HelperErrorCode

  constructor(
    reason: NativeOracleHelperErrorReason,
    uncertain: boolean,
    helperCode?: HelperErrorCode,
  ) {
    super(ERROR_MESSAGES[reason])
    this.name = 'NativeOracleHelperError'
    this.reason = reason
    this.uncertain = uncertain
    this.helperCode = helperCode
  }
}

export interface NativeOracleHelperAdapterOptions {
  readonly resolveExecutable?: () => string
  readonly spawnProcess?: typeof spawn
  readonly timeoutMs?: number
}

interface NostrEvent {
  readonly id: string
  readonly pubkey: string
  readonly created_at: number
  readonly kind: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
  readonly sig: string
}

interface HelperFailureResponse {
  readonly version: 1
  readonly ok: false
  readonly code: HelperErrorCode
}

export function resolveNativeOracleHelperPath(): string {
  const platform = process.platform
  const architecture = process.arch
  if (platform === 'win32' || !/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(architecture)) {
    throw new NativeOracleHelperError('unsupported-platform', false)
  }
  return fileURLToPath(
    new URL(`../native/${platform}-${architecture}/${HELPER_NAME}`, import.meta.url),
  )
}

export function assertNativeOracleHelperAvailable(): void {
  defaultAdapter.assertAvailable()
}

export function createEnum(
  request: NativeOracleCreateEnumRequest,
): Promise<NativeOracleCreateEnumResponse> {
  return defaultAdapter.createEnum(request)
}

export function signEnum(
  request: NativeOracleSignEnumRequest,
): Promise<NativeOracleSignEnumResponse> {
  return defaultAdapter.signEnum(request)
}

export function validateAuthority(
  privateDtoJson: string,
  expectedOraclePubkey: string,
): Promise<OracleEnumAuthoritySummary> {
  return defaultAdapter.validateAuthority(privateDtoJson, expectedOraclePubkey)
}

export function exportEnumAuthority(
  request: NativeOracleExportEnumAuthorityRequest,
): Promise<string> {
  return defaultAdapter.exportEnumAuthority(request)
}

export function signExplicitEnum(
  request: NativeOracleSignExplicitEnumRequest,
): Promise<NativeOracleSignEnumResponse> {
  return defaultAdapter.signExplicitEnum(request)
}

export function createNativeOracleHelperAdapter(
  options: NativeOracleHelperAdapterOptions = {},
): NativeOracleHelper {
  const resolveExecutable = options.resolveExecutable ?? resolveNativeOracleHelperPath
  const spawnProcess = options.spawnProcess ?? spawn
  const timeoutMs = options.timeoutMs ?? NATIVE_ORACLE_HELPER_TIMEOUT_MS
  return {
    assertAvailable() {
      const executablePath = resolvePath(resolveExecutable)
      assertExecutable(executablePath)
    },
    async validateAuthority(privateDtoJson, expectedOraclePubkey) {
      try {
        if (
          !isBoundedString(privateDtoJson, PRIVATE_AUTHORITY_BYTES_MAX) ||
          !isLowerHex(expectedOraclePubkey, 32)
        )
          throw helperError('invalid-request')
        const payload = encodeRequest({
          version: 1,
          action: 'validate-authority',
          privateDtoJson,
          expectedOraclePubkey,
        })
        const response = await invokeHelper(resolveExecutable, spawnProcess, timeoutMs, payload)
        return validateAuthorityResponse(response, expectedOraclePubkey)
      } catch (error) {
        if (error instanceof NativeOracleHelperError)
          throw new NativeOracleHelperError(error.reason, false, error.helperCode)
        throw helperError('malformed-response')
      }
    },
    async exportEnumAuthority(request) {
      validateSecretRequest(request)
      const pubkey = deriveOraclePublicKey(request.oracleSecretKeyHex)
      const payload = encodeRequest({ version: 1, action: 'export-enum-authority', ...request })
      try {
        const response = await invokeHelper(resolveExecutable, spawnProcess, timeoutMs, payload)
        const value = exactRecord(response, ['version', 'ok', 'action', 'privateDtoJson'])
        if (value.version !== 1 || value.ok !== true || value.action !== 'export-enum-authority')
          throw helperError('malformed-response')
        const dto = readPrivateDto(value.privateDtoJson, 'malformed-response')
        if (
          dto.nonceScalarHex === null ||
          (Object.keys(dto) as (keyof OraclePrivateAuthority)[]).some(
            (key) =>
              key !== 'schemaVersion' && key !== 'nonceScalarHex' && dto[key] !== request[key],
          )
        )
          throw helperError('malformed-response')
        parseSignedEvent(dto.announcementEventJson, 88, pubkey)
        return value.privateDtoJson as string
      } catch (error) {
        if (error instanceof NativeOracleHelperError)
          throw new NativeOracleHelperError(error.reason, false, error.helperCode)
        throw helperError('malformed-response')
      }
    },
    async signExplicitEnum(request) {
      if (
        !request ||
        !isLowerHex(request.oracleSecretKeyHex, 32) ||
        !isBoundedString(request.chosenOutcome, NATIVE_ORACLE_HELPER_OUTCOME_BYTES_MAX)
      )
        throw helperError('invalid-request')
      const dto = readPrivateDto(request.privateDtoJson, 'invalid-request')
      if (
        dto.nonceScalarHex === null ||
        (dto.signedOutcome !== null && dto.signedOutcome !== request.chosenOutcome)
      )
        throw helperError('invalid-request')
      const pubkey = deriveOraclePublicKey(request.oracleSecretKeyHex)
      const announcement = parseSignedEvent(
        dto.announcementEventJson,
        88,
        pubkey,
        'invalid-request',
      )
      const summary = await this.validateAuthority(request.privateDtoJson, pubkey)
      const payload = encodeRequest({ version: 1, action: 'sign-explicit-enum', ...request })
      const response = await invokeHelper(resolveExecutable, spawnProcess, timeoutMs, payload)
      const signed = validateSignResponse(
        response,
        { eventId: summary.eventId, chosenOutcome: request.chosenOutcome },
        announcement,
        pubkey,
        'sign-explicit-enum',
      )
      if (
        dto.attestationHex !== null &&
        (signed.attestationHex !== dto.attestationHex ||
          signed.attestationNostrEventJson !== dto.attestationEventJson)
      )
        throw helperError('malformed-response', true)
      return signed
    },
    async createEnum(request) {
      const payload = encodeCreateRequest(request)
      const oraclePublicKeyHex = deriveOraclePublicKey(request.oracleSecretKeyHex)
      const response = await invokeHelper(resolveExecutable, spawnProcess, timeoutMs, payload)
      return validateCreateResponse(response, request, oraclePublicKeyHex)
    },
    async signEnum(request) {
      const payload = encodeSignRequest(request)
      const oraclePublicKeyHex = deriveOraclePublicKey(request.oracleSecretKeyHex)
      const announcementEvent = parseSignedEvent(
        request.announcementNostrEventJson,
        88,
        oraclePublicKeyHex,
        'invalid-request',
      )
      const response = await invokeHelper(resolveExecutable, spawnProcess, timeoutMs, payload)
      return validateSignResponse(response, request, announcementEvent, oraclePublicKeyHex)
    },
    async verifyEnum(request) {
      const payload = encodeVerifyRequest(request)
      try {
        const response = await invokeHelper(resolveExecutable, spawnProcess, timeoutMs, payload)
        return validateVerifyResponse(response, request)
      } catch (error) {
        if (error instanceof NativeOracleHelperError)
          throw new NativeOracleHelperError(error.reason, false, error.helperCode)
        throw new NativeOracleHelperError('malformed-response', false)
      }
    },
  }
}

const defaultAdapter = createNativeOracleHelperAdapter()

function readPrivateDto(
  value: unknown,
  reason: NativeOracleHelperErrorReason,
): OraclePrivateAuthority {
  if (!isBoundedString(value, PRIVATE_AUTHORITY_BYTES_MAX)) throw helperError(reason)
  try {
    return snapshotOraclePrivateAuthority(JSON.parse(value))
  } catch {
    throw helperError(reason)
  }
}

function validateAuthorityResponse(
  response: unknown,
  expectedPubkey: string,
): OracleEnumAuthoritySummary {
  const value = exactRecord(response, ['version', 'ok', 'action', 'summary'])
  const summary = exactRecord(value.summary, ['eventId', 'oraclePubkey', 'outcomes', 'noncePoint'])
  if (
    value.version !== 1 ||
    value.ok !== true ||
    value.action !== 'validate-authority' ||
    !isBoundedString(summary.eventId, 512) ||
    summary.oraclePubkey !== expectedPubkey ||
    !isLowerHex(summary.noncePoint, 32) ||
    !Array.isArray(summary.outcomes) ||
    summary.outcomes.length < 2 ||
    summary.outcomes.length > 8 ||
    new Set(summary.outcomes).size !== summary.outcomes.length ||
    !summary.outcomes.every((outcome) =>
      isBoundedString(outcome, NATIVE_ORACLE_HELPER_OUTCOME_BYTES_MAX),
    )
  )
    throw helperError('malformed-response')
  return summary as unknown as OracleEnumAuthoritySummary
}

function encodeCreateRequest(request: NativeOracleCreateEnumRequest): Buffer {
  validateSecretRequest(request)
  if (
    !isBoundedString(request.eventId, 512) ||
    !Array.isArray(request.outcomes) ||
    request.outcomes.length < 2 ||
    request.outcomes.length > 8 ||
    !request.outcomes.every(
      (outcome) =>
        isBoundedString(outcome, NATIVE_ORACLE_HELPER_OUTCOME_BYTES_MAX) &&
        outcome.trim().length > 0,
    ) ||
    new Set(request.outcomes).size !== request.outcomes.length ||
    !Number.isInteger(request.eventMaturityEpoch) ||
    request.eventMaturityEpoch < 0 ||
    request.eventMaturityEpoch > 0xffff_ffff ||
    !isBoundedString(request.title, NATIVE_ORACLE_HELPER_TITLE_BYTES_MAX, true) ||
    !isBoundedString(request.description, NATIVE_ORACLE_HELPER_DESCRIPTION_BYTES_MAX, true)
  ) {
    throw helperError('invalid-request')
  }
  return encodeRequest({
    version: 1,
    action: 'create-enum',
    oracleSecretKeyHex: request.oracleSecretKeyHex,
    nonceSeedHex: request.nonceSeedHex,
    reservedNonceIndex: request.reservedNonceIndex,
    eventId: request.eventId,
    outcomes: [...request.outcomes],
    eventMaturityEpoch: request.eventMaturityEpoch,
    title: request.title,
    description: request.description,
  })
}

function encodeSignRequest(request: NativeOracleSignEnumRequest): Buffer {
  validateSecretRequest(request)
  if (
    !isBoundedString(request.eventId, 512) ||
    !isBoundedString(request.chosenOutcome, NATIVE_ORACLE_HELPER_OUTCOME_BYTES_MAX) ||
    !isBoundedLowerHexText(request.announcementTlvHex, NATIVE_ORACLE_HELPER_HEX_TEXT_BYTES_MAX) ||
    !isBoundedString(request.announcementNostrEventJson, NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX)
  ) {
    throw helperError('invalid-request')
  }
  return encodeRequest({
    version: 1,
    action: 'sign-enum',
    oracleSecretKeyHex: request.oracleSecretKeyHex,
    nonceSeedHex: request.nonceSeedHex,
    reservedNonceIndex: request.reservedNonceIndex,
    eventId: request.eventId,
    chosenOutcome: request.chosenOutcome,
    announcementTlvHex: request.announcementTlvHex,
    announcementNostrEventJson: request.announcementNostrEventJson,
  })
}

function encodeVerifyRequest(request: NativeOracleVerifyEnumRequest): Buffer {
  if (
    !request ||
    !isBoundedString(request.eventId, 512) ||
    !isLowerHex(request.oraclePublicKeyHex, 32) ||
    !isBoundedString(request.chosenOutcome, NATIVE_ORACLE_HELPER_OUTCOME_BYTES_MAX) ||
    !isBoundedLowerHexText(request.announcementTlvHex, NATIVE_ORACLE_HELPER_HEX_TEXT_BYTES_MAX) ||
    !isBoundedLowerHexText(request.attestationHex, NATIVE_ORACLE_HELPER_HEX_TEXT_BYTES_MAX) ||
    !isBoundedString(
      request.announcementNostrEventJson,
      NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX,
    ) ||
    !isBoundedString(request.attestationNostrEventJson, NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX)
  )
    throw helperError('invalid-request')
  return encodeRequest({ version: 1, action: 'verify-enum', ...request })
}

function validateVerifyResponse(
  response: unknown,
  request: NativeOracleVerifyEnumRequest,
): NativeOracleVerifyEnumResponse {
  const value = exactRecord(response, [
    'version',
    'ok',
    'action',
    'eventId',
    'oraclePublicKeyHex',
    'chosenOutcome',
    'announcementNostrEventId',
    'attestationNostrEventId',
    'noncePointHex',
    'oracleSignatureHex',
  ])
  const announcement = parseSignedEvent(
    request.announcementNostrEventJson,
    88,
    request.oraclePublicKeyHex,
  )
  const attestation = parseSignedEvent(
    request.attestationNostrEventJson,
    89,
    request.oraclePublicKeyHex,
  )
  if (
    value.version !== 1 ||
    value.ok !== true ||
    value.action !== 'verify-enum' ||
    value.eventId !== request.eventId ||
    value.oraclePublicKeyHex !== request.oraclePublicKeyHex ||
    value.chosenOutcome !== request.chosenOutcome ||
    value.announcementNostrEventId !== announcement.id ||
    value.attestationNostrEventId !== attestation.id ||
    !isLowerHex(value.noncePointHex, 32) ||
    !isLowerHex(value.oracleSignatureHex, 64)
  )
    throw helperError('malformed-response')
  return {
    eventId: request.eventId,
    oraclePublicKeyHex: request.oraclePublicKeyHex,
    chosenOutcome: request.chosenOutcome,
    announcementNostrEventId: announcement.id,
    attestationNostrEventId: attestation.id,
    noncePointHex: value.noncePointHex as string,
    oracleSignatureHex: value.oracleSignatureHex as string,
  }
}

function validateSecretRequest(
  request:
    | {
        readonly oracleSecretKeyHex?: unknown
        readonly nonceSeedHex?: unknown
        readonly reservedNonceIndex?: unknown
      }
    | null
    | undefined,
): void {
  if (
    request === null ||
    request === undefined ||
    !isLowerHex(request.oracleSecretKeyHex, 32) ||
    !isLowerHex(request.nonceSeedHex, 32) ||
    request.oracleSecretKeyHex === request.nonceSeedHex ||
    typeof request.reservedNonceIndex !== 'number' ||
    !Number.isInteger(request.reservedNonceIndex) ||
    request.reservedNonceIndex < 0 ||
    request.reservedNonceIndex >= NATIVE_ORACLE_NONCE_INDEX_LIMIT
  ) {
    throw helperError('invalid-request')
  }
}

function encodeRequest(request: object): Buffer {
  let encoded: string
  try {
    encoded = JSON.stringify(request)
  } catch {
    throw helperError('invalid-request')
  }
  const bytes = Buffer.from(encoded, 'utf8')
  if (bytes.length > NATIVE_ORACLE_HELPER_INPUT_BYTES_MAX) {
    throw helperError('invalid-request')
  }
  return bytes
}

function invokeHelper(
  resolveExecutable: () => string,
  spawnProcess: typeof spawn,
  timeoutMs: number,
  payload: Buffer,
): Promise<unknown> {
  const executablePath = resolvePath(resolveExecutable)
  assertExecutable(executablePath)
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(executablePath, [], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: {},
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      reject(helperError('process-failure', true))
      return
    }
    watchProcess(child, payload, timeoutMs, resolve, reject)
  })
}

interface ProcessOutputCapture {
  readonly stdoutChunks: Buffer[]
  stdoutBytes: number
  stderrBytes: number
  settled: boolean
}

function watchProcess(
  child: ChildProcessWithoutNullStreams,
  payload: Buffer,
  timeoutMs: number,
  resolve: (response: unknown) => void,
  reject: (error: NativeOracleHelperError) => void,
): void {
  const capture: ProcessOutputCapture = {
    stdoutChunks: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    settled: false,
  }
  let timeout: NodeJS.Timeout
  const finishWithError = (reason: NativeOracleHelperErrorReason) => {
    if (capture.settled) return
    capture.settled = true
    clearTimeout(timeout)
    try {
      child.kill('SIGKILL')
    } catch {
      // The process result remains uncertain even if termination fails.
    }
    reject(helperError(reason, true))
  }

  child.stdout.on('data', (chunk: Buffer | string) => {
    if (!captureStdout(capture, chunk)) finishWithError('output-limit')
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    if (!captureStderr(capture, chunk)) finishWithError('output-limit')
  })
  child.stdin.on('error', () => finishWithError('process-failure'))
  child.once('error', () => finishWithError('process-failure'))
  child.once('close', (code, signal) => {
    completeProcess(capture, code, signal, timeout, resolve, reject)
  })
  timeout = setTimeout(() => finishWithError('timed-out'), timeoutMs)

  try {
    child.stdin.end(payload)
  } catch {
    finishWithError('process-failure')
  }
}

function captureStdout(capture: ProcessOutputCapture, chunk: Buffer | string): boolean {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  if (capture.stdoutBytes + bytes.length > NATIVE_ORACLE_HELPER_OUTPUT_BYTES_MAX) return false
  capture.stdoutBytes += bytes.length
  capture.stdoutChunks.push(bytes)
  return true
}

function captureStderr(capture: ProcessOutputCapture, chunk: Buffer | string): boolean {
  const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
  if (capture.stderrBytes + byteLength > NATIVE_ORACLE_HELPER_STDERR_BYTES_MAX) return false
  capture.stderrBytes += byteLength
  return true
}

function completeProcess(
  capture: ProcessOutputCapture,
  code: number | null,
  signal: NodeJS.Signals | null,
  timeout: NodeJS.Timeout,
  resolve: (response: unknown) => void,
  reject: (error: NativeOracleHelperError) => void,
): void {
  if (capture.settled) return
  capture.settled = true
  clearTimeout(timeout)
  if (signal !== null || code === null) return reject(helperError('process-failure', true))
  const parsed = parseResponse(Buffer.concat(capture.stdoutChunks, capture.stdoutBytes))
  if (parsed === null) return reject(helperError('malformed-response', true))
  if (isHelperFailureResponse(parsed)) return rejectHelperFailure(parsed, code, reject)
  if (code !== 0) return reject(helperError('process-failure', true))
  resolve(parsed)
}

function rejectHelperFailure(
  response: HelperFailureResponse,
  processExitCode: number,
  reject: (error: NativeOracleHelperError) => void,
): void {
  if (processExitCode !== 1) return reject(helperError('process-failure', true))
  reject(
    response.code === 'internal-failure'
      ? helperError('process-failure', true, response.code)
      : helperError('helper-rejected', false, response.code),
  )
}

function parseResponse(bytes: Buffer): unknown | null {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) return null
  const body = bytes.subarray(0, -1)
  if (body.includes(0x0a) || body.includes(0x0d)) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function isHelperFailureResponse(value: unknown): value is HelperFailureResponse {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false
  }
  const response = value as Record<string, unknown>
  const keys = Object.keys(response)
  return (
    keys.length === 3 &&
    keys.includes('version') &&
    keys.includes('ok') &&
    keys.includes('code') &&
    response.version === 1 &&
    response.ok === false &&
    typeof response.code === 'string' &&
    HELPER_ERROR_CODES.includes(response.code as HelperErrorCode)
  )
}

function validateCreateResponse(
  response: unknown,
  request: NativeOracleCreateEnumRequest,
  expectedPublicKey: string,
): NativeOracleCreateEnumResponse {
  const value = exactRecord(response, [
    'version',
    'ok',
    'action',
    'eventId',
    'oraclePublicKeyHex',
    'announcementTlvHex',
    'announcementNostrEventId',
    'announcementNostrEventJson',
  ])
  if (
    value.version !== 1 ||
    value.ok !== true ||
    value.action !== 'create-enum' ||
    value.eventId !== request.eventId ||
    value.oraclePublicKeyHex !== expectedPublicKey ||
    !isBoundedLowerHexText(value.announcementTlvHex, NATIVE_ORACLE_HELPER_HEX_TEXT_BYTES_MAX) ||
    !isLowerHex(value.announcementNostrEventId, 32) ||
    !isBoundedString(value.announcementNostrEventJson, NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX)
  ) {
    throw helperError('malformed-response', true)
  }
  const event = parseSignedEvent(value.announcementNostrEventJson, 88, expectedPublicKey)
  const expectedContent = announcementContentFromTlv(value.announcementTlvHex)
  if (
    event.id !== value.announcementNostrEventId ||
    expectedContent === undefined ||
    event.content !== expectedContent ||
    !hasExactTags(event.tags, expectedMetadataTags(request.title, request.description))
  ) {
    throw helperError('malformed-response', true)
  }
  return {
    eventId: value.eventId,
    oraclePublicKeyHex: value.oraclePublicKeyHex,
    announcementTlvHex: value.announcementTlvHex,
    announcementNostrEventId: value.announcementNostrEventId,
    announcementNostrEventJson: value.announcementNostrEventJson,
  }
}

function validateSignResponse(
  response: unknown,
  request: Pick<NativeOracleSignEnumRequest, 'eventId' | 'chosenOutcome'>,
  announcementEvent: NostrEvent,
  expectedPublicKey: string,
  expectedAction = 'sign-enum',
): NativeOracleSignEnumResponse {
  const value = exactRecord(response, [
    'version',
    'ok',
    'action',
    'eventId',
    'chosenOutcome',
    'attestationHex',
    'attestationNostrEventId',
    'attestationNostrEventJson',
  ])
  if (
    value.version !== 1 ||
    value.ok !== true ||
    value.action !== expectedAction ||
    value.eventId !== request.eventId ||
    value.chosenOutcome !== request.chosenOutcome ||
    !isBoundedLowerHexText(value.attestationHex, NATIVE_ORACLE_HELPER_HEX_TEXT_BYTES_MAX) ||
    !isLowerHex(value.attestationNostrEventId, 32) ||
    !isBoundedString(value.attestationNostrEventJson, NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX)
  ) {
    throw helperError('malformed-response', true)
  }
  const event = parseSignedEvent(value.attestationNostrEventJson, 89, expectedPublicKey)
  const expectedContent = Buffer.from(value.attestationHex, 'hex').toString('base64')
  if (
    event.id !== value.attestationNostrEventId ||
    event.content !== expectedContent ||
    event.tags.length !== 1 ||
    event.tags[0].length !== 2 ||
    event.tags[0][0] !== 'e' ||
    event.tags[0][1] !== announcementEvent.id
  ) {
    throw helperError('malformed-response', true)
  }
  return {
    eventId: value.eventId,
    chosenOutcome: value.chosenOutcome,
    attestationHex: value.attestationHex,
    attestationNostrEventId: value.attestationNostrEventId,
    attestationNostrEventJson: value.attestationNostrEventJson,
  }
}

function parseSignedEvent(
  json: string,
  expectedKind: number,
  expectedPublicKey: string,
  errorReason: NativeOracleHelperErrorReason = 'malformed-response',
): NostrEvent {
  let value: unknown
  try {
    value = JSON.parse(json) as unknown
  } catch {
    throw helperError(errorReason, errorReason !== 'invalid-request')
  }
  const event = exactRecord(
    value,
    ['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'],
    errorReason,
  )
  if (
    !isLowerHex(event.id, 32) ||
    !isLowerHex(event.pubkey, 32) ||
    event.pubkey !== expectedPublicKey ||
    !Number.isSafeInteger(event.created_at) ||
    (event.created_at as number) < 0 ||
    event.kind !== expectedKind ||
    typeof event.content !== 'string' ||
    Buffer.byteLength(event.content, 'utf8') > NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX ||
    !isLowerHex(event.sig, 64) ||
    !validTags(event.tags)
  ) {
    throw helperError(errorReason, errorReason !== 'invalid-request')
  }
  const nostrEvent = event as unknown as NostrEvent
  try {
    if (!nostrTools.verifyEvent(nostrEvent)) {
      throw helperError(errorReason, errorReason !== 'invalid-request')
    }
  } catch {
    throw helperError(errorReason, errorReason !== 'invalid-request')
  }
  return nostrEvent
}

function deriveOraclePublicKey(secretKeyHex: string): string {
  try {
    return nostrTools.getPublicKey(Buffer.from(secretKeyHex, 'hex'))
  } catch {
    throw helperError('invalid-request')
  }
}

function expectedMetadataTags(title: string, description: string): readonly (readonly string[])[] {
  const tags: string[][] = []
  if (title.length > 0) tags.push(['title', title])
  if (description.length > 0) tags.push(['description', description])
  return tags
}

function hasExactTags(
  actual: readonly (readonly string[])[],
  expected: readonly (readonly string[])[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (tag, index) =>
        tag.length === expected[index].length &&
        tag.every((value, valueIndex) => value === expected[index][valueIndex]),
    )
  )
}

function validTags(value: unknown): value is readonly (readonly string[])[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length > 0 &&
        tag.length <= 8 &&
        tag.every(
          (field) =>
            typeof field === 'string' &&
            Buffer.byteLength(field, 'utf8') <= NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX,
        ),
    )
  )
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  errorReason: NativeOracleHelperErrorReason = 'malformed-response',
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw helperError(errorReason, errorReason !== 'invalid-request')
  }
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw helperError(errorReason, errorReason !== 'invalid-request')
  }
  return value as Record<string, unknown>
}

function isBoundedString(
  value: unknown,
  maximumBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    !value.includes('\0')
  )
}

function isLowerHex(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && value.length === maximumBytes * 2 && /^[0-9a-f]+$/.test(value)
}

function isBoundedLowerHexText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 2 === 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    /^[0-9a-f]+$/.test(value)
  )
}

function resolvePath(resolveExecutable: () => string): string {
  try {
    return resolveExecutable()
  } catch (error) {
    if (error instanceof NativeOracleHelperError) throw error
    throw helperError('helper-unavailable')
  }
}

function assertExecutable(executablePath: string): void {
  try {
    const entry = lstatSync(executablePath)
    if (!entry.isFile()) throw helperError('helper-unavailable')
    accessSync(executablePath, constants.X_OK)
  } catch (error) {
    if (error instanceof NativeOracleHelperError) throw error
    throw helperError('helper-unavailable')
  }
}

function helperError(
  reason: NativeOracleHelperErrorReason,
  uncertain = false,
  helperCode?: HelperErrorCode,
): NativeOracleHelperError {
  return new NativeOracleHelperError(reason, uncertain, helperCode)
}
