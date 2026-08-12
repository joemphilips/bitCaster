import { build } from 'esbuild'
import { chromium, firefox, webkit } from 'playwright'

const bundle = await build({
  entryPoints: [
    new URL('../test/browser/encryptedWalletBackupVector.ts', import.meta.url).pathname,
  ],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  write: false,
  sourcemap: false,
  logLevel: 'silent',
})
const source = new TextDecoder().decode(bundle.outputFiles[0].contents)
const vectorUrl = 'https://browser-vector.test/'
const vectorPage = '<!doctype html><meta charset="utf-8"><title>backup vector</title>'

for (const [name, engine] of [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]) {
  const browser = await engine.launch({ headless: true })
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route(vectorUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: vectorPage,
      }),
    )
    const page = await context.newPage()
    await page.goto(vectorUrl)
    await page.addScriptTag({ content: source })
    await page.waitForFunction(() => '__encryptedWalletBackupVectorResult' in globalThis)
    const result = await page.evaluate(() => globalThis.__encryptedWalletBackupVectorResult)
    if (!result.ok) throw new Error(`${name} SDK vector failed: ${result.error}`)
    process.stdout.write(
      `${name}: SDK encrypted wallet backup vector passed; ` +
        `legacy512=${result.legacyRestoreMs.toFixed(1)}ms, ` +
        `model50000=${result.modeledChunks} chunks/${result.modeledWorkSlices} slices\n`,
    )
  } finally {
    await browser.close()
  }
}
