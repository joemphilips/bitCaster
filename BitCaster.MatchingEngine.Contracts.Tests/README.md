# Contract mutation probe

This project tests public contracts without private engine dependencies.
The initial test checks canonical enum casing. It is not a complete contract
test suite or mutation baseline.

Run the normal test from the public repository root:

```bash
dotnet test BitCaster.MatchingEngine.Contracts.Tests/ -- RunConfiguration.MaxCpuCount=2
```

Install the pinned mutation tool in a separate local directory:

```bash
dotnet tool install dotnet-stryker --version 5.0.0 --tool-path /tmp/bitcaster-contracts-stryker
```

Run the profile from this test directory:

```bash
cd BitCaster.MatchingEngine.Contracts.Tests
/tmp/bitcaster-contracts-stryker/dotnet-stryker -f stryker-config.json
```

The profile targets the handwritten enum converter on `net10.0`.
It uses one worker and stops if the initial test fails.
Reports are in `StrykerOutput/<run>/reports/`. This directory is not tracked.
The score does not block the run. Review survivors before changing tests.
Other contract behavior and consumer tests remain separate assessment work.
