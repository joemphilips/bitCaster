import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

// Record the external I/O of the CLI in a log, and do none of it.
const log = process.env.BITCASTER_TEST_TRUST_LOG
const record = (value) => appendFileSync(log, `${JSON.stringify(value)}\n`)

// The engine and the mint are external services.
globalThis.fetch = async (input) => {
  record({ action: 'fetch', url: String(input) })
  throw new Error('the test sends no request')
}

// A daemon start is the spawn of `bitcaster-daemon run`.
childProcess.spawn = (_command, args) => {
  record({ action: 'spawn', args })
  throw new Error('the test starts no daemon')
}
syncBuiltinESMExports()
