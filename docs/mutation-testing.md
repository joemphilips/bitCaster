# Bounded mutation testing

This repository uses StrykerJS 10.0.0 for bounded Phase 4A profiles. The profiles
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

## Daemon profile

Run the selected native test before mutation testing:

```bash
npm run test:mutation:daemon:baseline
```

Run mutation testing for `bitcaster-daemon/src/endpoint.ts`:

```bash
npm run test:mutation:daemon
```

The command runner imports `dataDirTestSetup.ts` and executes only the strict
native-config parser test. The selected test is pure and does not open a
socket. The parser exercises endpoint URL normalization in the
mutated daemon source.

## CLI profile

Run the selected native test before mutation testing:

```bash
npm run test:mutation:cli:baseline
```

Run mutation testing for `bitcaster-cli/src/config.ts`:

```bash
npm run test:mutation:cli
```

The command runner imports `dataDirTestSetup.ts` and executes only the existing
config-list test. That test starts `bitcaster-cli/src/main.ts` in a child
process, so the profile exercises the mutated TypeScript source instead of a
compiled CLI `dist` file. It does not open a socket.

Daemon and CLI reports are under
`reports/mutation/stryker-js/{daemon,cli}/`. Reproduce a survivor by checking
its source location and replacement in the JSON report, then run the matching
baseline command after applying the replacement in a disposable copy.

These profiles are representative runner proofs. They are not daemon or CLI
whole-project baselines. Other source files remain unassessed in this phase.
