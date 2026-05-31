import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [root] = process.argv.slice(2)

if (!root) {
  throw new Error('Usage: node scripts/rewrite-dts-imports.mjs <dist-dir>')
}

for (const file of await dtsFiles(root)) {
  const original = await readFile(file, 'utf8')
  const updated = original.replace(
    /(from\s+['"]\.[^'"]*)\.ts(['"])/g,
    '$1.js$2',
  )
  if (updated !== original) {
    await writeFile(file, updated)
  }
}

async function dtsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return dtsFiles(path)
      if (entry.isFile() && entry.name.endsWith('.d.ts')) return [path]
      return []
    }),
  )
  return files.flat()
}
