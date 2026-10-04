export function normalizeOracleAnnouncementTags(title: string, description: string) {
  return {
    title: Array.from(plainText(title)).slice(0, 100).join(''),
    description: plainText(description),
  }
}

function plainText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
