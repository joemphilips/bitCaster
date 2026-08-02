import { homedir } from 'node:os'
import { resolve } from 'node:path'

let selectedDataDir: string | undefined
let testDataDirSource: (() => string | undefined) | undefined

export function configureDataDir(path: string | undefined): void {
  if (path !== undefined && path.trim().length === 0) {
    throw new Error('data directory must not be empty')
  }
  const normalized = path === undefined ? resolve(homedir(), '.bitcaster') : resolve(path)
  if (selectedDataDir !== undefined && selectedDataDir !== normalized) {
    throw new Error(`data directory is already set to ${selectedDataDir}`)
  }
  selectedDataDir = normalized
}

export function dataDir(): string {
  if (selectedDataDir !== undefined) return selectedDataDir
  const testPath = testDataDirSource?.()
  if (testPath !== undefined && testPath.trim().length > 0) return resolve(testPath)
  throw new Error('data directory is not configured')
}

/** Install a dynamic directory source for in-process tests. */
export function configureDataDirForTest(source: () => string | undefined): void {
  if (process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error('test data-directory injection requires the Node test runner')
  }
  testDataDirSource = source
}
