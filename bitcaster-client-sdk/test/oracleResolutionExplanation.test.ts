import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  createOracleExplanationTemplate,
  readSignedOracleEvent,
  verifyOracleResolutionExplanation,
} from '../src/oracleResolutionExplanation.ts'
import {
  oracleFixture,
  oracleTestKey,
  otherOracleTestKey,
  signedExplanation,
} from './fixtures/oraclePublication.ts'

test('real signed NIP-22 explanation binds the exact 88 root and 89 parent', () => {
  const { context, announcement, attestation } = oracleFixture()
  const content = '<b>Plain text</b> **not Markdown**'
  const template = createOracleExplanationTemplate(context, content, 1_700_000_002)
  assert.deepEqual(template.tags, [
    ['E', announcement.id, '', announcement.pubkey],
    ['K', '88'],
    ['P', announcement.pubkey],
    ['e', attestation.id, '', announcement.pubkey],
    ['k', '89'],
    ['p', announcement.pubkey],
  ])
  const json = signedExplanation(context, content)
  const verified = verifyOracleResolutionExplanation(context, json)
  assert.equal(verified.content, content)
  assert.equal(verified.id, JSON.parse(json).id)
})

test('UTF-8 limit accepts 4096 bytes and refuses oversized multibyte content', () => {
  const { context } = oracleFixture()
  assert.equal(
    createOracleExplanationTemplate(context, '界'.repeat(1_365) + 'a', 1).content.length,
    1_366,
  )
  for (const content of ['界'.repeat(1_366), 'x'.repeat(4_097), '   '])
    assert.throws(() => createOracleExplanationTemplate(context, content, 1), /Explanation/)
  const oversized = finalizeEvent(
    {
      ...createOracleExplanationTemplate(context, 'valid', 1),
      content: '界'.repeat(1_366),
    },
    oracleTestKey,
  )
  assert.throws(
    () => verifyOracleResolutionExplanation(context, JSON.stringify(oversized)),
    /UTF-8/,
  )
})

test('valid signatures cannot authorize a foreign signer or ambiguous NIP-22 reference', () => {
  const { context } = oracleFixture()
  const template = createOracleExplanationTemplate(context, 'Result evidence', 1)
  const wrongSigner = finalizeEvent(template, otherOracleTestKey)
  assert.throws(
    () => verifyOracleResolutionExplanation(context, JSON.stringify(wrongSigner)),
    /signer/,
  )
  for (const [name, replacement] of [
    ['E', 'f'.repeat(64)],
    ['e', 'f'.repeat(64)],
    ['K', '89'],
    ['k', '88'],
    ['P', 'f'.repeat(64)],
    ['p', 'f'.repeat(64)],
  ]) {
    const tags = template.tags.map((tag) =>
      tag[0] === name ? [tag[0], replacement, ...tag.slice(2)] : tag,
    )
    assert.throws(
      () =>
        verifyOracleResolutionExplanation(
          context,
          JSON.stringify(finalizeEvent({ ...template, tags }, oracleTestKey)),
        ),
      /reference/,
    )
  }
  for (const tags of [
    [...template.tags, template.tags[0]],
    [...template.tags, ['a', 'another-parent']],
    template.tags.filter(([name]) => name !== 'p'),
    template.tags.map((tag) => (tag[0] === 'E' ? [tag[0], tag[1], '', 'f'.repeat(64)] : tag)),
  ])
    assert.throws(
      () =>
        verifyOracleResolutionExplanation(
          context,
          JSON.stringify(finalizeEvent({ ...template, tags }, oracleTestKey)),
        ),
      /reference|ambiguous/,
    )
})

test('wrong event kinds and changed NIP-01 fields fail signature validation', () => {
  const { context } = oracleFixture()
  const template = createOracleExplanationTemplate(context, 'Result evidence', 1)
  const wrongKind = finalizeEvent({ ...template, kind: 1 }, oracleTestKey)
  assert.throws(
    () => verifyOracleResolutionExplanation(context, JSON.stringify(wrongKind)),
    /invalid/,
  )
  const changed = JSON.parse(signedExplanation(context))
  changed.content = 'Changed after signing'
  assert.throws(
    () => verifyOracleResolutionExplanation(context, JSON.stringify(changed)),
    /signature/,
  )
  assert.throws(
    () => readSignedOracleEvent(JSON.stringify({ ...changed, created_at: -1 }), 1111),
    /invalid/,
  )
})

test('registered oracle and exact root context cannot be substituted', () => {
  const { context, announcement, attestation } = oracleFixture()
  const signed = signedExplanation(context)
  assert.throws(
    () => verifyOracleResolutionExplanation({ ...context, oraclePubkey: 'f'.repeat(64) }, signed),
    /signer/,
  )
  const replacementRoot = finalizeEvent(
    { kind: 88, created_at: 2, tags: [], content: announcement.content },
    oracleTestKey,
  )
  assert.throws(
    () =>
      verifyOracleResolutionExplanation(
        { ...context, announcementEventJson: JSON.stringify(replacementRoot) },
        signed,
      ),
    /announcement reference/,
  )
  const replacementParent = finalizeEvent(
    {
      kind: 89,
      created_at: 2,
      tags: attestation.tags,
      content: attestation.content,
    },
    oracleTestKey,
  )
  assert.throws(
    () =>
      verifyOracleResolutionExplanation(
        { ...context, attestationEventJson: JSON.stringify(replacementParent) },
        signed,
      ),
    /reference/,
  )
})
