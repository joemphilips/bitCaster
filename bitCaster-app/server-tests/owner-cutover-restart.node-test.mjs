import assert from 'node:assert/strict'
import { createServer } from 'vite'
import net from 'node:net'
import { chromium } from 'playwright'
import { schnorr } from '@noble/curves/secp256k1.js'
import test from 'node:test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkDist = resolve(appRoot, '../bitcaster-client-sdk/dist')
const importSdk = (name) => import(pathToFileURL(join(sdkDist, `${name}.js`)).href)
const [
  scopeSdk,
  routeSdk,
  proofSdk,
  discoverySdk,
  httpSdk,
  headSdk,
  serviceSdk,
  uploadSdk,
  receiptSdk,
] = await Promise.all([
  importSdk('encryptedWalletBackupOwnerScope'),
  importSdk('encryptedWalletBackupOwnerDelegatedServerCodec'),
  importSdk('encryptedWalletBackupOwnerRequestProof'),
  importSdk('encryptedWalletBackupOwnerDiscovery'),
  importSdk('encryptedWalletBackupOwnerHttpCodec'),
  importSdk('encryptedWalletBackupOwnerHead'),
  importSdk('encryptedWalletBackupOwnerServiceCodec'),
  importSdk('encryptedWalletBackupOwnerUpload'),
  importSdk('encryptedWalletBackupOwnerReceipt'),
])

const realm = 'backup.example'
const ownerSubject = 'restart-harness-owner'
const signingKeyId = 'cc'.repeat(16)
const signingKey = new Uint8Array(32).fill(0x44)
const signingPublicKey = hex(schnorr.getPublicKey(signingKey))
const lostResponseHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/server-tests/fixtures/owner-cutover-restart-page.ts"></script></body></html>`

test(
  'fresh Chromium page resumes a saved owner mutation with the exact bytes after a lost response',
  {
    timeout: 60_000,
  },
  async () => {
    const state = createRemoteState()
    const plugin = {
      name: 'owner-cutover-restart-test-harness',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
          if (pathname === '/__owner_cutover_restart_fixture') {
            response.statusCode = 200
            response.setHeader('content-type', 'text/html; charset=utf-8')
            response.end(lostResponseHtml)
            return
          }
          if (request.url?.startsWith('/v1/encrypted-wallet-backup/')) {
            void handleOwnerRequest(request, response, state)
            return
          }
          next()
        })
      },
    }
    const vite = await createServer({
      configFile: resolve(appRoot, 'vite.config.ts'),
      root: appRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: await reserveLoopbackPort(), strictPort: true },
      plugins: [plugin],
    })
    let browser
    let context
    try {
      await vite.listen()
      const address = vite.httpServer.address()
      assert.ok(address && typeof address !== 'string')
      const origin = `http://127.0.0.1:${address.port}`
      browser = await chromium.launch({ headless: true })
      context = await browser.newContext()
      const firstPage = await context.newPage()
      firstPage.on('pageerror', (error) => console.error('restart fixture page error', error))
      firstPage.on('console', (message) => {
        if (message.type() === 'error')
          console.error('restart fixture console error', message.text())
      })
      await firstPage.goto(
        `${origin}/__owner_cutover_restart_fixture?receiptKey=${signingPublicKey}`,
        {
          waitUntil: 'domcontentloaded',
          timeout: 10_000,
        },
      )
      await runPhaseAndWait(firstPage, 'first', state)
      assert.equal(
        await firstPage.evaluate(() => window.ownerCutoverResult),
        'prepared-after-lost-response',
      )
      assert.equal(state.mutationBodies.length, 1)
      assert.ok(state.firstMutationCommitted)
      await firstPage.close()

      const secondPage = await context.newPage()
      await secondPage.goto(
        `${origin}/__owner_cutover_restart_fixture?receiptKey=${signingPublicKey}`,
        {
          waitUntil: 'domcontentloaded',
          timeout: 10_000,
        },
      )
      await runPhaseAndWait(secondPage, 'restart', state)
      assert.equal(
        await secondPage.evaluate(() => window.ownerCutoverResult),
        'replayed-and-acknowledged',
      )
      assert.equal(state.mutationBodies.length, 2)
      assert.deepEqual(state.mutationBodies[1], state.mutationBodies[0])
      assert.equal(state.idempotentReplayCount, 1)
      assert.equal(state.walletId, state.initialWalletId)
    } finally {
      try {
        await context?.close()
      } finally {
        try {
          await browser?.close()
        } finally {
          await vite.close()
        }
      }
    }
  },
)

