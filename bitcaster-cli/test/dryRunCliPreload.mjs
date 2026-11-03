// Record every network request from a CLI child process. A dry run must make none.
// Answer daemon RPCs so that a command that ignores --dry-run completes its real action.
import { appendFileSync } from 'node:fs'

const log = (entry) =>
  appendFileSync(process.env.BITCASTER_TEST_FETCH_LOG, `${JSON.stringify(entry)}\n`)

const daemonResults = {
  'market.funding.quote': {
    grossFundingMsat: 8_000,
    sendPreparationFeeMsat: 2,
    estimatedRecipientReceiveFeeMsat: 0,
    totalWalletDebitMsat: 8_002,
    netFundingMsat: 8_000,
  },
  'market.funding.head': null,
  'market.fund': {
    deliveryId: 'delivery-1',
    transferId: '00000000-0000-4000-8000-000000000001',
    state: 'credited',
  },
}

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.pathname !== '/rpc') {
    log({ url: url.href, httpMethod: init?.method ?? 'GET' })
    throw new TypeError('fetch failed')
  }
  const command = JSON.parse(String(init?.body ?? 'null'))
  log({ url: url.href, method: command.method })
  const result = Object.hasOwn(daemonResults, command.method)
    ? daemonResults[command.method]
    : { method: command.method }
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// Relay traffic uses the global WebSocket. Record and refuse every connection.
globalThis.WebSocket = class {
  constructor(url) {
    log({ websocket: String(url) })
    throw new Error('Unexpected WebSocket connection in the dry-run fixture')
  }
}
