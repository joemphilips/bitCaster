/** @type {import('@stryker-mutator/api/core').StrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: {
    command: 'node --experimental-strip-types --test bitcaster-client-sdk/test/marketUnits.test.ts',
  },
  mutate: ['bitcaster-client-sdk/src/marketUnits.ts'],
  ignorePatterns: ['cdk/**', '.worktrees/**', '.stryker-tmp*/**'],
  reporters: ['clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/stryker-js/sdk/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/stryker-js/sdk/mutation.json' },
  concurrency: 1,
  timeoutMS: 30_000,
  cleanTempDir: true,
  tempDirName: '.stryker-tmp',
  // The command runner cannot map tests to files. Run the selected native
  // Node test file for every mutant so coverage is explicit and reproducible.
  coverageAnalysis: 'off',
  thresholds: { high: 100, low: 0, break: 0 },
}
