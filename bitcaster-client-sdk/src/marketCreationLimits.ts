import {
  normalizeMarketCreationInput,
  marketCreationMintTags,
  type MarketCreationInput,
  type NormalizedMarketCreationInput,
} from './marketCreationInput.ts'

/** New-writer policy, separate from readers of retained or already paid creations. */
export interface MarketCreationTextPolicy {
  readonly titleCharacters: number
  readonly titleUtf8Bytes: number
  readonly descriptionCharacters: number
  readonly descriptionUtf8Bytes: number
  readonly mintTagsJsonBytes: number
}

export const CURRENT_MARKET_CREATION_TEXT_POLICY: MarketCreationTextPolicy = Object.freeze({
  titleCharacters: 100,
  titleUtf8Bytes: 400,
  descriptionCharacters: 1024,
  descriptionUtf8Bytes: 1024,
  mintTagsJsonBytes: 4096,
})

/** Requires compact-backup writer activation and compatible mint admission before use. */
export const COMPACT_MARKET_CREATION_TEXT_POLICY: MarketCreationTextPolicy = Object.freeze({
  titleCharacters: 200,
  titleUtf8Bytes: 800,
  descriptionCharacters: 2000,
  descriptionUtf8Bytes: 8192,
  mintTagsJsonBytes: 16384,
})

// Compatibility release: read compact backups, but retain v1 writers and current admission.
export const ACTIVE_MARKET_CREATION_TEXT_POLICY = CURRENT_MARKET_CREATION_TEXT_POLICY
export const MAX_MARKET_TITLE_CHARACTERS = ACTIVE_MARKET_CREATION_TEXT_POLICY.titleCharacters
export const MAX_MARKET_TITLE_UTF8_BYTES = ACTIVE_MARKET_CREATION_TEXT_POLICY.titleUtf8Bytes
export const MAX_MARKET_DESCRIPTION_CHARACTERS =
  ACTIVE_MARKET_CREATION_TEXT_POLICY.descriptionCharacters
export const MAX_MARKET_DESCRIPTION_UTF8_BYTES =
  ACTIVE_MARKET_CREATION_TEXT_POLICY.descriptionUtf8Bytes
export const MAX_MARKET_CREATION_MINT_TAGS_JSON_BYTES =
  ACTIVE_MARKET_CREATION_TEXT_POLICY.mintTagsJsonBytes

export type MarketCreationTextIssue = 'required' | 'invalid-unicode' | 'too-long' | 'too-many-bytes'
export interface MarketCreationTextInspection {
  readonly characters: number
  readonly utf8Bytes: number
  readonly issue: MarketCreationTextIssue | null
}

const encoder = new TextEncoder()

// TextEncoder replaces unpaired surrogates, while Rust's JSON reader refuses them.
// Detect invalid input before measuring so transport replacement cannot hide it.
function isWellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

function inspectText(
  value: string,
  charactersLimit: number,
  byteLimit: number,
): MarketCreationTextInspection {
  const characters = Array.from(value).length
  const utf8Bytes = encoder.encode(value).byteLength
  const issue = !isWellFormedUnicode(value)
    ? 'invalid-unicode'
    : value.trim().length === 0
      ? 'required'
      : characters > charactersLimit
        ? 'too-long'
        : utf8Bytes > byteLimit
          ? 'too-many-bytes'
          : null
  return { characters, utf8Bytes, issue }
}

/** Measure the exact raw metadata retained by the writer, including JSON escaping. */
export function inspectNewMarketCreationText(
  input: Pick<MarketCreationInput, 'title' | 'description' | 'categoryTags'>,
  policy: MarketCreationTextPolicy = ACTIVE_MARKET_CREATION_TEXT_POLICY,
) {
  const mintTagsJsonBytes = encoder.encode(JSON.stringify(marketCreationMintTags(input))).byteLength
  const mintTagsIssue: 'invalid-unicode' | 'too-large' | null = input.categoryTags.some(
    (tag) => !isWellFormedUnicode(tag),
  )
    ? 'invalid-unicode'
    : mintTagsJsonBytes > policy.mintTagsJsonBytes
      ? 'too-large'
      : null
  return {
    title: inspectText(input.title, policy.titleCharacters, policy.titleUtf8Bytes),
    description: inspectText(
      input.description,
      policy.descriptionCharacters,
      policy.descriptionUtf8Bytes,
    ),
    mintTagsJsonBytes,
    mintTagsIssue,
  }
}

/** New admission only. Never use this to reject or rewrite retained creation records. */
export function assertNewMarketCreationInput(
  input: MarketCreationInput,
  policy: MarketCreationTextPolicy = ACTIVE_MARKET_CREATION_TEXT_POLICY,
): NormalizedMarketCreationInput {
  const normalized = normalizeMarketCreationInput(input)
  const inspection = inspectNewMarketCreationText(input, policy)
  for (const field of ['title', 'description'] as const) {
    const issue = inspection[field].issue
    if (issue === 'invalid-unicode')
      throw new Error(`Market ${field} contains incomplete Unicode characters.`)
    if (issue) {
      const maxCharacters =
        field === 'title' ? policy.titleCharacters : policy.descriptionCharacters
      const maxBytes = field === 'title' ? policy.titleUtf8Bytes : policy.descriptionUtf8Bytes
      throw new Error(
        `Market ${field} must fit within ${maxCharacters} characters and ${maxBytes} UTF-8 bytes.`,
      )
    }
  }
  if (inspection.mintTagsIssue === 'invalid-unicode')
    throw new Error('Market categories contain incomplete Unicode characters.')
  if (inspection.mintTagsIssue)
    throw new Error(
      `Market title, description and categories exceed ${policy.mintTagsJsonBytes} serialized UTF-8 bytes.`,
    )
  return normalized
}
