import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { chromiumLaunchOptions, isChromiumSandboxEnabled } from '../playwright-launch.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bounded = { timeout: 30_000 }
// The test states the CI opt-out rule independently of the helper.
const expectSandbox = !process.env.CI

test('the Chromium sandbox is off only when CI is set', bounded, () => {
  assert.equal(isChromiumSandboxEnabled({}), true)
  assert.equal(isChromiumSandboxEnabled({ CI: '' }), true)
  assert.equal(isChromiumSandboxEnabled({ CI: 'true' }), false)
  assert.equal(isChromiumSandboxEnabled({ CI: '1' }), false)
})

test('launch options keep caller options and set the sandbox policy', bounded, () => {
  assert.deepEqual(chromiumLaunchOptions({ headless: true }, {}), {
    headless: true,
    chromiumSandbox: true,
  })
  assert.deepEqual(chromiumLaunchOptions({}, { CI: 'true' }), { chromiumSandbox: false })
  assert.throws(() => chromiumLaunchOptions({ args: ['--no-sandbox'] }, {}), /--no-sandbox/)
})

test('Chromium launched with the options reports its sandbox state', bounded, async () => {
  // The headless shell has no chrome:// pages. Full Chromium reports the
  // sandbox layers that Playwright's launch options control.
  const browser = await chromium.launch(
    chromiumLaunchOptions({ headless: true, channel: 'chromium' }),
  )
  try {
    const page = await browser.newPage()
    await page.goto('chrome://sandbox')
    const status = await page.locator('body').innerText()
    assert.match(status, /Sandbox Status/)
    assert.equal(status.includes('You are adequately sandboxed.'), expectSandbox)
  } finally {
    await browser.close()
  }
})

test('every tracked Playwright launcher uses the shared launch options', bounded, () => {
  const playwrightImport =
    /(?:^|\n)\s*import\s+(?!type\b)[^'"]*?from\s*['"](?:playwright|playwright-core|@playwright\/test|@vitest\/browser-playwright)['"]|(?:require|import)\(\s*['"](?:playwright|playwright-core|@playwright\/test|@vitest\/browser-playwright)['"]\s*\)/
  const owned = new Set([
    'scripts/playwright-launch.mjs',
    'scripts/tests/playwright-launch.test.mjs',
  ])
  const sourcePatterns = ['*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs']
  // Git excludes node_modules and the third-party submodule contents.
  const listing = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--']
  const sources = execFileSync('git', [...listing, ...sourcePatterns], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file && !owned.has(file))
    .map((file) => ({ file, text: readFileSync(resolve(root, file), 'utf8') }))
  const launchers = sources.filter(({ text }) => playwrightImport.test(text))
  assert.ok(launchers.length > 0, 'the scan found no Playwright launcher')
  const missing = launchers
    .filter(({ text }) => !text.includes('playwright-launch.mjs'))
    .map(({ file }) => file)
  assert.deepEqual(missing, [])
})
