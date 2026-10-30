import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const strykerRequire = createRequire(require.resolve('@stryker-mutator/core/package.json'))
const ownerRequire = createRequire(strykerRequire.resolve('typed-rest-client/package.json'))
const { getUrl } = ownerRequire('./Util.js')
const qs = ownerRequire('qs')
const baseUrl = 'https://example.invalid/path'
const bounded = { timeout: 1_000 }

// Resolve from the consumer: testing a hoisted sibling would miss its exact pin.
test('typed-rest-client resolves the reviewed qs correction', bounded, () => {
  assert.equal(ownerRequire('qs/package.json').version, '6.16.1')
})

test('URL construction preserves absent and empty query behavior', bounded, () => {
  assert.equal(getUrl(baseUrl), baseUrl)
  assert.equal(getUrl(`${baseUrl}?`, undefined, { params: {} }), baseUrl)
  assert.equal(getUrl(`${baseUrl}?`, undefined, { params: { page: 1 } }), `${baseUrl}?page=1`)
})

test('default queries preserve repeat arrays, scalar values, and encoding', bounded, () => {
  assert.equal(
    getUrl(baseUrl, undefined, {
      params: { tag: ['a b', 'c+'], n: 0, ok: false, empty: '', nil: null, omit: undefined },
    }),
    `${baseUrl}?tag=a%20b&tag=c%2B&n=0&ok=false&empty=&nil=`,
  )
})

test('owner options preserve dotted keys and custom separators', bounded, () => {
  assert.equal(
    getUrl(baseUrl, undefined, {
      params: { user: { name: 'a b' }, page: 2 },
      options: { shouldAllowDots: true, separator: ';' },
    }),
    `${baseUrl}?user.name=a%20b;page=2`,
  )
  // The owner's existing `value || true` mapping keeps value-only encoding.
  assert.equal(
    getUrl(baseUrl, undefined, {
      params: { user: { name: 'a b' } },
      options: { shouldOnlyEncodeValues: false },
    }),
    `${baseUrl}?user[name]=a%20b`,
  )
})

for (const [arrayFormat, expected] of [
  ['indices', '?a[0]=x%20y&a[1]=z'],
  ['brackets', '?a[]=x%20y&a[]=z'],
  ['comma', '?a=x%20y,z'],
]) {
  test(`owner preserves ${arrayFormat} array formatting`, bounded, () => {
    assert.equal(
      getUrl(baseUrl, undefined, { params: { a: ['x y', 'z'] }, options: { arrayFormat } }),
      `${baseUrl}${expected}`,
    )
  })
}

for (const [isBuffer, expected] of [
  ['x', '?a[constructor][isBuffer]=x'],
  [true, '?a[constructor][isBuffer]=true'],
  [{ b: 'c' }, '?a[constructor][isBuffer][b]=c'],
]) {
  test(`owner serializes non-callable isBuffer data (${typeof isBuffer})`, bounded, () => {
    assert.equal(
      getUrl(baseUrl, undefined, { params: { a: { constructor: { isBuffer } } } }),
      `${baseUrl}${expected}`,
    )
  })
}

for (const [name, values, expected] of [
  ['mixed', ['x y', null, undefined, 'z'], '?a=x%20y,,,z'],
  ['nullish', [null, undefined], '?a=,'],
  ['empty', [], ''],
]) {
  test(`owner comma arrays accept ${name} elements`, bounded, () => {
    assert.equal(
      getUrl(baseUrl, undefined, { params: { a: values }, options: { arrayFormat: 'comma' } }),
      `${baseUrl}${expected}`,
    )
  })
}

// Util does not call parse. This verifies the resolved package's advisory fix,
// without claiming a query-parser exposure in typed-rest-client.
test('owner-resolved qs refuses an oversized bracketed comma array', bounded, () => {
  assert.throws(
    () => qs.parse('a[]=1,2,3', { comma: true, arrayLimit: 2, throwOnLimitExceeded: true }),
    RangeError,
  )
})

test('owner-resolved qs accepts the bracketed comma array at its limit', bounded, () => {
  assert.deepEqual(
    qs.parse('a[]=1,2,3', { comma: true, arrayLimit: 3, throwOnLimitExceeded: true }),
    {
      a: [['1', '2', '3']],
    },
  )
})
