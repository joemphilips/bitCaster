import { build } from 'esbuild'
import { createServer } from 'node:http'
import { chromium, firefox, webkit } from 'playwright'

const bundle = await build({
  entryPoints: [new URL('../test/browser/encryptedWalletBackupVector.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  write: false,
  sourcemap: false,
  logLevel: 'silent',
})
const source = new TextDecoder().decode(bundle.outputFiles[0].contents)
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><meta charset="utf-8"><title>backup vector</title>')
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (address === null || typeof address === 'string') throw new Error('browser vector server failed')

try {
  for (const [name, engine] of [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit],
  ]) {
    const browser = await engine.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(`http://127.0.0.1:${address.port}/`)
      await page.addScriptTag({ content: source })
      await page.waitForFunction(() => '__encryptedWalletBackupVectorResult' in globalThis)
      const result = await page.evaluate(() => globalThis.__encryptedWalletBackupVectorResult)
      if (!result.ok) throw new Error(`${name} SDK vector failed: ${result.error}`)
      process.stdout.write(
        `${name}: SDK encrypted wallet backup vector passed; `
        + `legacy512=${result.legacyRestoreMs.toFixed(1)}ms, `
        + `model50000=${result.modeledChunks} chunks/${result.modeledWorkSlices} slices\n`,
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
}
