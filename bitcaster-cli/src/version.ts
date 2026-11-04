import { readFileSync } from 'node:fs'

/**
 * The release packaging writes this file next to package.json. It holds the
 * source commit. A build from a clone has no such file.
 */
export const BUILD_INFO_FILE = 'build-info.json'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/

/**
 * Return the text that `--version` prints. A release build adds the first 12
 * hex digits of the source commit as semver build metadata.
 */
export function cliVersion(packageVersion: string, buildInfoJson: string | null): string {
  if (buildInfoJson === null) return packageVersion
  return `${packageVersion}+${parseBuildCommit(buildInfoJson).slice(0, 12)}`
}

export function readCliVersion(packageRoot: URL): string {
  const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
    version?: string
  }
  let buildInfo: string | null = null
  try {
    buildInfo = readFileSync(new URL(BUILD_INFO_FILE, packageRoot), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return cliVersion(manifest.version ?? '0.0.0', buildInfo)
}

// A damaged file must not make the CLI report a false source commit.
function parseBuildCommit(text: string): string {
  let info: unknown
  try {
    info = JSON.parse(text)
  } catch {
    throw new Error(`${BUILD_INFO_FILE} is not valid JSON`)
  }
  if (typeof info !== 'object' || info === null || Array.isArray(info)) {
    throw new Error(`${BUILD_INFO_FILE} is not an object`)
  }
  const keys = Object.keys(info)
  const commit = (info as { commit?: unknown }).commit
  if (keys.length !== 1 || typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    throw new Error(`${BUILD_INFO_FILE} must hold only a 40-digit lowercase hex commit`)
  }
  return commit
}
