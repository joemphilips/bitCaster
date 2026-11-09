import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeOracleAnnouncementTags,
  normalizeLegacyOracleAnnouncementTags,
} from '../src/oracleAnnouncementTags.ts'

test('new oracle announcement tags preserve exact description whitespace and Unicode title rules', () => {
  for (const [title, description, expectedTitle, expectedDescription] of [
    [
      '  Rain\n\t tomorrow? ',
      '\r\n A  forecast\t market. ',
      'Rain tomorrow?',
      '\r\n A  forecast\t market. ',
    ],
    ['☀'.repeat(200), 'Long '.repeat(101), '☀'.repeat(200), 'Long '.repeat(101)],
    ['🌦'.repeat(200), 'No truncation', '🌦'.repeat(200), 'No truncation'],
    ['', '', '', ''],
  ]) {
    assert.deepEqual(normalizeOracleAnnouncementTags(title, description), {
      title: expectedTitle,
      description: expectedDescription,
    })
  }
})

const markdownDescription =
  '  ## 判定条件\r\n\r\n- 第一条件  \n\t- 例外: A  B\n\n```text\n  keep  spaces\n```\n'
test('new signed description source is byte-identical to multiline Markdown input', () => {
  const tags = normalizeOracleAnnouncementTags('Title', markdownDescription)
  assert.equal(tags.description, markdownDescription)
  assert.deepEqual(
    new TextEncoder().encode(tags.description),
    new TextEncoder().encode(markdownDescription),
  )
})

test('legacy replay alone retains collapsed description and 100-codepoint title', () => {
  const title = '🌦'.repeat(101)
  const legacy = normalizeLegacyOracleAnnouncementTags(title, markdownDescription)
  assert.equal(legacy.title, '🌦'.repeat(100))
  assert.equal(legacy.description, '## 判定条件 - 第一条件 - 例外: A B ```text keep spaces ```')
  assert.equal(
    normalizeOracleAnnouncementTags(title, markdownDescription).description,
    markdownDescription,
  )
})
