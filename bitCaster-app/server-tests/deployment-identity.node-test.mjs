import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureDeploymentIdentity, deploymentIdentityHandler } from '../deployment-identity.js'

const valid = { schemaVersion: 1, component: 'frontend', buildId: 'a'.repeat(64) }
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'deployment-identity-'))
  try {
    run(directory, join(directory, 'deployment-identity.json'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
function response(identity) {
  const observed = {}
  const sink = {
    setHeader: (name, value) => {
      observed[name] = value
    },
    status: (value) => {
      observed.status = value
      return sink
    },
    json: (value) => {
      observed.body = value
    },
  }
  deploymentIdentityHandler(identity)({}, sink)
  return observed
}

test('captures exactly the startup package identity and never rereads replaced files', () =>
  fixture((directory, file) => {
    writeFileSync(file, JSON.stringify(valid))
    const captured = captureDeploymentIdentity(directory)
    writeFileSync(file, JSON.stringify({ ...valid, buildId: 'b'.repeat(64) }))
    assert.deepEqual(response(captured), { 'Cache-Control': 'no-store', status: 200, body: valid })
    assert.ok(Object.isFrozen(captured))
    assert.equal(captureDeploymentIdentity(directory).buildId, 'b'.repeat(64))
  }))

test('missing identity remains a fixed unavailable response after later file creation', () =>
  fixture((directory, file) => {
    const captured = captureDeploymentIdentity(directory)
    writeFileSync(file, JSON.stringify(valid))
    assert.deepEqual(response(captured), {
      'Cache-Control': 'no-store',
      status: 503,
      body: { error: 'deployment-identity-unavailable' },
    })
  }))

test('rejects malformed, duplicate, unknown, wrong-component and oversized identity files', () =>
  fixture((directory, file) => {
    for (const content of [
      '',
      '{',
      'null',
      '[]',
      JSON.stringify({ ...valid, component: 'api' }),
      JSON.stringify({ ...valid, schemaVersion: 2 }),
      JSON.stringify({ ...valid, extra: 'private' }),
      JSON.stringify({ ...valid, buildId: 'A'.repeat(64) }),
      JSON.stringify({ ...valid, buildId: 'a'.repeat(63) }),
      '{"schemaVersion":2,' + JSON.stringify(valid).slice(1),
      '{"schema\\u0056ersion":2,' + JSON.stringify(valid).slice(1),
      '{"schemaVersion":{"nested":"private"},' + JSON.stringify(valid).slice(1),
      ' '.repeat(1025) + JSON.stringify(valid),
      Buffer.from([0xff]),
    ]) {
      writeFileSync(file, content)
      assert.equal(captureDeploymentIdentity(directory), null)
      assert.equal(response(captureDeploymentIdentity(directory)).status, 503)
    }
  }))

test('accepts reordered escaped keys but rejects non-regular marker paths', () =>
  fixture((directory, file) => {
    writeFileSync(
      file,
      '{"buildId":"' + valid.buildId + '","component":"frontend","schema\\u0056ersion":1}',
    )
    assert.deepEqual(captureDeploymentIdentity(directory), valid)
    rmSync(file)
    mkdirSync(file)
    assert.equal(captureDeploymentIdentity(directory), null)
  }))
