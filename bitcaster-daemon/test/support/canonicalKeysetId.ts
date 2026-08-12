import { createHash } from 'node:crypto'

export function canonicalTestKeysetId(label: string): string {
  return `01${createHash('sha256').update(label).digest('hex')}`
}
