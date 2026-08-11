import { UR, URDecoder, UREncoder } from '@ngraveio/bc-ur'
import bytewordsImported from '@ngraveio/bc-ur/dist/bytewords.js'
import { FountainEncoderPart } from '@ngraveio/bc-ur/dist/fountainEncoder.js'
import { DURABLE_OUTGOING_CASHU_TOKEN_PROOF_LIMIT_MAX } from './durableOutgoingCashuTransfer.ts'

export const NUT16_UR_TYPE = 'bytes'
export const NUT16_TOKEN_BYTES_LIMIT = 61_440
export const NUT16_TOKEN_PROOF_LIMIT_MAX = DURABLE_OUTGOING_CASHU_TOKEN_PROOF_LIMIT_MAX
export const NUT16_STATIC_QR_BYTES_LIMIT = 1_024
export const NUT16_STATIC_QR_PROOF_GUIDANCE_MAX = 2
export const NUT16_UR_FRAGMENT_BYTES_LIMIT = 512
export const NUT16_UR_FRAGMENT_LENGTH = 200
export const NUT16_UR_FRAGMENT_COUNT_LIMIT = 512
export const NUT16_UR_ACCEPTED_FRAME_LIMIT = 2_048
export const NUT16_UR_FRAME_CHARS_LIMIT = 1_536
export const NUT16_UR_SESSION_LIFETIME_MS = 120_000

const maxUrMessageBytes = NUT16_TOKEN_BYTES_LIMIT + 16
const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const bytewords =
  (bytewordsImported as unknown as { readonly default?: typeof bytewordsImported }).default ??
  bytewordsImported

export interface Nut16QrPresentation {
  readonly kind: 'static' | 'animated'
  readonly encodedBytes: number
}

export interface Nut16UrDecoderLimits {
  readonly tokenBytesLimit: number
  readonly fragmentBytesLimit: number
  readonly fragmentCountLimit: number
  readonly acceptedFrameLimit: number
  readonly frameCharsLimit: number
  readonly sessionLifetimeMs: number
}

export type Nut16UrDecoderErrorCode =
  | 'corrupt_fragment'
  | 'foreign_type'
  | 'inconsistent_metadata'
  | 'conflicting_fragment'
  | 'resource_limit'
  | 'session_timeout'
  | 'invalid_token'

export type Nut16UrReceiveResult =
  | { readonly status: 'accepted'; readonly progress: number }
  | { readonly status: 'ignored'; readonly progress: number }
  | { readonly status: 'complete'; readonly progress: 1; readonly token: string }
  | {
      readonly status: 'rejected'
      readonly progress: number
      readonly code: Nut16UrDecoderErrorCode
    }

interface FountainMetadata {
  readonly seqNum: number
  readonly seqLength: number
  readonly messageLength: number
  readonly checksum: number
  readonly fragmentLength: number
}

interface MultipartFrame {
  readonly kind: 'multipart'
  readonly canonical: string
  readonly metadata: FountainMetadata
}

type ParsedFrame = MultipartFrame | { readonly kind: 'single'; readonly canonical: string }

const defaultDecoderLimits: Nut16UrDecoderLimits = Object.freeze({
  tokenBytesLimit: NUT16_TOKEN_BYTES_LIMIT,
  fragmentBytesLimit: NUT16_UR_FRAGMENT_BYTES_LIMIT,
  fragmentCountLimit: NUT16_UR_FRAGMENT_COUNT_LIMIT,
  acceptedFrameLimit: NUT16_UR_ACCEPTED_FRAME_LIMIT,
  frameCharsLimit: NUT16_UR_FRAME_CHARS_LIMIT,
  sessionLifetimeMs: NUT16_UR_SESSION_LIFETIME_MS,
})

export function selectNut16QrPresentation(input: {
  readonly token: string
  readonly proofCount: number
}): Nut16QrPresentation {
  const encodedBytes = assertNut16Token(input.token, input.proofCount)
  return {
    kind:
      input.proofCount <= NUT16_STATIC_QR_PROOF_GUIDANCE_MAX &&
      encodedBytes <= NUT16_STATIC_QR_BYTES_LIMIT
        ? 'static'
        : 'animated',
    encodedBytes,
  }
}

/** Generate one fountain frame at a time. */
export class Nut16AnimatedQrEncoder {
  private encoder: UREncoder | null = null
  private readonly token: string
  readonly encodedBytes: number

  constructor(token: string, proofCount: number) {
    this.token = token
    this.encodedBytes = assertNut16Token(token, proofCount)
  }

