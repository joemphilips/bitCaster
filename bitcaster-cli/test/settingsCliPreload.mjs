import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { updateNativeConfig } from '../../bitcaster-daemon/dist/nativeConfig.js'

const directory = process.env.BITCASTER_TEST_SETTINGS_DIRECTORY
const log = process.env.BITCASTER_TEST_SETTINGS_LOG
const record = (value) => appendFileSync(log, `${JSON.stringify(value)}\n`)
let raced = false

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  assert.ok(['/v1/info', '/v1/keys', '/v1/keysets'].includes(url.pathname))
  assert.ok(init?.method === undefined || init.method === 'GET')
  assert.equal(new Headers(init?.headers).has('authorization'), false)
  record({ action: 'metadata', url: url.toString() })
  if (process.env.BITCASTER_TEST_SETTINGS_RACE === '1' && !raced) {
    raced = true
    updateNativeConfig(
      (config) => ({
        ...config,
        daemon: { ...config.daemon, nostrRelays: ['wss://competing.example'] },
      }),
      { directory },
    )
  }
  const keyset = {
    id: `01${'ab'.repeat(32)}`,
    unit: process.env.BITCASTER_TEST_SETTINGS_UNIT ?? 'msat',
    active: true,
    input_fee_ppk: 0,
  }
  const response =
    url.pathname === '/v1/info'
      ? {
          name: 'Mint',
          pubkey: 'ab'.repeat(32),
          version: '2.0',
          contact: [],
          nuts: { 4: { methods: [], disabled: false }, 5: { methods: [], disabled: false } },
        }
      : { keysets: url.pathname === '/v1/keys' ? [{ ...keyset, keys: { 1: 'key' } }] : [keyset] }
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const rpcSource = `
  import { appendFileSync, readFileSync } from 'node:fs'
  import { join } from 'node:path'
  const record = (value) => appendFileSync(process.env.BITCASTER_TEST_SETTINGS_LOG, JSON.stringify(value) + '\\n')
  export class DaemonNotReachableError extends Error {}
  export async function isCliSpawnedDaemonRunning() {
    record({ action: 'running-check' })
    return process.env.BITCASTER_TEST_SETTINGS_RUNNING === '1'
  }
  export async function restartDaemon() {
    record({ action: 'restart', config: JSON.parse(readFileSync(join(process.env.BITCASTER_TEST_SETTINGS_DIRECTORY, 'config.json'), 'utf8')) })
  }
  const unexpected = () => { throw Error('Unexpected RPC or daemon I/O') }
  export const callDaemon = unexpected, daemonLogPath = unexpected, isNetworkFailure = unexpected,
    stopDaemon = unexpected, watchDaemonToOutput = unexpected
`

registerHooks({
  load(url, context, nextLoad) {
    if (/\/bitcaster-cli\/(src\/rpc\.ts|dist\/rpc\.js)$/.test(new URL(url).pathname)) {
      return { format: 'module', source: rpcSource, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