function createRemoteState() {
  return {
    owner: null,
    walletId: null,
    initialWalletId: null,
    currentHead: null,
    activeBundles: [],
    firstMutationCommitted: false,
    mutationBodies: [],
    savedReceiptWire: null,
    idempotentReplayCount: 0,
    requests: [],
    replayUnavailableSent: false,
  }
}

async function runPhaseAndWait(page, phase, remoteState) {
  await page.evaluate((selectedPhase) => {
    void window.runOwnerCutoverPhase(selectedPhase).catch((error) => {
      window.ownerCutoverFailure = error instanceof Error ? error.message : 'unknown phase failure'
    })
  }, phase)
  try {
    await page.waitForFunction(
      () => window.ownerCutoverFailure !== null || window.ownerCutoverResult !== null,
      undefined,
      { timeout: 20_000 },
    )
  } catch (error) {
    const state = await page.evaluate(() => ({
      result: window.ownerCutoverResult,
      failure: window.ownerCutoverFailure,
    }))
    throw new Error(
      `${error instanceof Error ? error.message : 'phase timeout'}; ` +
        `browser=${JSON.stringify(state)}; requests=${JSON.stringify(remoteState.requests)}; ` +
        `mutations=${remoteState.mutationBodies.length}; replays=${remoteState.idempotentReplayCount}`,
    )
  }
  const state = await page.evaluate(() => ({
    result: window.ownerCutoverResult,
    failure: window.ownerCutoverFailure,
  }))
  assert.equal(state.failure, null)
  return state
}

async function reserveLoopbackPort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return address.port
}

