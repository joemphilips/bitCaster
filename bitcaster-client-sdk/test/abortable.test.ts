import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { awaitAbortable } from '../src/engineClient.ts'

test('pre-aborted caller still observes a late operation rejection', async () => {
  const controller = new AbortController()
  controller.abort()
  let rejectOperation: ((error: Error) => void) | undefined
  const operation = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject
  })
  await assert.rejects(awaitAbortable(operation, controller.signal), /request aborted/)
  rejectOperation!(new Error('late fixture rejection'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('abortable success, failure and cancellation remove their abort listener', async () => {
  const success = new AbortController()
  assert.equal(await awaitAbortable(Promise.resolve(3), success.signal), 3)
  assert.equal(getEventListeners(success.signal, 'abort').length, 0)
  const failed = new AbortController()
  await assert.rejects(
    awaitAbortable(Promise.reject(new Error('fixture failure')), failed.signal),
    /fixture failure/,
  )
  assert.equal(getEventListeners(failed.signal, 'abort').length, 0)
  const cancelled = new AbortController()
  let rejectOperation: ((error: Error) => void) | undefined
  const operation = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject
  })
  const pending = awaitAbortable(operation, cancelled.signal)
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 1)
  cancelled.abort()
  await assert.rejects(pending, /request aborted/)
  rejectOperation!(new Error('late fixture rejection'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0)
})
