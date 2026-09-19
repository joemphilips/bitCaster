/** @type {import('@stryker-mutator/api/core').StrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  mutate: ['bitCaster-app/src/lib/formatAmount.ts'],
  ignorePatterns: ['cdk/**', '.worktrees/**', '.stryker-tmp*/**'],
  testFiles: ['bitCaster-app/src/lib/__tests__/formatAmount.test.ts'],
  vitest: {
    configFile: 'stryker.app.vitest.config.ts',
    related: false,
  },
  reporters: ['clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/stryker-js/app/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/stryker-js/app/mutation.json' },
  concurrency: 1,
  timeoutMS: 30_000,
  cleanTempDir: true,
  tempDirName: '.stryker-tmp',
  thresholds: { high: 100, low: 0, break: 0 },
}
