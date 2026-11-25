import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const PUBLIC_ROOT = join(import.meta.dirname, '..', '..')

// A new operation must use the bind that refuses a record without room for its result. These callers
// must not refuse: each one saves an operation after an effect, or without a mint request.
const EXEMPT = [
  'bitCaster-app/src/lib/browserCtfRangeOrderCoordinator.ts',
  'bitcaster-client-sdk/src/durableCustodyProofImport.ts',
  'bitcaster-client-sdk/src/durableCustodyProofOperationRecord.ts',
  'bitcaster-daemon/src/ctfRangeCoordinator.ts',
]

test('each new custody operation uses the bind that checks its size', async () => {
  const callers: string[] = []
  for (const directory of [
    'bitcaster-client-sdk/src',
    'bitcaster-daemon/src',
    'bitCaster-app/src/lib',
  ]) {
    for (const name of await readdir(join(PUBLIC_ROOT, directory))) {
      if (!name.endsWith('.ts')) continue
      const source = await readFile(join(PUBLIC_ROOT, directory, name), 'utf8')
      const calls = source.match(/\bbindDurableCustodyProofOperation\(/g)?.length ?? 0
      if (calls > 0) callers.push(`${directory}/${name}`)
      if (name === 'browserCtfRangeOrderCoordinator.ts') assert.equal(calls, 1)
    }
  }
  assert.deepEqual(callers.sort(), EXEMPT)
})