  nextFrame(): string {
    this.encoder ??= new UREncoder(UR.from(utf8.encode(this.token)), NUT16_UR_FRAGMENT_LENGTH)
    return this.encoder.nextPart()
  }
}

/**
 * Bounded BC-UR receive state. URDecoder exposes Fountain metadata only after
 * receivePart. The isolated package deep imports below admit metadata before
 * that call can allocate an attacker-advertised fragment-index array.
 */
export class Nut16UrDecoderSession {
  private readonly decoder = new URDecoder(undefined, NUT16_UR_TYPE)
  private readonly limits: Nut16UrDecoderLimits
  private readonly firstSeenAtMs: number
  private acceptedFrameCount = 0
  private observedFrameCount = 0
  private completedToken: string | null = null
  private expectedMetadata: Omit<FountainMetadata, 'seqNum'> | null = null
  private rejectedCode: Nut16UrDecoderErrorCode | null = null
  private readonly framesBySequence = new Map<number, string>()

  constructor(limits: Nut16UrDecoderLimits = defaultDecoderLimits, firstSeenAtMs = Date.now()) {
    assertDecoderLimits(limits)
    this.limits = limits
    this.firstSeenAtMs = firstSeenAtMs
  }

  get progress(): number {
    return this.decoder.getProgress()
  }

  get acceptedFrames(): number {
    return this.acceptedFrameCount
  }

  get observedFrames(): number {
    return this.observedFrameCount
  }

  get storedFrames(): number {
    return this.framesBySequence.size
  }

  receive(frame: string, nowMs = Date.now()): Nut16UrReceiveResult {
    if (this.completedToken !== null) return { status: 'ignored', progress: 1 }
    if (this.rejectedCode !== null) return this.rejected()
    if (nowMs < this.firstSeenAtMs || nowMs - this.firstSeenAtMs > this.limits.sessionLifetimeMs) {
      return this.reject('session_timeout')
    }
    this.observedFrameCount += 1
    if (this.observedFrameCount > this.limits.acceptedFrameLimit)
      return this.reject('resource_limit')
    let parsed: ParsedFrame
    try {
      parsed = parseFrame(frame, this.limits)
    } catch (error) {
      return this.reject(error instanceof Nut16FrameError ? error.code : 'corrupt_fragment')
    }
    if (parsed.kind === 'multipart') {
      const duplicate = this.framesBySequence.get(parsed.metadata.seqNum)
      if (duplicate !== undefined) {
        return duplicate === parsed.canonical
          ? { status: 'ignored', progress: this.progress }
          : this.reject('conflicting_fragment')
      }
      if (!sameSession(this.expectedMetadata, parsed.metadata))
        return this.reject('inconsistent_metadata')
      if (this.acceptedFrameCount >= this.limits.acceptedFrameLimit)
        return this.reject('resource_limit')
      this.expectedMetadata ??= withoutSequence(parsed.metadata)
      this.framesBySequence.set(parsed.metadata.seqNum, parsed.canonical)
    } else {
      if (this.expectedMetadata !== null) return this.reject('inconsistent_metadata')
      if (this.acceptedFrameCount >= this.limits.acceptedFrameLimit)
        return this.reject('resource_limit')
    }
    try {
      if (!this.decoder.receivePart(parsed.canonical)) return this.reject('inconsistent_metadata')
    } catch {
      return this.reject('corrupt_fragment')
    }
    this.acceptedFrameCount += 1
    if (!this.decoder.isComplete()) return { status: 'accepted', progress: this.progress }
    try {
      const bytes = this.decoder.resultUR().decodeCBOR()
      if (bytes.length > this.limits.tokenBytesLimit) return this.reject('resource_limit')
      const token = strictUtf8.decode(bytes)
      if (!token.startsWith('cashu') || utf8.encode(token).length > this.limits.tokenBytesLimit) {
        return this.reject('invalid_token')
      }
      this.completedToken = token
      return { status: 'complete', progress: 1, token }
    } catch {
      return this.reject('invalid_token')
    }
  }

  expire(nowMs = Date.now()): Nut16UrReceiveResult | null {
    if (this.completedToken !== null || this.rejectedCode !== null) return null
    return nowMs - this.firstSeenAtMs > this.limits.sessionLifetimeMs
      ? this.reject('session_timeout')
      : null
  }

  private reject(code: Nut16UrDecoderErrorCode): Nut16UrReceiveResult {
    this.rejectedCode = code
    this.framesBySequence.clear()
    return this.rejected()
  }

