import path from 'node:path'
import appConfig from './bitCaster-app/vitest.config.ts'

// Load the application's real Vitest config, then preserve its app root so
// `/src` aliases resolve inside bitCaster-app when Stryker runs at the public
// repository root. Resolve the workspace-relative setup file from that root.
export default {
  ...appConfig,
  root: path.resolve('bitCaster-app'),
  test: {
    ...appConfig.test,
    setupFiles: appConfig.test?.setupFiles?.map((file) => path.resolve('bitCaster-app', file)),
  },
}
