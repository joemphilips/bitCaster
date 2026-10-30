"""Check oracle bundle freshness against real Git source and dependency changes."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parent


class OracleProvenanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="oracle-provenance-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "dlcdevkit"
        self.repo.mkdir()
        self.out = self.root / "bitCaster-app/src/lib/kormir-wasm-pkg"
        self.out.mkdir(parents=True)
        self.tools = self.root / "tools"
        self.tools.mkdir()
        for name in ("kormir-source-fingerprint.sh", "build-kormir-wasm.sh",
                     "check-kormir-wasm-provenance.sh"):
            shutil.copyfile(TOOLS / name, self.tools / name)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        for path in ("Cargo.toml", "Cargo.lock", "kormir/lib.rs", "kormir-wasm/lib.rs",
                     "dlc/lib.rs", "dlc-messages/lib.rs"):
            target = self.repo / path
            target.parent.mkdir(exist_ok=True)
            target.write_text("fixture\n")
        self.commit()
        self.marker = self.out / ".source-fingerprint"
        self.marker.write_text(self.fingerprint().stdout)

    def git(self, *arguments):
        return subprocess.run(["git", "-C", str(self.repo), *arguments],
                              check=True, capture_output=True, text=True, timeout=10)

    def commit(self):
        self.git("add", ".")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture")

    def fingerprint(self):
        return subprocess.run(
            ["bash", "-c", 'source "$1"; kormir_source_fingerprint "$2"',
             "test", str(self.tools / "kormir-source-fingerprint.sh"), str(self.repo)],
            capture_output=True, text=True, check=True, timeout=10,
        )

    def check(self):
        return subprocess.run(["bash", str(self.tools / "check-kormir-wasm-provenance.sh")],
                              capture_output=True, text=True, timeout=10)

    def test_clean_inputs_pass_and_legacy_marker_refuses(self):
        self.assertEqual(0, self.check().returncode)
        self.marker.write_text(self.git("rev-parse", "HEAD:kormir", "HEAD:kormir-wasm").stdout)
        self.assertNotEqual(0, self.check().returncode)

    def test_dependency_lock_and_local_crate_changes_invalidate_old_bundle(self):
        for path in ("Cargo.lock", "Cargo.toml", "dlc/lib.rs", "dlc-messages/lib.rs"):
            with self.subTest(path=path):
                (self.repo / path).write_text("changed\n")
                self.assertNotEqual(0, self.check().returncode)
                self.git("add", path)
                self.assertNotEqual(0, self.check().returncode)
                self.commit()
                self.assertNotEqual(0, self.check().returncode)
                self.marker.write_text(self.fingerprint().stdout)
                self.assertEqual(0, self.check().returncode)

    def test_untracked_source_refuses_but_unrelated_readme_does_not(self):
        (self.repo / "README.md").write_text("unrelated\n")
        self.assertEqual(0, self.check().returncode)
        (self.repo / "kormir/new.rs").write_text("source\n")
        self.assertNotEqual(0, self.check().returncode)

    def test_failed_locked_build_removes_previous_success_marker(self):
        binary = self.root / "bin"
        binary.mkdir()
        stub = binary / "wasm-pack"
        stub.write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$TEST_ARGS"\nexit 7\n')
        stub.chmod(0o755)
        arguments = self.root / "arguments"
        environment = dict(os.environ, PATH=f"{binary}:{os.environ['PATH']}",
                           TEST_ARGS=str(arguments))
        result = subprocess.run(["bash", str(self.tools / "build-kormir-wasm.sh")],
                                env=environment, capture_output=True, text=True, timeout=15)
        self.assertEqual(7, result.returncode)
        self.assertEqual(["--", "--locked"], arguments.read_text().splitlines()[-2:])
        self.assertFalse(self.marker.exists())


if __name__ == "__main__":
    unittest.main()
