import hashlib
import contextlib
import io
import sys
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("incremental_secrets", Path(__file__).with_name("incremental_secrets.py"))
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL).decode().strip()


def save(repo, name, text):
    path = repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    git(repo, "add", "--", name)
    git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "public synthetic fixture")
    return git(repo, "rev-parse", "HEAD")


class IncrementalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.email", "fixture@example.invalid")
        git(self.repo, "config", "user.name", "Synthetic fixture")
        self.base = save(self.repo, "old.txt", "old fixture\n")
        self.head = save(self.repo, "docs/readme.md", "new prose\n")

    def select(self, event_name="workflow_dispatch", event=None, base=None):
        return scanner.select_range(self.repo, event_name, event or {}, self.head,
                                    self.base if base is None else base)

    def test_manual_requires_exact_nonzero_base(self):
        self.assertEqual(self.select(), (self.base, self.head))
        for invalid in ["", "main", self.base[:12], "0" * 40, "f" * 40, "--all"]:
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                self.select(base=invalid)

    def test_push_binds_event_before_after(self):
        event = {"before": self.base, "after": self.head}
        self.assertEqual(self.select("push", event, ""), (self.base, self.head))
        with self.assertRaises(ValueError):
            self.select("push", {**event, "after": self.base}, "")
        with self.assertRaises(ValueError):
            self.select("push", event, self.head)
        self.assertEqual(self.select("push", {**event, "before": "0" * 40}), (self.base, self.head))
        with self.assertRaises(ValueError):
            self.select("push", {**event, "before": "0" * 40}, "")

    def test_pr_uses_unique_merge_base_and_refuses_override(self):
        event = {"pull_request": {"base": {"sha": self.base}, "head": {"sha": self.head}}}
        self.assertEqual(self.select("pull_request", event, ""), (self.base, self.head))
        with self.assertRaises(ValueError):
            self.select("pull_request", event)
        original = scanner.git
        def ambiguous(repo, *args, **kwargs):
            if args[:2] == ("merge-base", "--all"):
                return (self.base + "\n" + self.head + "\n").encode()
            return original(repo, *args, **kwargs)
        with patch.object(scanner, "git", side_effect=ambiguous), self.assertRaises(ValueError):
            self.select("pull_request", event, "")

    def test_pr_binds_checkout_and_rejects_non_event_merge_parents(self):
        event = {"pull_request": {"base": {"sha": self.base}, "head": {"sha": self.head}}}
        with self.assertRaises(ValueError):
            scanner.select_range(self.repo, "pull_request", event, self.base)
        other = save(self.repo, "other.md", "another commit")
        with self.assertRaises(ValueError):
            scanner.select_range(self.repo, "pull_request", event, other)
        tree = git(self.repo, "rev-parse", self.head + "^{tree}")
        for parents in [(self.head, self.base), (self.base, self.head, other), (other, self.head)]:
            args = ["-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "synthetic merge"]
            for parent in parents:
                args.extend(["-p", parent])
            candidate = git(self.repo, *args)
            git(self.repo, "reset", "--hard", candidate)
            with self.subTest(parents=len(parents)), self.assertRaises(ValueError):
                scanner.select_range(self.repo, "pull_request", event, candidate)

    def test_unrelated_and_empty_ranges_fail(self):
        with self.assertRaises(ValueError):
            self.select(base=self.head)
        git(self.repo, "checkout", "--orphan", "other")
        other = save(self.repo, "other", "unrelated")
        with self.assertRaises(ValueError):
            self.select(base=other)

    def test_path_bytes_are_not_commands_or_opened_paths(self):
        self.head = save(self.repo, "--odd\nname\t$(touch sentinel).md", "new text")
        commits, links = scanner.inspect_range(self.repo, self.base, self.head)
        self.assertIn(self.head, commits)
        self.assertEqual(links, 0)
        self.assertFalse((self.repo / "sentinel").exists())

    def test_source_and_commit_bounds_fail_closed(self):
        with patch.object(scanner, "MAX_SOURCE_BYTES", 1), self.assertRaises(ValueError):
            scanner.inspect_range(self.repo, self.base, self.head)
        with patch.object(scanner, "MAX_COMMITS", 0), self.assertRaises(ValueError):
            scanner.inspect_range(self.repo, self.base, self.head)
        with patch.object(scanner, "MAX_ENTRIES", 0), self.assertRaises(ValueError):
            scanner.inspect_range(self.repo, self.base, self.head)

    def test_gitlink_is_reported_without_opening_the_child(self):
        git(self.repo, "update-index", "--add", "--cacheinfo", "160000", self.base, "uninitialized-child")
        git(self.repo, "-c", "commit.gpgsign=false", "commit", "-qm", "public child fixture")
        head = git(self.repo, "rev-parse", "HEAD")
        _, links = scanner.inspect_range(self.repo, self.head, head)
        self.assertEqual(links, 1)
        self.assertFalse((self.repo / "uninitialized-child").exists())

    def test_interruption_removes_raw_report_and_never_prints_it(self):
        event = self.root / "event.json"
        event.write_text("{}")
        original_temporary = tempfile.TemporaryDirectory
        def private_directory(**kwargs):
            return original_temporary(dir=self.root, **kwargs)
        def interrupt(repo, binary, base, head, commits, private):
            (private / "report.json").write_text("synthetic private text")
            raise KeyboardInterrupt
        argv = ["incremental_secrets.py", "--repo", str(self.repo), "--scanner", "/unused",
                "--event-name", "workflow_dispatch", "--event-path", str(event),
                "--base", self.base, "--head", self.head]
        output = io.StringIO()
        with patch.object(sys, "argv", argv), patch.object(scanner, "validate_scanner"), \
                patch.object(scanner.tempfile, "TemporaryDirectory", side_effect=private_directory), \
                patch.object(scanner, "scan", side_effect=interrupt), contextlib.redirect_stdout(output):
            previous_mask = os.umask(0o077)
            try:
                self.assertEqual(scanner.main(), 2)
            finally:
                os.umask(previous_mask)
        self.assertNotIn("synthetic private text", output.getvalue())
        self.assertFalse(any(self.root.glob("incremental-secrets-*")))

    def test_scanner_pin_and_symlink_are_required(self):
        binary = self.root / "fake-scanner"
        binary.write_text("not the pinned scanner")
        with self.assertRaises(ValueError):
            scanner.validate_scanner(binary)
        link = self.root / "scanner-link"
        link.symlink_to(binary)
        with self.assertRaises(ValueError):
            scanner.validate_scanner(link)

    def test_shallow_repository_is_refused(self):
        clone = self.root / "shallow"
        subprocess.run(["git", "clone", "-q", "--depth=2", self.repo.as_uri(), str(clone)], check=True)
        with self.assertRaises(ValueError):
            scanner.select_range(clone, "workflow_dispatch", {}, self.head, self.base)

    def test_public_ci_runs_without_path_filters_or_install_steps(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
        content = workflow.read_text()
        job = content.split("  secret-check:\n", 1)[1].split("\n  formatting:", 1)[0]
        self.assertIn("fetch-depth: 0", job)
        self.assertIn("persist-credentials: false", job)
        self.assertIn("python3 tools/security-audit/incremental_secrets.py", job)
        for forbidden in ("needs:", "if:", "submodules:", "npm ", "upload-artifact", "${{ secrets."):
            self.assertNotIn(forbidden, job)
        self.assertNotIn("paths-ignore:", content.split("jobs:", 1)[0])

    def test_environment_drops_suppression_and_git_injection(self):
        with patch.dict(os.environ, {"GITLEAKS_CONFIG": "bad", "GIT_CONFIG_COUNT": "8", "GIT_TRACE": "1"}):
            env = scanner.environment()
        self.assertNotIn("GITLEAKS_CONFIG", env)
        self.assertNotIn("GIT_CONFIG_COUNT", env)
        self.assertNotIn("GIT_TRACE", env)
        self.assertEqual(env["GIT_NO_LAZY_FETCH"], "1")

    def test_scanner_errors_and_attribution_are_not_clean(self):
        private = self.root / "private"
        private.mkdir()
        def fake(command, **kwargs):
            (private / "report.json").write_text(json.dumps([{"Commit": "", "Secret": "REDACTED"}]))
            self.assertIn("--ignore-gitleaks-allow", command)
            self.assertIn("--text", next(x for x in command if x.startswith("--log-opts=")))
            self.assertNotIn("--all", " ".join(command))
            return 10, b""
        with patch.object(scanner, "run", side_effect=fake), self.assertRaises(ValueError):
            scanner.scan(self.repo, Path("/unused"), self.base, self.head, {self.head}, private)

    def test_timeout_and_diagnostic_fail_without_output(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            scanner.run(["python3", "-c", "import time; time.sleep(30)"], timeout=0.05)
        with self.assertRaisesRegex(ValueError, "^Scanner reported an error$"):
            scanner.run(["python3", "-c", "import sys; sys.stderr.write('synthetic private text')"], reject_stderr=True)

    @unittest.skipUnless(os.environ.get("GITLEAKS_TEST_BINARY"), "Set the pinned scanner for synthetic detection")
    def test_real_incremental_detection_and_unchanged_fixture(self):
        binary = Path(os.environ["GITLEAKS_TEST_BINARY"])
        scanner.validate_scanner(binary)
        fake = "ghp_" + hashlib.sha256(b"public incremental fixture never issued").hexdigest()[:36]
        old = save(self.repo, "old-fixture.txt", "token=" + fake + "\n")
        clean = save(self.repo, "docs/readme.md", "changed prose, same old fixture\n")
        def check(base, head):
            commits, _ = scanner.inspect_range(self.repo, base, head)
            with tempfile.TemporaryDirectory(dir=self.root) as temp:
                return scanner.scan(self.repo, binary, base, head, commits, Path(temp))
        self.assertEqual(check(old, clean), 0)
        clean = save(self.repo, "old-fixture.txt", "token=" + fake + "\nnew prose on a different line\n")
        self.assertEqual(check(old, clean), 0)
        introduced = save(self.repo, "docs/new.md", "token=" + fake + " # gitleaks:allow\n")
        save(self.repo, ".gitleaks.toml", '[allowlist]\nregexes = [".*"]\n')
        hidden = save(self.repo, ".gitattributes", "* -diff\n")
        self.assertGreater(check(clean, hidden), 0)
        forced_text = save(self.repo, "docs/binary-attribute.md", "token=" + fake + "\n")
        self.assertGreater(check(hidden, forced_text), 0)
        save(self.repo, "docs/binary-attribute.md", "removed token\n")
        deleted = save(self.repo, "docs/new.md", "removed token\n")
        self.assertGreater(check(clean, deleted), 0)
        self.assertEqual(check(forced_text, deleted), 0)
        event = self.root / "event.json"
        event.write_text("{}")
        completed = subprocess.run(["python3", str(Path(scanner.__file__).resolve()), "--repo", str(self.repo),
                                    "--scanner", str(binary), "--event-name", "workflow_dispatch",
                                    "--event-path", str(event), "--base", clean, "--head", deleted],
                                   capture_output=True, text=True, env={**os.environ, "TMPDIR": str(self.root)})
        self.assertEqual(completed.returncode, 1)
        self.assertNotIn(fake, completed.stdout + completed.stderr)
        self.assertNotIn("docs/new.md", completed.stdout + completed.stderr)
        self.assertFalse(any(self.root.glob("incremental-secrets-*")))
        # The secret exists only in a merge result, not in either parent.
        merge_base = deleted
        git(self.repo, "checkout", "-qb", "topic")
        topic_head = save(self.repo, "topic.txt", "safe topic")
        git(self.repo, "checkout", "main")
        target_head = save(self.repo, "main.txt", "token=" + fake + "\n")
        git(self.repo, "-c", "commit.gpgsign=false", "merge", "--no-ff", "-qm", "safe merge", "topic")
        event = {"pull_request": {"base": {"sha": target_head}, "head": {"sha": topic_head}}}
        safe_merge = git(self.repo, "rev-parse", "HEAD")
        selected_base, selected_head = scanner.select_range(self.repo, "pull_request", event, safe_merge)
        self.assertEqual(check(selected_base, selected_head), 0)
        (self.repo / "merge-only.md").write_text("token=" + fake + "\n")
        git(self.repo, "add", "--", "merge-only.md")
        git(self.repo, "-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit", "-q")
        candidate = git(self.repo, "rev-parse", "HEAD")
        self.assertGreater(check(merge_base, candidate), 0)
        event = {"pull_request": {"base": {"sha": target_head}, "head": {"sha": topic_head}}}
        selected_base, selected_head = scanner.select_range(self.repo, "pull_request", event, candidate)
        self.assertEqual((selected_base, selected_head), (target_head, candidate))
        self.assertGreater(check(selected_base, selected_head), 0)


if __name__ == "__main__":
    unittest.main()
