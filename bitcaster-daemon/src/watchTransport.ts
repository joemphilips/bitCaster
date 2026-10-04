import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import {
  DAEMON_WATCH_FRAME_BYTES_MAX,
  DAEMON_WATCH_MEDIA_TYPE,
  type DaemonWatchCommand,
  type DaemonWatchEvent,
  type DaemonWatchFrame,
} from './protocol.ts'

/** Providers must release their subscription when the signal aborts or return() runs. */
export type DaemonWatchProvider = (
  command: DaemonWatchCommand,
  signal: AbortSignal,
) => AsyncIterable<DaemonWatchEvent> | Promise<AsyncIterable<DaemonWatchEvent>>

export async function streamDaemonWatch(
  request: IncomingMessage,
  response: ServerResponse,
  command: DaemonWatchCommand,
  provider?: DaemonWatchProvider,
): Promise<void> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  response.once('close', abort)
  request.once('aborted', abort)
  response.once('error', abort)
  let iterator: AsyncIterator<DaemonWatchEvent> | undefined
  let returned = false
  const cleanup = async () => {
    if (iterator === undefined || returned) return
    returned = true
    try {
      await iterator.return?.()
    } catch {
      /* Subscription errors are not safe wire errors. */
    }
  }
  response.writeHead(200, { 'content-type': DAEMON_WATCH_MEDIA_TYPE, 'cache-control': 'no-store' })
  try {
    if (provider === undefined) {
      await writeFrame(
        response,
        { type: 'error', code: 'watch-unavailable', error: 'daemon watch is unavailable' },
        controller.signal,
      )
      return
    }
    await awaitAbortable(
      Promise.resolve(provider(command, controller.signal)).then((source) => {
        iterator = source[Symbol.asyncIterator]()
        if (controller.signal.aborted) void cleanup()
      }),
      controller.signal,
    )
    while (!controller.signal.aborted) {
      const next = await awaitAbortable(Promise.resolve(iterator!.next()), controller.signal)
      if (next.done) {
        await writeFrame(response, { type: 'complete' }, controller.signal)
        return
      }
      await writeFrame(response, next.value, controller.signal)
    }
  } catch {
    if (!controller.signal.aborted) {
      await writeFrame(
        response,
        { type: 'error', code: 'watch-failed', error: 'daemon watch failed' },
        controller.signal,
      ).catch(() => undefined)
    }
  } finally {
    const cancelled = controller.signal.aborted
    controller.abort()
    request.removeListener('aborted', abort)
    response.removeListener('close', abort)
    response.removeListener('error', abort)
    // Explicit ownership avoids a second return() from a for-await loop on cancellation.
    if (cancelled) void cleanup()
    else await cleanup()
    if (!response.destroyed) response.end()
  }
}

async function writeFrame(
  response: ServerResponse,
  frame: DaemonWatchFrame,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const line = JSON.stringify(frame) + '\n'
  if (Buffer.byteLength(line) > DAEMON_WATCH_FRAME_BYTES_MAX)
    throw new Error('daemon watch frame exceeds byte limit')
  if (!response.write(line)) await once(response, 'drain', { signal })
}
