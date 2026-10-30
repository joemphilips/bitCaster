import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const preload = fileURLToPath(new URL('./startupImportsPreload.mjs', import.meta.url))

// Exercise actual ESM resolution, not a textual import ban. A transitive eager
// import fails too. Help never invokes the configured profile or daemon action.
for (const command of [
  [],
  ['wallet', 'balance'],
  ['order', 'list'],
  ['signer', 'profile'],
  ['mint', 'list'],
  ['market', 'liked'],
]) {
  test(
    `help registers ${command.join(' ') || 'root'} without unrelated action modules`,
    { timeout: 10_000 },
    async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--experimental-strip-types', '--import', preload, main, ...command, '--help'],
        { timeout: 5_000, maxBuffer: 128 * 1024 },
      )
      assert.match(stdout, /Usage:/)
      assert.doesNotMatch(stdout, /"ok":false/)
    },
  )
}
