import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'
import bytewordsImported from '@ngraveio/bc-ur/dist/bytewords.js'
import { FountainEncoderPart } from '@ngraveio/bc-ur/dist/fountainEncoder.js'
import {
  Nut16AnimatedQrEncoder,
  Nut16UrDecoderSession,
  NUT16_TOKEN_BYTES_LIMIT,
  selectNut16QrPresentation,
  type Nut16UrDecoderLimits,
} from '../src/nut16Qr.ts'

const TOKEN = 'cashuBfixture-token-animated-0123456789abcdefghijklmnopqrstuvwxyz'
const bytewords =
  (bytewordsImported as unknown as { readonly default?: typeof bytewordsImported }).default ??
  bytewordsImported
// Generated with Cashu.me's independent @gandlaf21/bc-ur 1.1.12 browser build.
const STATIC = 'ur:bytes/gtiahsjkiskpfwiyinksjykpjpihsbsrssko'
const FRAMES = [
  'ur:bytes/1-4/lpadaacsfxcybtahzcndgyhdfpiahsjkiskpfwiyinksjykpjpihdpjyzegtvtgl',
  'ur:bytes/2-4/lpaoaacsfxcybtahzcndgyjljeihjtdphsjtinjnhsjyihiedpdyeheybbfhsbpy',
  'ur:bytes/3-4/lpaxaacsfxcybtahzcndgyeoeeecenemeteshsidiaieihiyioisinimbzgefnba',
  'ur:bytes/4-4/lpaaaacsfxcybtahzcndgyjejzjnjtjljojsjpjkjykpkoktkskkknaegtuowkue',
  'ur:bytes/5-4/lpahaacsfxcybtahzcndgyjljphyhgamfpguetcyctcaaoaefzfybsdwksrtswue',
] as const

const limits = (overrides: Partial<Nut16UrDecoderLimits> = {}): Nut16UrDecoderLimits => ({
  tokenBytesLimit: NUT16_TOKEN_BYTES_LIMIT,
  fragmentBytesLimit: 512,
  fragmentCountLimit: 512,
  acceptedFrameLimit: 2_048,
  frameCharsLimit: 1_536,
  sessionLifetimeMs: 120_000,
  ...overrides,
})

test('NUT-16 chooses static only for bounded two-proof guidance', () => {
  assert.equal(selectNut16QrPresentation({ token: 'cashuBsmall', proofCount: 2 }).kind, 'static')
  assert.equal(selectNut16QrPresentation({ token: 'cashuBsmall', proofCount: 3 }).kind, 'animated')
  assert.equal(
    selectNut16QrPresentation({ token: 'cashuB' + 'a'.repeat(1_100), proofCount: 1 }).kind,
    'animated',
  )
  assert.throws(
    () =>
      selectNut16QrPresentation({
        token: 'cashuB' + 'a'.repeat(NUT16_TOKEN_BYTES_LIMIT),
        proofCount: 1,
      }),
    /bytes exceed/,
  )
})