  private rejected(): Nut16UrReceiveResult {
    return {
      status: 'rejected',
      progress: this.progress,
      code: this.rejectedCode ?? 'corrupt_fragment',
    }
  }
}

class Nut16FrameError extends Error {
  readonly code: Nut16UrDecoderErrorCode

  constructor(code: Nut16UrDecoderErrorCode) {
    super(code)
    this.code = code
  }
}

function assertNut16Token(token: string, proofCount: number): number {
  if (typeof token !== 'string' || !token.startsWith('cashu'))
    throw new Error('NUT-16 token is invalid')
  if (
    !Number.isSafeInteger(proofCount) ||
    proofCount < 0 ||
    proofCount > NUT16_TOKEN_PROOF_LIMIT_MAX
  ) {
    throw new Error('NUT-16 proof count exceeds its limit')
  }
  const encodedBytes = utf8.encode(token).length
  if (encodedBytes === 0 || encodedBytes > NUT16_TOKEN_BYTES_LIMIT) {
    throw new Error('NUT-16 token bytes exceed their limit')
  }
  return encodedBytes
}

function assertDecoderLimits(limits: Nut16UrDecoderLimits): void {
  const values = Object.values(limits)
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('NUT-16 decoder limits are invalid')
  }
  if (limits.tokenBytesLimit > NUT16_TOKEN_BYTES_LIMIT) {
    throw new Error('NUT-16 decoder token limit cannot exceed the shared limit')
  }
}

function parseFrame(frame: string, limits: Nut16UrDecoderLimits): ParsedFrame {
  if (
    typeof frame !== 'string' ||
    !frame ||
    frame.length > limits.frameCharsLimit ||
    frame.trim() !== frame
  ) {
    throw new Nut16FrameError('resource_limit')
  }
  const canonical = frame.toLowerCase()
  const components = canonical.split('/')
  if (components.length < 2 || components[0] !== 'ur:' + NUT16_UR_TYPE) {
    throw new Nut16FrameError(canonical.startsWith('ur:') ? 'foreign_type' : 'corrupt_fragment')
  }
  if (components.length === 2 && components[1]) return { kind: 'single', canonical }
  if (components.length !== 3 || !components[1] || !components[2])
    throw new Nut16FrameError('corrupt_fragment')
  const sequence = /^([1-9][0-9]*)-([1-9][0-9]*)$/.exec(components[1])
  if (sequence === null) throw new Nut16FrameError('corrupt_fragment')
  const seqNum = Number(sequence[1])
  const seqLength = Number(sequence[2])
  if (
    !Number.isSafeInteger(seqNum) ||
    !Number.isSafeInteger(seqLength) ||
    seqLength > limits.fragmentCountLimit
  ) {
    throw new Nut16FrameError('resource_limit')
  }
  let part: FountainEncoderPart
  try {
    part = FountainEncoderPart.fromCBOR(bytewords.decode(components[2]))
  } catch {
    throw new Nut16FrameError('corrupt_fragment')
  }
  const metadata: FountainMetadata = {
    seqNum: part.seqNum,
    seqLength: part.seqLength,
    messageLength: part.messageLength,
    checksum: part.checksum,
    fragmentLength: part.fragment.length,
  }
  if (
    metadata.seqNum !== seqNum ||
    metadata.seqLength !== seqLength ||
    !Number.isSafeInteger(metadata.messageLength) ||
    metadata.messageLength < 1 ||
    metadata.messageLength > Math.min(maxUrMessageBytes, limits.tokenBytesLimit + 16) ||
    !Number.isSafeInteger(metadata.checksum) ||
    metadata.checksum < 0 ||
    metadata.checksum > 0xffff_ffff ||
    metadata.fragmentLength < 1 ||
    metadata.fragmentLength > limits.fragmentBytesLimit
  ) {
    throw new Nut16FrameError('inconsistent_metadata')
  }
  return { kind: 'multipart', canonical, metadata }
}

function withoutSequence(metadata: FountainMetadata): Omit<FountainMetadata, 'seqNum'> {
  const { seqNum: _seqNum, ...result } = metadata
  return result
}

function sameSession(
  expected: Omit<FountainMetadata, 'seqNum'> | null,
  received: FountainMetadata,
): boolean {
  return (
    expected === null ||
    (expected.seqLength === received.seqLength &&
      expected.messageLength === received.messageLength &&
      expected.checksum === received.checksum &&
      expected.fragmentLength === received.fragmentLength)
  )
}
