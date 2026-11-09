export function normalizeOracleAnnouncementTags(title: string, description: string) {
  return {
    title: plainText(title),
    description: plainText(description),
  }
}

function plainText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