test('NUT-16 encoder is lazy and its independently generated fixture decodes', () => {
  const encoder = new Nut16AnimatedQrEncoder(TOKEN, 3)
  const first = encoder.nextFrame()
  assert.match(first, /^ur:bytes\//)
  const session = new Nut16UrDecoderSession(limits(), 0)
  let result = session.receive(FRAMES[4], 1)
  for (const frame of [FRAMES[3], FRAMES[2], FRAMES[1], FRAMES[0]]) {
    const received = session.receive(frame, 2)
    if (received.status === 'complete') result = received
  }
  assert.equal(result.status, 'complete')
  if (result.status === 'complete') assert.equal(result.token, TOKEN)
})

test('NUT-16 accepts out-of-order, identical repeats, and redundant frames', () => {
  const session = new Nut16UrDecoderSession(limits(), 0)
  assert.equal(session.receive(FRAMES[1], 1).status, 'accepted')
  assert.equal(session.receive(FRAMES[1], 2).status, 'ignored')
  assert.equal(session.receive(FRAMES[4], 3).status, 'accepted')
  for (const frame of [FRAMES[3], FRAMES[2], FRAMES[0]]) {
    const result = session.receive(frame, 4)
    if (result.status === 'complete') assert.equal(result.token, TOKEN)
  }
  assert.ok(session.acceptedFrames <= 5)
  assert.ok(session.observedFrames <= 6)
  assert.ok(session.storedFrames <= 5)
})

test('NUT-16 accepts an independently generated single-part UR fixture', () => {
  const result = new Nut16UrDecoderSession(limits(), 0).receive(STATIC, 1)
  assert.equal(result.status, 'complete')
  if (result.status === 'complete') assert.equal(result.token, 'cashuBfixture')
})

test('NUT-16 rejects a single-part message mixed into a multipart session', () => {
  const session = new Nut16UrDecoderSession(limits(), 0)
  assert.equal(session.receive(FRAMES[0], 1).status, 'accepted')

  const result = session.receive(STATIC, 2)

  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') assert.equal(result.code, 'inconsistent_metadata')
})

test('NUT-16 rejects foreign, corrupt, mixed, and conflicting frames', () => {
  assert.equal(
    new Nut16UrDecoderSession(limits(), 0).receive(FRAMES[0].replace('bytes', 'crypto-psbt'), 1)
      .status,
    'rejected',
  )
  assert.equal(
    new Nut16UrDecoderSession(limits(), 0).receive(FRAMES[0].slice(0, -1) + 'x', 1).status,
    'rejected',
  )

  const mixed = new Nut16UrDecoderSession(limits(), 0)
  mixed.receive(FRAMES[0], 1)
  const mixedResult = mixed.receive(
    'ur:bytes/1-4/lpadaacsfxcywdtltlaagyhdfpiahsjkiskpfwiyinksjykpjpihdpjyhfykcthf',
    2,
  )
  assert.equal(mixedResult.status, 'rejected')
  if (mixedResult.status === 'rejected') assert.equal(mixedResult.code, 'conflicting_fragment')

  const inconsistent = new Nut16UrDecoderSession(limits(), 0)
  inconsistent.receive(FRAMES[0], 1)
  const inconsistentResult = inconsistent.receive(FRAMES[1].replace('/2-4/', '/2-5/'), 2)
  assert.equal(inconsistentResult.status, 'rejected')
})

test('NUT-16 rejects advertised size and fragment resource attacks before decode', () => {
  const tooLarge = new FountainEncoderPart(1, 1, NUT16_TOKEN_BYTES_LIMIT + 17, 1, Buffer.from([1]))
  const body = bytewords.encode(tooLarge.cbor().toString('hex'), bytewords.STYLES.MINIMAL)
  const result = new Nut16UrDecoderSession(limits(), 0).receive('ur:bytes/1-1/' + body, 1)
  assert.equal(result.status, 'rejected')
  if (result.status === 'rejected') assert.equal(result.code, 'inconsistent_metadata')

  const frameLimit = new Nut16UrDecoderSession(limits({ acceptedFrameLimit: 1 }), 0)
  assert.equal(frameLimit.receive(FRAMES[0], 1).status, 'accepted')
  const limited = frameLimit.receive(FRAMES[1], 2)
  assert.equal(limited.status, 'rejected')
  if (limited.status === 'rejected') assert.equal(limited.code, 'resource_limit')
  assert.equal(frameLimit.storedFrames, 0)
})

test('NUT-16 counts identical observed frames before parsing and rejects at the limit', () => {
  const session = new Nut16UrDecoderSession(limits({ acceptedFrameLimit: 3 }), 0)

  assert.equal(session.receive(FRAMES[0], 1).status, 'accepted')
  assert.equal(session.receive(FRAMES[0], 2).status, 'ignored')
  assert.equal(session.receive(FRAMES[0], 3).status, 'ignored')

  const rejected = session.receive(FRAMES[0], 4)
  assert.equal(rejected.status, 'rejected')
  if (rejected.status === 'rejected') assert.equal(rejected.code, 'resource_limit')
  assert.equal(session.observedFrames, 4)
})

test('NUT-16 expires incomplete sessions and keeps bounded state', () => {
  const session = new Nut16UrDecoderSession(limits({ sessionLifetimeMs: 10 }), 0)
  assert.equal(session.receive(FRAMES[0], 1).status, 'accepted')
  const timedOut = session.expire(11)
  assert.equal(timedOut?.status, 'rejected')
  if (timedOut?.status === 'rejected') assert.equal(timedOut.code, 'session_timeout')
  assert.equal(session.storedFrames, 0)
})

test('NUT-16 package deep imports remain available at the pinned version', () => {
  assert.equal(typeof bytewords.decode, 'function')
  assert.equal(typeof FountainEncoderPart.fromCBOR, 'function')
})
