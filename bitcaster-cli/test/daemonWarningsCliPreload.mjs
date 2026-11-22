import { registerHooks } from 'node:module'

// Each daemon call returns the fixed response of the test. No socket opens.
const rpcSource = `
  const response = () => JSON.parse(process.env.BITCASTER_TEST_DAEMON_RESPONSE)
  export class DaemonNotReachableError extends Error {}
  export function preventDaemonAutoStart() {}
  export function configureDaemonLaunchSettings() {}
  export async function callDaemon() { return response() }
  const unexpected = () => { throw Error('Unexpected daemon I/O') }
  export const daemonLogPath = unexpected, daemonSocketPath = unexpected,
    isCliSpawnedDaemonRunning = unexpected, isNetworkFailure = unexpected,
    restartDaemon = unexpected, stopDaemon = unexpected, submitOrderWithProgress = unexpected,
    watchDaemonToOutput = unexpected
`

registerHooks({
  load(url, context, nextLoad) {
    if (/\/bitcaster-cli\/(src\/rpc\.ts|dist\/rpc\.js)$/.test(new URL(url).pathname)) {
      return { format: 'module', source: rpcSource, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
