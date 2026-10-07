export const CTF_LISTING_PAGE_SIZE = 100

export function readCtfListingCursor(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error('Mint returned an invalid CTF continuation cursor')
  }
  return value
}

/** Collect a complete registry before returning metadata to a cache or a caller. */
export async function collectCtfListing<T>(input: {
  fetchPage: (cursor?: string) => Promise<{ items: readonly T[]; next_cursor: unknown }>
  getId: (item: T) => string
  maxRecords: number
  maxPages: number
}): Promise<T[]> {
  if (
    !Number.isSafeInteger(input.maxRecords) ||
    input.maxRecords < 0 ||
    !Number.isSafeInteger(input.maxPages) ||
    input.maxPages <= 0
  ) {
    throw new Error('CTF listing bounds are invalid')
  }
  const items = new Map<string, T>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let count = 0
  for (let pageNumber = 0; pageNumber < input.maxPages; pageNumber += 1) {
    const page = await input.fetchPage(cursor)
    if (!Array.isArray(page.items) || page.items.length > CTF_LISTING_PAGE_SIZE) {
      throw new Error('Mint exceeded the CTF listing page limit')
    }
    count += page.items.length
    if (count > input.maxRecords) throw new Error('Mint exceeded the CTF listing record limit')
    const nextCursor = readCtfListingCursor(page.next_cursor)
    if (nextCursor !== null && cursors.has(nextCursor)) {
      throw new Error('Mint CTF pagination did not advance')
    }
    for (const item of page.items) {
      const id = input.getId(item)
      if (typeof id !== 'string' || id.length === 0)
        throw new Error('Mint returned an invalid CTF listing ID')
      if (items.has(id) && JSON.stringify(items.get(id)) !== JSON.stringify(item)) {
        throw new Error('Mint returned conflicting CTF listing metadata')
      }
      items.set(id, item)
    }
    if (nextCursor === null) return [...items.values()]
    cursors.add(nextCursor)
    cursor = nextCursor
  }
  throw new Error('Mint exceeded the CTF listing page bound')
}
