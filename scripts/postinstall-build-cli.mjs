import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const initCwd = process.env.INIT_CWD ? resolve(process.env.INIT_CWD) : process.cwd()

if (realpathSync.native(initCwd) !== realpathSync.native(root)) {
  process.exit(0)
}

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build', '--workspace', '@bitcaster-market/cli'],
  { cwd: root, stdio: 'inherit' },
)

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
