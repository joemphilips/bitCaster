import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeOracleAnnouncementTags } from '../src/oracleAnnouncementTags.ts'

test('oracle announcement tags preserve browser whitespace and Unicode title rules', () => {
  for (const [title, description, expectedTitle, expectedDescription] of [
    [
      '  Rain\n\t tomorrow? ',
      '\r\n A  forecast\t market. ',
      'Rain tomorrow?',
      'A forecast market.',
    ],
    ['☀'.repeat(101), 'Long '.repeat(101), '☀'.repeat(100), 'Long '.repeat(101).trim()],
    ['🌦'.repeat(101), 'No truncation', '🌦'.repeat(100), 'No truncation'],
    ['', '', '', ''],
  ]) {
    assert.deepEqual(normalizeOracleAnnouncementTags(title, description), {
      title: expectedTitle,
      description: expectedDescription,
    })
  }
})
