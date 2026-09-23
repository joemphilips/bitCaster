/** @type {import('@stryker-mutator/api/core').StrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: {
    command:
      'node --experimental-strip-types --import ./bitcaster-daemon/test/dataDirTestSetup.ts --test --test-name-pattern="strict native config rejects malformed" bitcaster-daemon/test/nativeConfig.test.ts',
  },
  mutate: ['bitcaster-daemon/src/endpoint.ts'],
  ignorePatterns: ['cdk/**', 'dlcdevkit/**', '.worktrees/**', '.stryker-tmp*/**'],
  reporters: ['clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/stryker-js/daemon/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/stryker-js/daemon/mutation.json' },
  concurrency: 1,
  timeoutMS: 30_000,
  cleanTempDir: true,
  tempDirName: '.stryker-tmp',
  // The command runner cannot map tests to files. Run the selected native
  // Node test for every mutant so coverage is explicit and reproducible.
  coverageAnalysis: 'off',
  thresholds: { high: 100, low: 0, break: 0 },
}
