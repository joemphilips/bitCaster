#!/usr/bin/env python3
"""Fail closed on new secret candidates in one explicit Git commit range."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import tarfile
import tempfile
import urllib.request

VERSION = "8.30.1"
ARCHIVE_SHA256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
BINARY_SHA256 = "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509"
URL = f"https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/gitleaks_{VERSION}_linux_x64.tar.gz"
MAX_COMMITS = 4096
MAX_ENTRIES = 50000
MAX_SOURCE_BYTES = 1024 * 1024 * 1024
MAX_OUTPUT_BYTES = 32 * 1024 * 1024
OID = re.compile(r"[0-9a-f]{40}")


def environment():
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("GIT_", "GITLEAKS_"))}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
               GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0",
               GIT_OPTIONAL_LOCKS="0", GIT_NO_REPLACE_OBJECTS="1",
               GOMAXPROCS="4", GOMEMLIMIT="2GiB")
    return env


def limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def run(command, timeout=30, input_bytes=None, reject_stderr=False):
    # Private files bound captured output. Never forward subprocess diagnostics.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        with subprocess.Popen(command, env=environment(), stdin=subprocess.PIPE,
                              stdout=stdout, stderr=stderr, start_new_session=True,
                              preexec_fn=limits) as process:
            try:
                process.communicate(input=input_bytes, timeout=timeout)
            except BaseException:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate()
                raise
        if stdout.tell() >= MAX_OUTPUT_BYTES or stderr.tell() >= MAX_OUTPUT_BYTES:
            raise ValueError("Command output exceeded the limit")
        if reject_stderr and stderr.tell():
            raise ValueError("Scanner reported an error")
        stdout.seek(0)
        return process.returncode, stdout.read()


def git(repo, *args, input_bytes=None):
    code, output = run(["git", "-c", "core.fsmonitor=false", "-C", str(repo), *args],
                       input_bytes=input_bytes)
    if code:
        raise ValueError("Git verification failed")
    return output


def commit(repo, value):
    if not isinstance(value, str) or not OID.fullmatch(value) or value == "0" * 40:
        raise ValueError("An explicit full nonzero commit ID is required")
    if git(repo, "rev-parse", "--verify", value + "^{commit}").decode().strip() != value:
        raise ValueError("Commit identity is not exact")
    return value


def select_range(repo, event_name, event, candidate, explicit_base=""):
    candidate = commit(repo, candidate)
    if git(repo, "rev-parse", "HEAD").decode().strip() != candidate:
        raise ValueError("The checkout does not match the candidate")
    if event_name == "pull_request":
        if explicit_base:
            raise ValueError("A pull request cannot override its event base")
        pr = event["pull_request"]
        base = commit(repo, pr["base"]["sha"])
        head = commit(repo, pr["head"]["sha"])
        bases = git(repo, "merge-base", "--all", base, head).decode().splitlines()
        if len(bases) != 1:
            raise ValueError("The pull request has no unique merge base")
        merge_base = commit(repo, bases[0])
        if candidate == head:
            base = merge_base
        else:
            parents = git(repo, "rev-list", "--parents", "-n", "1", candidate).decode().split()
            if parents != [candidate, base, head]:
                raise ValueError("The candidate is not the exact event merge")
            # Exclude unrelated target-base history but include the merge result.
            head = candidate
    elif event_name == "push":
        head = commit(repo, event["after"])
        if head != commit(repo, candidate):
            raise ValueError("The push candidate differs from its event")
        before = event["before"]
        if explicit_base and before != "0" * 40 and explicit_base != before:
            raise ValueError("A push cannot replace its event base")
        base = commit(repo, explicit_base or before)
    elif event_name == "workflow_dispatch":
        head, base = commit(repo, candidate), commit(repo, explicit_base)
    else:
        raise ValueError("Unsupported event; an explicit supported event is required")
    git(repo, "merge-base", "--is-ancestor", base, head)
    if base == head:
        raise ValueError("The range is empty; choose the reviewed predecessor")
    if git(repo, "rev-parse", "--is-shallow-repository").strip() != b"false":
        raise ValueError("Shallow history cannot verify the range")
    return base, head


def inspect_range(repo, base, head):
    commits = git(repo, "rev-list", f"--max-count={MAX_COMMITS + 1}", f"{base}..{head}").decode().splitlines()
    if not commits or len(commits) > MAX_COMMITS:
        raise ValueError("The commit range exceeds the supported bound")
    # Bound the full size of every changed source blob, including repeated edits.
    # Names stay as NUL-delimited bytes and are never paths opened by this tool.
    blobs, gitlinks, entries = [], 0, 0
    changes = {oid: {} for oid in commits}
    for oid in commits:
        raw = git(repo, "diff-tree", "--root", "--no-commit-id", "-r", "--raw", "-z",
                  "--no-renames", "--no-ext-diff", "--no-textconv",
                  "--diff-merges=first-parent", oid).split(b"\0")
        if raw[-1] != b"" or (len(raw) - 1) % 2:
            raise ValueError("Unexpected Git path framing")
        for index in range(0, len(raw) - 1, 2):
            entries += 1
            if entries > MAX_ENTRIES:
                raise ValueError("Changed entries exceed the supported bound")
            fields = raw[index].split()
            if len(fields) != 5 or not fields[0].startswith(b":"):
                raise ValueError("Unexpected Git change metadata")
            mode, new_oid = fields[1], fields[3]
            if mode == b"160000":
                gitlinks += 1
            elif mode in (b"100644", b"100755", b"120000"):
                if not OID.fullmatch(new_oid.decode()):
                    raise ValueError("Unexpected blob identity")
                blobs.append(new_oid)
                # Strict UTF-8: the scanner reports an invalid byte as U+FFFD, which
                # can name another path. Refuse such a path, not guess its blob.
                changes[oid][raw[index + 1].decode()] = new_oid.decode()
            elif mode != b"000000":
                raise ValueError("Unsupported Git entry mode")
    objects = [oid.encode() for oid in commits] + blobs
    if objects:
        rows = git(repo, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                   input_bytes=b"\n".join(objects) + b"\n").splitlines()
        if len(rows) != len(objects):
            raise ValueError("Blob inventory is incomplete")
        total = 0
        for index, (expected, row) in enumerate(zip(objects, rows)):
            oid, kind, size = row.split()
            if oid != expected or kind != (b"commit" if index < len(commits) else b"blob"):
                raise ValueError("Blob identity mismatch")
            total += int(size)
            if total > MAX_SOURCE_BYTES:
                raise ValueError("Changed source exceeds the supported bound")
    return changes, gitlinks


def install_scanner(directory):
    archive = directory / "scanner.tar.gz"
    # One official release archive. Do not execute an installer or extract paths.
    with urllib.request.urlopen(URL, timeout=60) as response:
        data = response.read(MAX_OUTPUT_BYTES + 1)
    if len(data) > MAX_OUTPUT_BYTES or hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise ValueError("Scanner archive checksum mismatch")
    archive.write_bytes(data)
    with tarfile.open(archive) as source:
        members = [m for m in source.getmembers() if m.name == "gitleaks"]
        if len(members) != 1 or not members[0].isfile() or members[0].size > MAX_OUTPUT_BYTES:
            raise ValueError("Invalid scanner archive")
        binary = source.extractfile(members[0]).read(MAX_OUTPUT_BYTES + 1)
    scanner = directory / "gitleaks"
    scanner.write_bytes(binary)
    scanner.chmod(0o700)
    validate_scanner(scanner)
    return scanner


def validate_scanner(scanner):
    if scanner.is_symlink() or not scanner.is_file():
        raise ValueError("Scanner must be a regular file")
    with scanner.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != BINARY_SHA256:
            raise ValueError("Scanner binary checksum mismatch")
    code, output = run([str(scanner), "version"])
    if code or output.decode().strip() != VERSION:
        raise ValueError("Scanner version mismatch")


FINDING_FIELDS = ("RuleID", "Blob", "File", "StartLine", "EndLine", "StartColumn", "EndColumn")
MAX_REVIEW_BYTES = 64 * 1024
MAX_REVIEW_ROWS = 128


def relative_path(value):
    if (not isinstance(value, str) or not value or len(value) > 1024
            or value.startswith("/") or "\\" in value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError("The reviewed finding path is invalid")
    return value


def finding_key(finding):
    if not isinstance(finding, dict):
        raise ValueError("Finding metadata is invalid")
    rule = finding.get("RuleID")
    blob = finding.get("Blob")
    if (not isinstance(rule, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", rule)
            or not isinstance(blob, str) or not OID.fullmatch(blob) or blob == "0" * 40):
        raise ValueError("Finding metadata is invalid")
    relative_path(finding.get("File"))
    for field in FINDING_FIELDS[3:]:
        value = finding.get(field)
        if type(value) is not int or not 1 <= value <= 2147483647:
            raise ValueError("Finding location is invalid")
    if (finding["EndLine"] < finding["StartLine"]
            or (finding["EndLine"] == finding["StartLine"]
                and finding["EndColumn"] < finding["StartColumn"])):
        raise ValueError("Finding location is invalid")
    return tuple(finding[field] for field in FINDING_FIELDS)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate reviewed finding field")
        result[key] = value
    return result


def reviewed_findings(repo, head, path):
    if path is None:
        return frozenset()
    relative_path(path)
    # Inspect the candidate tree, not an uncommitted file or a symlink target.
    rows = git(repo, "ls-tree", "-z", head, "--", path).split(b"\0")
    if len(rows) != 2 or rows[-1] != b"":
        raise ValueError("The reviewed finding blob is missing")
    metadata, actual_path = rows[0].split(b"\t", 1)
    mode, kind, oid = metadata.decode().split()
    if mode not in ("100644", "100755") or kind != "blob" or actual_path.decode() != path:
        raise ValueError("The reviewed finding entry is not a regular blob")
    if int(git(repo, "cat-file", "-s", oid)) > MAX_REVIEW_BYTES:
        raise ValueError("Reviewed findings exceed the byte bound")
    raw = git(repo, "cat-file", "blob", oid)
    if len(raw) > MAX_REVIEW_BYTES:
        raise ValueError("Reviewed findings exceed the byte bound")
    value = json.loads(raw, object_pairs_hook=unique_object)
    if (not isinstance(value, dict) or set(value) != {"schema_version", "findings"}
            or type(value["schema_version"]) is not int or value["schema_version"] != 2
            or not isinstance(value["findings"], list) or len(value["findings"]) > MAX_REVIEW_ROWS):
        raise ValueError("Reviewed findings have an unsupported schema")
    keys = set()
    for row in value["findings"]:
        if not isinstance(row, dict) or set(row) != set(FINDING_FIELDS) | {"rationale", "review"}:
            raise ValueError("Reviewed finding fields are invalid")
        for field in ("rationale", "review"):
            text = row[field]
            if (not isinstance(text, str) or not 1 <= len(text) <= 1024
                    or any(ord(char) < 32 or ord(char) == 127 for char in text)):
                raise ValueError("Reviewed finding rationale is invalid")
        key = finding_key(row)
        if key in keys:
            raise ValueError("Duplicate reviewed finding")
        keys.add(key)
    return frozenset(keys)


def counts(findings, reviewed):
    matched = sum(finding_key(finding) in reviewed for finding in findings)
    return len(findings), matched, len(findings) - matched


def scan_findings(repo, scanner, base, head, changes, private):
    config, ignore, report = (private / name for name in ("rules.toml", "empty.ignore", "report.json"))
    config.write_text('[extend]\nuseDefault = true\n')
    ignore.write_text("")
    # Gitlinks are excluded. A gitlink patch also removes the commit from later files.
    code, _ = run([str(scanner), "git", str(repo),
                   f"--log-opts={base}..{head} --full-history --diff-merges=first-parent --text --no-renames --no-ext-diff --no-textconv --ignore-submodules=all",
                   "--config", str(config), "--gitleaks-ignore-path", str(ignore),
                   "--ignore-gitleaks-allow", "--redact=100", "--no-banner", "--no-color",
                   "--log-level=error", "--report-format=json", "--report-path", str(report),
                   "--exit-code=10", "--timeout=300"], timeout=330, reject_stderr=True)
    if code not in (0, 10) or not report.is_file() or report.stat().st_size >= MAX_OUTPUT_BYTES:
        raise ValueError("Scanner did not complete")
    findings = json.loads(report.read_bytes())
    if not isinstance(findings, list) or bool(findings) != (code == 10):
        raise ValueError("Scanner result is inconsistent")
    for finding in findings:
        if (not isinstance(finding, dict) or finding.get("Secret") != "REDACTED"
                or finding.get("Commit") not in changes or not isinstance(finding.get("File"), str)):
            raise ValueError("Scanner attribution or redaction is incomplete")
        # A disposition binds the exact file content, so a merge or squash of it keeps the disposition.
        blob = changes[finding["Commit"]].get(finding["File"])
        if blob is None:
            raise ValueError("Scanner attribution or redaction is incomplete")
        finding["Blob"] = blob
    # Validate all location metadata before any disposition can apply.
    for finding in findings:
        finding_key(finding)
    return findings


def scan(repo, scanner, base, head, changes, private):
    return len(scan_findings(repo, scanner, base, head, changes, private))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--scanner", type=Path, help="Use the pinned local binary instead of downloading it")
    parser.add_argument("--event-name", required=True)
    parser.add_argument("--event-path", type=Path, required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--base", default="")
    parser.add_argument("--reviewed-findings", help="Exact reviewed disposition blob in the candidate tree")
    args = parser.parse_args()
    os.umask(0o077)
    def interrupted(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        repo = args.repo.resolve(strict=True)
        if Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve() != repo:
            raise ValueError("The repository root is not exact")
        if args.event_path.stat().st_size > 1024 * 1024:
            raise ValueError("Event payload exceeds the supported bound")
        event = json.loads(args.event_path.read_bytes())
        base, head = select_range(repo, args.event_name, event, args.head, args.base)
        changes, gitlinks = inspect_range(repo, base, head)
        reviewed = reviewed_findings(repo, head, args.reviewed_findings)
        with tempfile.TemporaryDirectory(prefix="incremental-secrets-") as directory:
            private = Path(directory)
            scanner = args.scanner.absolute() if args.scanner else install_scanner(private)
            validate_scanner(scanner)
            findings = scan_findings(repo, scanner, base, head, changes, private)
            total, reviewed_count, actionable = counts(findings, reviewed)
        print(f"Incremental secret check: {len(changes)} commits; {total} candidates; "
              f"{reviewed_count} reviewed; {actionable} actionable; {gitlinks} gitlink changes excluded.")
        return 1 if actionable else 0
    except (OSError, ValueError, KeyError, TypeError, UnicodeError, subprocess.TimeoutExpired,
            tarfile.TarError, KeyboardInterrupt):
        # Do not interpolate exceptions: they may contain source or provider data.
        print("Incremental secret check incomplete. Verify the event/base, bounds, and pinned scanner locally.")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
