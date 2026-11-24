import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deadline, startFrontendServer } from './frontend-server.mjs'

// The server runs from a copy whose parent directory name starts with a dot, as under ~/.local or a
// .claude worktree. The copy finds the app dependencies and the hoisted workspace dependencies through
// node_modules links at the same levels.
const app = fileURLToPath(new URL('..', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'frontend-server-'))
const served = join(scratch, '.hidden', 'app')
await mkdir(served, { recursive: true })
for (const file of ['server.js', 'content-security-policy.js', 'deployment-identity.js'])
  await copyFile(join(app, file), join(served, file))
await writeFile(join(served, 'index.html'), '<!doctype html><div id="root"></div>')
await symlink(join(app, 'node_modules'), join(served, 'node_modules'), 'dir')
const workspaceModules = join(app, '..', 'node_modules')
if (
  await stat(workspaceModules).then(
    (entry) => entry.isDirectory(),
    () => false,
  )
)
  await symlink(workspaceModules, join(scratch, '.hidden', 'node_modules'), 'dir')

let frontend
after(async () => {
  frontend?.closeAllConnections()
  if (frontend) await new Promise((resolve) => frontend.close(resolve))
  await rm(scratch, { recursive: true, force: true })
})
;({ frontend } = await startFrontendServer({}, pathToFileURL(join(served, 'server.js'))))

test('a client route gets the app document when a parent directory name starts with a dot', async () => {
  for (const path of ['/', '/markets', '/markets/some-market/trade']) {
    const response = await fetch(`http://127.0.0.1:${frontend.address().port}${path}`, {
      signal: AbortSignal.timeout(deadline),
    })
    assert.equal(response.status, 200, path)
    assert.match(await response.text(), /<div id="root">/, path)
  }
})
