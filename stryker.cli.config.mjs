/** @type {import('@stryker-mutator/api/core').StrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: {
    command:
      'node --experimental-strip-types --import ./bitcaster-daemon/test/dataDirTestSetup.ts --test --test-name-pattern="config list does not rewrite already sanitized config" bitcaster-cli/test/cli.test.ts',
  },
  mutate: ['bitcaster-cli/src/config.ts'],
  reporters: ['clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/stryker-js/cli/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/stryker-js/cli/mutation.json' },
  concurrency: 1,
  maxTestRunnerReuse: 1,
  timeoutMS: 30_000,
  cleanTempDir: true,
  tempDirName: '.stryker-tmp',
  // The command runner cannot map tests to files. Run the selected native
  // Node test for every mutant so coverage is explicit and reproducible.
  coverageAnalysis: 'off',
  thresholds: { high: 100, low: 0, break: 0 },
}
