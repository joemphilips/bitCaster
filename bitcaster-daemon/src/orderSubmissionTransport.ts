import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OrderQuotesRefreshingProgress } from '@bitcaster-market/client-sdk/engineClient'
import {
  DAEMON_ORDER_SUBMISSION_MEDIA_TYPE,
  DAEMON_ORDER_SUBMISSION_FRAME_BYTES_MAX,
  type DaemonResponse,
  type OrderSubmissionFrame,
} from './protocol.ts'

/** One mutating dispatch. Disconnect stops waiting, not custody recovery. */
export async function serveOrderSubmission(
  req: IncomingMessage,
  res: ServerResponse,
  streaming: boolean,
  dispatch: (
    signal: AbortSignal,
    onWaiting: (progress: OrderQuotesRefreshingProgress) => void,
  ) => Promise<DaemonResponse>,
): Promise<void> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const close = () => {
    if (!res.writableEnded) abort()
  }
  req.once('aborted', abort)
  res.once('close', close)
  let count = 0
  let total = 0
  const write = (frame: OrderSubmissionFrame) => {
    if (controller.signal.aborted) return
    const line = JSON.stringify(frame) + '\n'
    const size = Buffer.byteLength(line)
    total += size
    if (
      ++count > 31 ||
      size > DAEMON_ORDER_SUBMISSION_FRAME_BYTES_MAX ||
      total > 2 * DAEMON_ORDER_SUBMISSION_FRAME_BYTES_MAX
    ) {
      controller.abort()
      res.destroy()
      return
    }
    if (!res.write(line) && frame.type !== 'result') {
      // Do not retain a queue of progress behind a stopped reader.
      controller.abort()
      res.destroy()
    }
  }
  if (req.aborted || res.destroyed) abort()
  if (streaming)
    res.writeHead(200, {
      'content-type': DAEMON_ORDER_SUBMISSION_MEDIA_TYPE,
      'cache-control': 'no-store',
    })
  try {
    const response = await dispatch(controller.signal, (progress) => {
      if (streaming) write({ type: 'quotes-refreshing', ...progress })
    })
    if (!controller.signal.aborted) {
      if (streaming) {
        write({ type: 'result', response })
        if (!res.destroyed) res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response))
      }
    }
  } catch {
    if (!controller.signal.aborted) {
      const response: DaemonResponse = {
        ok: false,
        error:
          'Order submission status is uncertain; check the original order and recovery status.',
      }
      if (streaming) {
        write({ type: 'result', response })
        if (!res.destroyed) res.end()
      } else {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response))
      }
    }
  } finally {
    req.removeListener('aborted', abort)
    res.removeListener('close', close)
  }
}
