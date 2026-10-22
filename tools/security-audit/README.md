# Incremental secret prevention

`incremental_secrets.py` checks new Git changes with the official Gitleaks
8.30.1 Linux x64 binary. It uses only Python 3.11 or later and Git. It has no
private repository dependency. The parent repository can run this tool from
its pinned public submodule.

The runner downloads one official release archive when `--scanner` is absent.
It verifies the archive and binary SHA-256 values before execution. The values
and release URL are fixed in the runner. It does not run an installer.
You can supply an existing verified binary with `--scanner /absolute/path`.
The runner checks that binary's hash and version again.

## Scope and event base

| Event                | Checked range                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| Pull request         | Event base through the verified synthetic merge, or unique merge base through a direct event-head checkout. |
| Existing branch push | Exact event `before` through exact event `after`.                                                           |
| New branch push      | Explicit reviewed `--base` through exact event `after`.                                                     |
| Manual run           | Explicit reviewed `--base` through the candidate `--head`.                                                  |

Use full, nonzero commit IDs. The candidate must equal the current checkout
HEAD. The base must be an ancestor of the candidate. A synthetic PR merge must
have exactly two parents in event base/head order. This includes changes in the
merge result without scanning unrelated target-branch history.
The tool rejects shallow history, missing objects, an empty range, ambiguous
merge bases, and unsupported events. It does not substitute `HEAD~1`, a branch
name, or a historic baseline. A normal push cannot override its event base.
A pull request cannot override its event base.

For `workflow_call`, GitHub retains the caller event. Manual deployment callers
must forward the `secret_scan_base` input. A new staging branch push also needs
an explicit reviewed base. An ordinary push obtains the base from its event.

```bash
python3 tools/security-audit/incremental_secrets.py \
  --repo . \
  --event-name "$GITHUB_EVENT_NAME" \
  --event-path "$GITHUB_EVENT_PATH" \
  --head "$GITHUB_SHA" \
  --base "${SECRET_SCAN_BASE:-}"
```

The tool examines added lines in each new commit, including merge-result
changes. A secret added and then removed within the range still fails. A
secret in an unchanged old line does not fail this incremental check. This
also applies when another line in that file changes. Renamed or copied content
can appear as a new addition and require review.

The check does not scan reachable history outside the range. It does not scan
uncommitted files. It does not inspect nested submodule contents. It counts
changed gitlinks and reports their exclusion. Each repository needs its own
check. A parent gitlink update is not proof that a fork's new contents passed
this check. Keep the separate reviewed fork and submodule pinning gates.

## Failure and privacy

The independent CI job runs for documentation-only changes too. The parent
required-checks job requires its success even when product checks are skipped.
The public job is standalone. Require the public `secret-check` status in the
repository's merge rules. Workflow code alone does not configure those rules.

The job has read-only repository access. Checkout does not persist credentials.
The job runs no package installer, repository build, or submodule install
script. It uses no `pull_request_target` event or secret-bearing token.
The runner never fetches Git objects. Checkout obtains history before the run.

Repository Gitleaks configuration, ignore files, and inline allow comments
cannot suppress findings. The runner uses pinned upstream default rules and
an explicit empty ignore file. Those default rules retain their upstream
built-in exclusions. This is a pattern detector, not proof that no secret
exists. It does not detect all Cashu tokens, seed phrases, or encoded secrets.
Review those data types at their owning security boundary.

There is no blanket fixture or documentation exemption. If a new fixture
matches, inspect it locally and change it to synthetic data assembled at
runtime. If that is not practical, propose an exact, reviewed fixture rule
with a negative test for real credentials. Do not bypass the job or allow an
entire directory. An existing PR can expose matching fixtures introduced
within its range even if those fixtures predate this job.

The runner prints counts and constant error messages only. It discards process
diagnostics and never publishes raw scanner reports, source paths, or matched
values. Temporary files use private permissions. Cleanup runs on success,
failure, timeout, interrupt, and SIGTERM. A machine crash or SIGKILL can leave
private temporary files. Do not upload them. CI runners are disposable.

The bounds are 4,096 commits, 50,000 changed entries, 256 MiB of changed blobs
and commit metadata, and 32 MiB per process output/report. Blob sizes count
repeated edits. Each Git command has a 30-second timeout. The scanner has a
300-second timeout and a 330-second process timeout. The CI job has a ten-minute
timeout. Exceeding a bound fails the check; it does not silently skip content.
The Go memory target is a soft limit, not an operating-system memory cap.

| Exit | Meaning                                        |
| ---- | ---------------------------------------------- |
| 0    | The selected range has no detected candidates. |
| 1    | New candidates require local review.           |
| 2    | The selected range was not completely checked. |

## Regression tests

```bash
GITLEAKS_TEST_BINARY=/absolute/path/to/pinned/gitleaks \
  python3 -m unittest discover -s tools/security-audit \
  -p test_incremental_secrets.py -v
```

The real-scanner regression creates a temporary repository. Its token is a
public synthetic value that was never issued. It verifies new documentation
secrets, add-then-delete commits, merge-only additions, unchanged old fixtures,
suppression bypass, binary Git attributes, safe output, and cleanup. The other
tests check base selection, bounds, path framing, binary pinning, and failures.
Without `GITLEAKS_TEST_BINARY`, the real-scanner regression is skipped. Run it
before publication. These tests do not scan the project's historical content.
