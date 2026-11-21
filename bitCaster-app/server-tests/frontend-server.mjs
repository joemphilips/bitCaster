import { once } from 'node:events'
import net from 'node:net'

export const deadline = 5000

/**
 * Starts ../server.js on a free port with the given environment settings.
 * Returns the server module and its listening instance. The caller closes the instance.
 */
export async function startFrontendServer(env) {
  Object.assign(process.env, { ...env, PORT: '0' })
  // The server listens when it is imported. Keep its instance to read the assigned port and to close it.
  let frontend
  const listen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    frontend = this
    return listen.apply(this, args)
  }
  let server
  try {
    server = await import('../server.js')
  } finally {
    net.Server.prototype.listen = listen
  }
  if (!frontend.listening)
    await once(frontend, 'listening', { signal: AbortSignal.timeout(deadline) })
  return { frontend, server }
}
