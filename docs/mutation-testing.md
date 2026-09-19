# Bounded mutation testing

This repository uses StrykerJS 10.0.0 for two Phase 4A profiles. The profiles
use one worker and write local HTML and JSON reports. Do not commit reports.

## SDK profile

Run the normal selected test from the repository root:

```bash
npm run test:mutation:sdk:baseline
```

Run mutation testing for `bitcaster-client-sdk/src/marketUnits.ts`:

```bash
npm run test:mutation:sdk
```

The command runner executes
`bitcaster-client-sdk/test/marketUnits.test.ts` for every mutant. The profile
sets `coverageAnalysis` to `off` because the command runner cannot select tests
by coverage. It does not use `testFiles`.

## App profile

Run the normal selected test with the application Vitest configuration:

```bash
npm run test:mutation:app:baseline
```

Run mutation testing for `bitCaster-app/src/lib/formatAmount.ts`:

```bash
npm run test:mutation:app
```

The profile loads the application config through a small path adapter. The
adapter imports the existing `bitCaster-app/vitest.config.ts`, keeps
`bitCaster-app` as the Vitest root, and resolves its workspace-relative setup
file from the public root. It keeps the application `jsdom` environment, setup
file, and SDK source aliases. It selects only
`bitCaster-app/src/lib/__tests__/formatAmount.test.ts`.

Reports are under `reports/mutation/stryker-js/{sdk,app}/`. Reproduce a
survivor by checking its source location and replacement in the JSON report,
then run the matching baseline command after applying the replacement in a
disposable copy. Mutation runs do not replace ordinary tests or browser tests.

Daemon, CLI, backup-service, and other production targets are not configured
in this bounded Phase 4A slice. Do not treat these profiles as a repository-wide
baseline.
