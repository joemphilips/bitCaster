import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  createTradeCommentTemplate,
  tradeCommentToWire,
  type TradeCommentTemplate,
} from '@bitcaster-market/client-sdk/tradeComment'

const KIND_HTTP_AUTH = 27235
const require = createRequire(import.meta.url)

export interface NostrIdentity {
  privateKeyHex: string
}

interface EventTemplate {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export function signNip98(
  identity: NostrIdentity,
  url: string,
  method: string,
  bodyText?: string,
  payloadHash?: string,
): string {
  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()],
  ]
  if (payloadHash !== undefined) {
    tags.push(['payload', payloadHash])
  } else if (bodyText !== undefined) {
    tags.push(['payload', sha256Hex(bodyText)])
  }
  const template: EventTemplate = {
    kind: KIND_HTTP_AUTH,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }
  const { finalizeEvent } = require('nostr-tools/pure') as {
    finalizeEvent: (template: EventTemplate, privateKey: Uint8Array) => Record<string, unknown>
  }
  const event = finalizeEvent(template, hexToBytes(identity.privateKeyHex))
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function signNativeTradeComment(
  identity: NostrIdentity,
  input: Parameters<typeof createTradeCommentTemplate>[0],
): ReturnType<typeof tradeCommentToWire> {
  const template = createTradeCommentTemplate(input)
  const { finalizeEvent } = require('nostr-tools/pure') as {
    finalizeEvent: (
      template: TradeCommentTemplate,
      privateKey: Uint8Array,
    ) => TradeCommentTemplate & { id: string; pubkey: string; sig: string }
  }
  return tradeCommentToWire(finalizeEvent(template, hexToBytes(identity.privateKeyHex)))
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error('invalid hex string')
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}