async function handleOwnerRequest(request, response, state) {
  try {
    const requestUrl = request.url ?? ''
    const parsed = new URL(requestUrl, `http://${request.headers.host}`)
    const match =
      /^\/v1\/encrypted-wallet-backup\/realms\/([^/]+)\/wallets\/([0-9a-f]{64})\/owners(?:\/([0-9a-f]{64}))?(.*)$/.exec(
        parsed.pathname,
      )
    if (!match || match[1] !== realm) return writeHttp(response, 404, new Uint8Array())
    const walletId = match[2]
    const routeOwnerScopeId = match[3] ?? null
    const suffix = match[4] ?? ''
    state.walletId ??= walletId
    state.initialWalletId ??= walletId
    if (state.walletId !== walletId) return writeHttp(response, 409, new Uint8Array())
    state.owner ??= {
      ...scopeSdk.deriveEncryptedWalletBackupOwnerScope({
        authorizationScheme: 'test',
        ownerSubject,
      }),
      enrollmentEpoch: 1,
    }
    state.currentHead ??= headSdk.createEncryptedWalletBackupOwnerCurrentHead({
      ownerScopeId: state.owner.ownerScopeId,
      realm,
      walletId,
      enrollmentEpoch: 1,
      headVersion: 0,
      bundles: [],
    })
    state.activeBundles ??= []

    const operation =
      routeOwnerScopeId === null
        ? 'owner-discovery'
        : suffix === '/enrollment-epoch'
          ? 'enrollment-epoch'
          : suffix === '/head'
            ? 'descriptor-page'
            : suffix === '/head:compare-and-swap'
              ? 'bundle-supersession'
              : null
    state.requests.push(operation ?? `unknown:${suffix}`)
    if (operation === null) return writeHttp(response, 404, new Uint8Array())
    const route = routeSdk.encryptedWalletBackupOwnerServerRoute({
      operation,
      realm,
      walletId,
      ...(operation === 'owner-discovery'
        ? { requestedCursor: parsed.searchParams.get('after') }
        : { ownerScopeId: routeOwnerScopeId }),
      ...(operation === 'descriptor-page' ? { afterBundleId: null } : {}),
    })
    const body = await readBody(request, 4_100_000)
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('BackupV1 '))
      return writeHttp(response, 401, new Uint8Array())
    const proofBytes = Buffer.from(authorization.slice('BackupV1 '.length), 'base64url')
    const proof = proofSdk.decodeEncryptedWalletBackupOwnerRequestProof(proofBytes)
    const verified = proofSdk.verifyEncryptedWalletBackupOwnerRequest({
      canonicalProof: proofBytes,
      route: route.context,
      expectedMethod: route.method,
      expectedUrl: `https://${realm}${requestUrl}`,
      payload: body,
      serverNowUnixSeconds: Math.floor(Date.now() / 1000),
    })
    let responseBody
    let responseKind
    let enrollmentEpoch = 0
    if (operation === 'owner-discovery') {
      responseBody = discoverySdk.encodeEncryptedWalletBackupOwnerDiscoveryPage({
        request: verified,
        entries: [state.owner],
        nextCursor: null,
      })
      responseKind = undefined
    } else if (operation === 'enrollment-epoch') {
      responseBody = httpSdk.encodeEncryptedWalletBackupOwnerEnrollmentEpochResult({
        result: 'active',
        enrollmentEpoch: 1,
      })
      responseKind = 'enrollment-epoch'
    } else if (operation === 'descriptor-page') {
      responseBody = serviceSdk.encodeEncryptedWalletBackupOwnerDescriptorPage({
        head: state.currentHead,
        afterBundleId: null,
        bundles: state.activeBundles,
        nextAfterBundleId: null,
      })
      responseKind = 'descriptor-page'
      enrollmentEpoch = 1
    } else {
      const context = {
        ownerScopeId: state.owner.ownerScopeId,
        realm,
        walletId,
        enrollmentEpoch: 1,
      }
      const group = uploadSdk.decodeEncryptedWalletBackupOwnerUploadGroup({
        bytes: body,
        expectedContext: context,
        expectedRequestAuthPublicKey: proof.requestAuthPublicKey,
      })
      const mutation = group.mutationEvidence.envelope.mutation
      let receiptWire
      if (state.savedReceiptWire !== null) {
        if (!Buffer.from(state.mutationBodies[0]).equals(Buffer.from(body)))
          return writeHttp(response, 409, new Uint8Array())
        if (!state.replayUnavailableSent) {
          state.replayUnavailableSent = true
          const errorBody = httpSdk.encodeEncryptedWalletBackupOwnerHttpError({
            operation: 'bundle-supersession',
            code: 'unavailable',
            retryAfterSeconds: null,
          })
          return writeHttp(response, 503, errorBody)
        }
        state.idempotentReplayCount += 1
        state.mutationBodies.push(Uint8Array.from(body))
        receiptWire = state.savedReceiptWire
      } else {
        const nextBundles = state.activeBundles.filter(
          ({ bundleId }) => !mutation.supersededBundleIds.includes(bundleId),
        )
        if (mutation.addedBundle !== null) nextBundles.push(mutation.addedBundle)
        const resultHead = headSdk.createEncryptedWalletBackupOwnerCurrentHead({
          ownerScopeId: state.owner.ownerScopeId,
          realm,
          walletId,
          enrollmentEpoch: 1,
          headVersion: state.currentHead.headVersion + 1,
          bundles: nextBundles,
        })
        const receipt = await receiptSdk.issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
          mutationEvidence: group.mutationEvidence,
          expectedContext: context,
          resultHead,
          signingKeyId,
          signingPublicKey,
          signDigest: async (digest) =>
            schnorr.sign(digest, signingKey, new Uint8Array(32).fill(0x55)),
        })
        receiptWire = serviceSdk.encodeEncryptedWalletBackupOwnerBundleSupersessionReceipt(receipt)
        state.currentHead = resultHead
        state.activeBundles = nextBundles
        state.savedReceiptWire = receiptWire
        state.mutationBodies.push(Uint8Array.from(body))
        state.firstMutationCommitted = true
      }
      responseBody = receiptWire
      responseKind = 'bundle-supersession-receipt'
      enrollmentEpoch = 1
      if (state.mutationBodies.length === 1 && !state.firstResponseLost) {
        state.firstResponseLost = true
        response.destroy()
        return
      }
    }
    const bytes =
      responseKind === undefined
        ? responseBody
        : httpSdk.encodeEncryptedWalletBackupOwnerHttpResponse({
            kind: responseKind,
            requestDigest: verified.requestDigest,
            ownerScopeId: state.owner.ownerScopeId,
            realm,
            walletId,
            enrollmentEpoch,
            body: responseBody,
          })
    writeHttp(response, 200, bytes)
  } catch (error) {
    console.error('owner restart fixture request failed', error)
    response.statusCode = 500
    response.setHeader('content-type', 'text/plain')
    response.end(error instanceof Error ? error.message : 'test server error')
  }
}

async function readBody(request, maximumBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maximumBytes) throw new Error('owner test request exceeds size limit')
    chunks.push(chunk)
  }
  return Uint8Array.from(Buffer.concat(chunks))
}

function writeHttp(response, status, body) {
  response.statusCode = status
  response.setHeader('content-type', 'application/cbor')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-length', body.byteLength)
  response.end(body)
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex')
}
