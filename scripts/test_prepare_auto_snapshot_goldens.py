"""Offline stdlib tests: python3 -B scripts/test_prepare_auto_snapshot_goldens.py.

No Git commands, package tools, snapshot suites or network calls are executed.
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

DRIVER = Path(__file__).with_name("prepare-auto-snapshot-goldens.py")
spec = importlib.util.spec_from_file_location("snapshot_proposal", DRIVER)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def environment():
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "cloga/deepseek-harness",
            "GITHUB_EVENT_NAME": "push", "GITHUB_REF": d.REF, "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "a" * 40, "PATH": os.environ.get("PATH", "")}


def row(data=b"old", kind="file", mode=0o644, stamp=1):
    return {"sha256": d.digest(data), "kind": kind, "mode": mode,
            "mtime_ns": stamp, "ctime_ns": stamp}


class Guards(unittest.TestCase):
    def test_import_has_no_execution(self):
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError), \
             mock.patch.object(Path, "open", side_effect=AssertionError), \
             mock.patch.object(signal, "signal", side_effect=AssertionError):
            spec.loader.exec_module(d)

    def test_ci_guard_positive(self):
        d.guard_environment(environment(), "Linux")

    def test_ci_guard_rejects_wrong_identity_ref_event_attempt_sha(self):
        for key, bad in {"GITHUB_ACTIONS": "false", "GITHUB_REPOSITORY": "fork/deepseek-harness",
                         "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "pull_request",
                         "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "HEAD"}.items():
            with self.subTest(key=key), self.assertRaises(d.Refusal):
                d.guard_environment(dict(environment(), **{key: bad}), "Linux")

    def test_requires_linux(self):
        with self.assertRaisesRegex(d.Refusal, "linux-required"):
            d.guard_environment(environment(), "Windows")

    def test_mode_guard(self):
        for value in ("record", "refresh", "", "replay --update"):
            with self.subTest(value=value), self.assertRaises(d.Refusal):
                d.guard_environment(dict(environment(), DSH_SNAPSHOT=value), "Linux")
        d.guard_environment(dict(environment(), DSH_SNAPSHOT="replay"), "Linux")

    def test_loader_options_rejected(self):
        with self.assertRaises(d.Refusal):
            d.guard_environment(dict(environment(), NODE_OPTIONS="--import=/evil"), "Linux")

    def test_child_is_source_mode_and_keyless(self):
        env = dict(environment(), DSH_EXAMPLE_MODE="lib", DSH_SNAPSHOT="record", API_KEY="secret",
                   GH_TOKEN="secret", NODE_OPTIONS="--import=/evil", DSH_TEST_TIMEOUT="900000",
                   HOME="/home/runner", NODE_EXTRA_CA_CERTS="/trusted/cert.pem")
        for mode in ("refresh", "replay"):
            child = d.child_environment(env, mode)
            self.assertEqual(child["DSH_SNAPSHOT"], mode)
            self.assertEqual(child["HOME"], env["HOME"])
            self.assertEqual(child["NODE_EXTRA_CA_CERTS"], env["NODE_EXTRA_CA_CERTS"])
            for key in ("DSH_EXAMPLE_MODE", "API_KEY", "GH_TOKEN", "NODE_OPTIONS", "DSH_TEST_TIMEOUT"):
                self.assertNotIn(key, child)
        with self.assertRaises(d.Refusal):
            d.child_environment(env, "record")

    def test_telemetry_is_always_disabled_without_forwarding_dsh_knobs(self):
        for mode in (None, "refresh", "replay"):
            for inherited in (None, "0", "1"):
                env = environment()
                if inherited is not None:
                    env["DSH_TELEMETRY_DISABLED"] = inherited
                env["DSH_ARBITRARY_OVERRIDE"] = "not-forwarded"
                child = d.child_environment(env, mode)
                self.assertEqual(child["DSH_TELEMETRY_DISABLED"], "1")
                self.assertNotIn("DSH_ARBITRARY_OVERRIDE", child)

    def test_exact_commands_and_budgets(self):
        self.assertEqual(d.SUITE, ["node", "node_modules/vitest/vitest.mjs", "run", "--config",
                                  "vitest.snapshot.config.ts"])
        self.assertEqual(d.STAGE_SECONDS, 1200)
        self.assertEqual(d.REPLAY_SECONDS, 600)

    def test_version_is_derived_and_pinned(self):
        self.assertEqual(d.current_version("export const SESSION_FORMAT_VERSION = 3\n"), 3)
        for value in ("export const SESSION_FORMAT_VERSION = 2", "export const SESSION_FORMAT_VERSION = VERSION",
                      "export const SESSION_FORMAT_VERSION = 3\nexport const SESSION_FORMAT_VERSION = 3"):
            with self.subTest(value=value), self.assertRaises(d.Refusal):
                d.current_version(value)


class ChangePolicy(unittest.TestCase):
    def test_current_parent_and_children(self):
        for name in ("session.v3.jsonl", "session.1.v3.jsonl", "session.101.v3.jsonl"):
            self.assertTrue(d.allowed_output("snapshots/case/" + name))

    def test_historical_and_extra_filenames_rejected(self):
        for name in ("session.jsonl", "session.1.jsonl", "session.v0.jsonl", "session.v1.jsonl",
                     "session.2.v2.jsonl", "session.v4.jsonl", "session.0.v3.jsonl", "session.01.v3.jsonl",
                     "session.v3.jsonl.bak", "input.json", "snapshot.yml", "test.snapshot.ts",
                     "evil.expected.ts", "evil.expected.yml", "evil.expected.py", "stdout.expected.json.bak"):
            with self.subTest(name=name):
                self.assertFalse(d.allowed_output("snapshots/case/" + name))

    def test_expectations_and_workspace_restrictions(self):
        for name in ("stdout.expected.jsonl", "system-prompt.1.expected.md", "tool-schemas.expected.json",
                     "result.expected.json", "writer.expected.jsonl", "notifications.expected.jsonl"):
            self.assertTrue(d.allowed_output("snapshots/case/" + name))
        for path in ("apps/test/stdout.expected.jsonl", "snapshots/../stdout.expected.jsonl",
                     "snapshots/case/workspace.expected/stdout.expected.jsonl",
                     "snapshots/case/workspace.expected.json"):
            self.assertFalse(d.allowed_output(path))

    def test_changed_output_hash_binding(self):
        name = "snapshots/a/session.v3.jsonl"
        before, after = {name: row()}, {name: row(b"new")}
        self.assertEqual(d.check_changes(before, after), [name])
        self.assertEqual(before[name]["sha256"], d.digest(b"old"))
        self.assertEqual(after[name]["sha256"], d.digest(b"new"))

    def test_historical_sessions_must_remain_byte_identical(self):
        for name in ("session.jsonl", "session.v1.jsonl", "session.1.v2.jsonl"):
            path = "snapshots/case/" + name
            self.assertEqual(d.check_changes({path: row()}, {path: row()}), [])
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.check_changes({path: row()}, {path: row(b"rewritten")})

    def test_source_and_lock_mutation_rejected(self):
        for name in (d.DRIVER, "pnpm-lock.yaml", "snapshots/test.snapshot.ts", "src/file.ts"):
            with self.subTest(name=name), self.assertRaisesRegex(d.Refusal, "non-output-mutation"):
                d.check_changes({name: row()}, {name: row(b"new")})

    def test_deletions_and_link_mutation_rejected(self):
        name = "snapshots/a/stdout.expected.jsonl"
        for after in ({}, {name: row(b"target", kind="link")}, {name: row(mode=0o755)}):
            with self.subTest(after=after), self.assertRaises(d.Refusal):
                d.check_changes({name: row()}, after)
        with self.assertRaises(d.Refusal):
            d.check_changes({name: row(kind="link")}, {name: row()})

    def test_replay_rejects_add_modify_delete_and_same_byte_write(self):
        name = "snapshots/a/session.v3.jsonl"
        for before, after in (({}, {name: row()}), ({name: row()}, {}),
                              ({name: row()}, {name: row(b"new")}),
                              ({name: row()}, {name: row(stamp=2)})):
            with self.subTest(after=after), self.assertRaisesRegex(d.Refusal, "replay-wrote"):
                d.check_changes(before, after, replay=True)
        self.assertEqual(d.check_changes({name: row()}, {name: row()}, replay=True), [])


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="snapshot-driver-test-", dir=DRIVER.parent.parent)
        self.addCleanup(self.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "checkout"
        self.root.mkdir()
        self.runner = self.base / "runner"
        self.runner.mkdir()
        self.output = self.base / "github-output"
        self.output.touch()
        self.env = dict(environment(), RUNNER_TEMP=str(self.runner), GITHUB_OUTPUT=str(self.output))

    def cleanup(self):
        # Evidence deliberately seals read-only files; reopen test-owned fixtures only.
        for directory, dirs, files in os.walk(self.temp.name):
            Path(directory).chmod(0o700)
            for name in files:
                p = Path(directory) / name
                if not p.is_symlink():
                    p.chmod(0o600)
        self.temp.cleanup()

    def evidence(self):
        return d.Evidence(self.root, self.env)

    def write(self, name, data=b"old"):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def symlink(self, path, target, is_dir=False):
        try:
            path.symlink_to(target, target_is_directory=is_dir)
        except OSError:
            self.skipTest("symlink creation unavailable on this test platform")

    def test_early_output_and_unique_external_evidence(self):
        first, second = self.evidence(), self.evidence()
        self.assertNotEqual(first.path, second.path)
        self.assertFalse(first.path.is_relative_to(self.root))
        self.assertIn("evidence_path=" + str(first.path), self.output.read_text())

    def test_evidence_inside_checkout_rejected(self):
        with self.assertRaisesRegex(d.Refusal, "outside-checkout"):
            d.Evidence(self.root, dict(self.env, RUNNER_TEMP=str(self.root)))

    def test_safe_path_rejects_traversal(self):
        for name in ("../secret", "/secret", ".git/config", "snapshots/../../secret"):
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.safe_path(self.root, name)

    def test_symlink_escape_is_not_dereferenced(self):
        self.symlink(self.root / "escape", self.output)
        with self.assertRaisesRegex(d.Refusal, "symlink-escape"):
            d.safe_path(self.root, "escape")
        evidence = self.evidence()
        with mock.patch.object(evidence, "git", return_value=b"escape\0"):
            with self.assertRaises(d.Refusal):
                evidence.inventory()
            inventory = evidence.inventory(strict=False)
        self.assertEqual(inventory["escape"]["kind"], "unsafe-link")
        blob = evidence.path / "blobs" / inventory["escape"]["sha256"]
        self.assertEqual(blob.read_bytes(), os.fsencode(os.readlink(self.root / "escape")))

    def test_internal_alias_allowed_but_symlink_parent_rejected(self):
        target = self.write("snapshots/owner/stdout.expected.jsonl")
        alias = self.root / "snapshots/alias.expected.jsonl"
        self.symlink(alias, target)
        self.assertEqual(d.safe_path(self.root, "snapshots/alias.expected.jsonl"), alias)
        parent = self.root / "linked"
        self.symlink(parent, target.parent, True)
        with self.assertRaisesRegex(d.Refusal, "symlink-parent"):
            d.safe_path(self.root, "linked/stdout.expected.jsonl")

    def test_capture_preserves_original_and_partial_after_bytes_and_binary_diff(self):
        name = "snapshots/case/session.v3.jsonl"
        path = self.write(name, b"old\x00bytes")
        evidence = self.evidence()
        def git(*args, **kwargs):
            return (name + "\0").encode() if args[0] == "ls-files" else b"GIT binary patch\n"
        with mock.patch.object(evidence, "git", side_effect=git):
            before = evidence.inventory()
            path.write_bytes(b"new\x00bytes")
            after = evidence.capture("failed-refresh", before)
        for data in (b"old\x00bytes", b"new\x00bytes"):
            self.assertEqual((evidence.path / "blobs" / d.digest(data)).read_bytes(), data)
        changes = json.loads((evidence.path / "failed-refresh.changes.json").read_text())
        self.assertEqual(changes[0]["before"], before[name])
        self.assertEqual(changes[0]["after"], after[name])
        self.assertEqual((evidence.path / "failed-refresh.patch").read_bytes(), b"GIT binary patch\n")

    def test_replay_patch_keeps_untracked_refresh_additions(self):
        name = "snapshots/a/session.v3.jsonl"
        self.write(name, b"new-session")
        evidence = self.evidence()
        calls = []
        def git(*args, **kwargs):
            calls.append(args)
            if args[0] == "ls-files":
                return b""  # os.walk still observes the untracked snapshot.
            return b"new-file-patch\n" if "--no-index" in args else b""
        with mock.patch.object(evidence, "git", side_effect=git):
            before_replay = evidence.inventory()
            evidence.capture("replay", before_replay)
        self.assertEqual((evidence.path / "replay.patch").read_bytes(), b"new-file-patch\n")
        self.assertTrue(any("--no-index" in args and args[-1] == name for args in calls))

    def test_inventory_includes_ignored_snapshot_outputs(self):
        self.write("snapshots/case/unexpected.tmp")
        evidence = self.evidence()
        with mock.patch.object(evidence, "git", return_value=b""):
            inventory = evidence.inventory()
        self.assertIn("snapshots/case/unexpected.tmp", inventory)
        with self.assertRaises(d.Refusal):
            d.check_changes({}, inventory)

    def test_failure_evidence_and_sanitized_error(self):
        with mock.patch.object(d.platform, "system", return_value="Linux"), \
             mock.patch.object(d, "source_guard", side_effect=RuntimeError("API_KEY=never-print-me")):
            self.assertEqual(d.execute(self.root, self.env), 1)
        path = next(self.runner.iterdir())
        result = (path / "result.json").read_text()
        self.assertNotIn("never-print-me", result)
        self.assertEqual(json.loads(result)["error_code"], "internal-failure")
        hashes = json.loads((path / "artifact-sha256.json").read_text())
        self.assertEqual(hashes["result.json"], d.digest((path / "result.json").read_bytes()))

    def test_guard_failure_retains_early_evidence(self):
        with mock.patch.object(d.platform, "system", return_value="Linux"):
            self.assertEqual(d.execute(self.root, dict(self.env, GITHUB_REF="refs/heads/main")), 1)
        result = json.loads((next(self.runner.iterdir()) / "result.json").read_text())
        self.assertFalse(result["successful"])
        self.assertIn("evidence_path=", self.output.read_text())

    def pipeline(self, failure=None, mutation=None, first_exit=0, second_exit=0, timeout_stage=None):
        for name in (d.WORKFLOW, d.DRIVER, d.TEST, "pnpm-lock.yaml", "vitest.snapshot.config.ts"):
            self.write(name, b"input")
        self.write(d.VERSION_SOURCE, b"export const SESSION_FORMAT_VERSION = 3\n")
        output = self.write("snapshots/a/session.v3.jsonl", b"original")
        evidence = self.evidence()
        stages = []
        def git(*args, **kwargs):
            if args[0] == "ls-files":
                return b"\0".join(p.relative_to(self.root).as_posix().encode()
                                   for p in self.root.rglob("*") if p.is_file())
            if args[0] == "show":
                return b"input"
            if args[0] == "rev-parse":
                return (b"b" if stages and mutation == "head" else b"a") * 40
            if args[:3] == ("diff", "--cached", "--name-only") and stages and mutation == "index":
                return b"staged-file"
            return b""
        def run(label, argv, timeout=60, env=None, accepted=(0,)):
            if label.startswith("version-"):
                return {"version-node": b"v24.1.0", "version-pnpm": b"11.7.0", "version-git": b"git version 2.49.0"}[label]
            stages.append(label)
            self.assertEqual(argv, d.SUITE)
            self.assertEqual(env["DSH_SNAPSHOT"], "refresh" if label.startswith("refresh-") else "replay")
            self.assertEqual(timeout, d.STAGE_SECONDS if label.startswith("refresh-") else d.REPLAY_SECONDS)
            self.assertEqual(accepted, (0, 1) if label == "refresh-pass1" else (0,))
            self.assertNotIn("DSH_EXAMPLE_MODE", env)
            if label.startswith("refresh-"):
                output.write_bytes(b"proposal" if label == "refresh-pass1" else b"second-proposal")
                if mutation == "source" or (mutation == "second-source" and label == "refresh-pass2"):
                    self.write(d.DRIVER, b"bad")
            elif mutation == "replay":
                output.write_bytes(b"replay-write")
            exit_code = first_exit if label == "refresh-pass1" else second_exit if label == "refresh-pass2" else 0
            if failure == label:
                exit_code = 2
            classification = "timeout" if timeout_stage == label else "exited"
            d.write_json(evidence.path / (label + ".mock-receipt.json"),
                         {"classification": classification, "exit_code": exit_code})
            d.require(classification == "exited", "stage-timeout")
            d.require(exit_code in accepted, "stage-failed")
            return b""
        source_binding = {"source_sha": "a" * 40, "source_tree": "b" * 40,
                      "base_sha": d.BASE, "base_tree": d.BASE_TREE}
        with mock.patch.object(d, "Evidence", return_value=evidence), \
             mock.patch.object(d.platform, "system", return_value="Linux"), \
             mock.patch.object(d, "source_guard", return_value=source_binding), \
             mock.patch.object(evidence, "git", side_effect=git), \
             mock.patch.object(evidence, "run", side_effect=run):
            status = d.execute(self.root, dict(self.env, DSH_EXAMPLE_MODE="lib"))
        return status, stages, evidence.path

    def test_pipeline_zero_first_exit_still_runs_two_refreshes_and_replay_source_bound(self):
        status, stages, path = self.pipeline()
        self.assertEqual(status, 0)
        self.assertEqual(stages, ["refresh-pass1", "refresh-pass2", "replay"])
        result = json.loads((path / "result.json").read_text())
        self.assertTrue(result["successful"])
        self.assertFalse(result["independently_qualified"])
        source_binding = json.loads((path / "source-binding.json").read_text())
        self.assertEqual(source_binding["lock_sha256"], d.digest(b"input"))
        self.assertEqual(source_binding["input_sha256"][d.DRIVER], d.digest(b"input"))
        for data in (b"original", b"proposal"):
            self.assertEqual((path / "blobs" / d.digest(data)).read_bytes(), data)

    def test_failed_refresh_preserves_partial_outputs_and_never_retries(self):
        status, stages, path = self.pipeline(failure="refresh-pass1")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh-pass1"])
        self.assertTrue((path / "refresh-pass1.inventory.json").exists())
        self.assertEqual((path / "blobs" / d.digest(b"proposal")).read_bytes(), b"proposal")
        self.assertFalse(json.loads((path / "result.json").read_text())["successful"])

    def test_failed_replay_preserves_failure_without_retry(self):
        status, stages, path = self.pipeline(failure="replay")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh-pass1", "refresh-pass2", "replay"])
        self.assertTrue((path / "replay.inventory.json").exists())

    def test_pipeline_source_mutation_blocks_replay(self):
        status, stages, path = self.pipeline(mutation="source")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh-pass1"])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "non-output-mutation")

    def test_pipeline_replay_write_rejected_and_bytes_retained(self):
        status, stages, path = self.pipeline(mutation="replay")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh-pass1", "refresh-pass2", "replay"])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "replay-wrote-source-or-output")
        self.assertEqual((path / "blobs" / d.digest(b"replay-write")).read_bytes(), b"replay-write")

    def test_first_exit_one_then_second_zero_and_replay_succeeds_with_raw_failure(self):
        status, stages, path = self.pipeline(first_exit=1)
        self.assertEqual(status, 0)
        self.assertEqual(stages, ["refresh-pass1", "refresh-pass2", "replay"])
        result = json.loads((path / "result.json").read_text())
        self.assertTrue(result["successful"])
        self.assertFalse(result["first_refresh_is_qualification"])
        self.assertFalse(result["independently_qualified"])
        self.assertEqual(json.loads((path / "refresh-pass1.mock-receipt.json").read_text())["exit_code"], 1)
        self.assertEqual(json.loads((path / "refresh-pass2.mock-receipt.json").read_text())["exit_code"], 0)
        for data in (b"original", b"proposal", b"second-proposal"):
            self.assertEqual((path / "blobs" / d.digest(data)).read_bytes(), data)

    def test_first_exit_one_source_mutation_blocks_second_pass(self):
        status, stages, path = self.pipeline(first_exit=1, mutation="source")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh-pass1"])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "non-output-mutation")

    def test_second_exit_one_fails_and_does_not_run_replay(self):
        status, stages, path = self.pipeline(first_exit=1, second_exit=1)
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh-pass1", "refresh-pass2"])
        self.assertTrue((path / "refresh-pass2.inventory.json").exists())
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "stage-failed")
        self.assertEqual((path / "blobs" / d.digest(b"second-proposal")).read_bytes(), b"second-proposal")

    def test_second_failure_still_runs_mutation_guards(self):
        status, stages, path = self.pipeline(second_exit=1, mutation="second-source")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh-pass1", "refresh-pass2"])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "non-output-mutation")
        self.assertEqual(json.loads((path / "refresh-pass2.mock-receipt.json").read_text())["exit_code"], 1)

    def test_first_pass_timeout_even_with_exit_one_stops_before_second_pass(self):
        status, stages, path = self.pipeline(first_exit=1, timeout_stage="refresh-pass1")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh-pass1"])
        self.assertTrue((path / "refresh-pass1.inventory.json").exists())
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "stage-timeout")

    def test_first_pass_head_or_index_mutation_blocks_second_pass(self):
        for mutation in ("head", "index"):
            with self.subTest(mutation=mutation):
                status, stages, path = self.pipeline(first_exit=1, mutation=mutation)
                self.assertEqual(status, 1)
                self.assertEqual(stages, ["refresh-pass1"])
                self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], mutation + "-mutated")

    def run_fake_process(self, waits, returncode, expected_error=None, accepted=(0,)):
        evidence = self.evidence()
        proc = mock.Mock(pid=412345, returncode=returncode)
        proc.wait.side_effect = waits
        with mock.patch.object(d.subprocess, "Popen", return_value=proc) as popen, \
             mock.patch.object(d.os, "killpg", create=True) as kill:
            if expected_error:
                with self.assertRaises(expected_error):
                    evidence.run("fake", ["python", "offline-only"], timeout=7, accepted=accepted)
            else:
                evidence.run("fake", ["python", "offline-only"], timeout=7, accepted=accepted)
            kill.assert_called_once_with(proc.pid, signal.SIGKILL if hasattr(signal, "SIGKILL") else 9)
            self.assertTrue(popen.call_args.kwargs["start_new_session"])
            self.assertNotIn("shell", popen.call_args.kwargs)
        return json.loads(next(evidence.path.glob("*.receipt.json")).read_text())

    def test_process_success_receipt_and_owned_cleanup(self):
        with mock.patch.object(d.signal, "SIGKILL", 9, create=True):
            receipt = self.run_fake_process([0, 0], 0)
        self.assertEqual(receipt["classification"], "exited")
        self.assertEqual(receipt["exit_code"], 0)

    def test_process_failure_preserves_raw_exit(self):
        with mock.patch.object(d.signal, "SIGKILL", 9, create=True):
            receipt = self.run_fake_process([23, 23], 23, d.Refusal)
        self.assertEqual(receipt["exit_code"], 23)
        self.assertEqual(receipt["classification"], "exited")

    def test_first_pass_acceptance_preserves_raw_exit_one(self):
        with mock.patch.object(d.signal, "SIGKILL", 9, create=True):
            receipt = self.run_fake_process([1, 1], 1, accepted=(0, 1))
        self.assertEqual(receipt["exit_code"], 1)
        self.assertEqual(receipt["classification"], "exited")

    def test_first_pass_acceptance_rejects_other_exit(self):
        with mock.patch.object(d.signal, "SIGKILL", 9, create=True):
            receipt = self.run_fake_process([2, 2], 2, d.Refusal, accepted=(0, 1))
        self.assertEqual(receipt["exit_code"], 2)

    def test_first_pass_acceptance_never_accepts_timeout_exit_one(self):
        with mock.patch.object(d.signal, "SIGKILL", 9, create=True):
            receipt = self.run_fake_process([subprocess.TimeoutExpired("owned", 7), 1], 1,
                                            d.Refusal, accepted=(0, 1))
        self.assertEqual(receipt["classification"], "timeout")
        self.assertEqual(receipt["exit_code"], 1)

    def test_timeout_kills_only_owned_group_and_is_not_success(self):
        with mock.patch.object(d.signal, "SIGKILL", 9, create=True):
            receipt = self.run_fake_process([subprocess.TimeoutExpired("owned", 7), -9], -9, d.Refusal)
        self.assertEqual(receipt["classification"], "timeout")
        self.assertEqual(receipt["exit_code"], -9)
        self.assertEqual(receipt["timeout_seconds"], 7)

    def test_cancellation_kills_owned_group_and_retains_receipt(self):
        with mock.patch.object(d.signal, "SIGKILL", 9, create=True):
            receipt = self.run_fake_process([KeyboardInterrupt(), -9], -9, KeyboardInterrupt)
        self.assertEqual(receipt["classification"], "cancelled")

    def test_spawn_failure_does_not_kill_any_group(self):
        evidence = self.evidence()
        with mock.patch.object(d.subprocess, "Popen", side_effect=OSError("credential-must-not-leak")), \
             mock.patch.object(d.os, "killpg", create=True) as kill:
            with self.assertRaises(OSError):
                evidence.run("fake", ["missing"])
            kill.assert_not_called()
        receipt = json.loads(next(evidence.path.glob("*.receipt.json")).read_text())
        self.assertEqual(receipt["classification"], "spawn-failed")
        self.assertNotIn("credential", json.dumps(receipt))


class SourceBinding(unittest.TestCase):
    def evidence(self, overrides=None):
        root = Path.cwd().resolve()
        values = {("rev-parse", "--show-toplevel"): str(root).encode(),
                  ("rev-parse", "HEAD"): b"a" * 40,
                  ("status", "--porcelain=v1", "--untracked-files=all"): b"",
                  ("rev-parse", d.BASE + "^{tree}"): d.BASE_TREE.encode(),
                  ("merge-base", "--is-ancestor", d.BASE, "HEAD"): b"",
                  ("diff", "--no-renames", "--name-only", "-z", d.BASE, "HEAD"): (d.DRIVER + "\0").encode(),
                  ("rev-parse", "HEAD^{tree}"): b"b" * 40}
        values.update(overrides or {})
        return mock.Mock(root=root, git=mock.Mock(side_effect=lambda *args: values[args]))

    def test_exact_source_and_runtime_binding(self):
        result = d.source_guard(self.evidence(), environment())
        self.assertEqual(result["source_sha"], "a" * 40)
        self.assertEqual(result["source_tree"], "b" * 40)
        self.assertEqual(result["base_sha"], d.BASE)
        self.assertEqual(result["base_tree"], d.BASE_TREE)

    def test_dirty_tracked_or_untracked_source_rejected(self):
        for value in (b" M source.ts\n", b"?? rogue.txt\n"):
            with self.subTest(value=value), self.assertRaisesRegex(d.Refusal, "dirty-checkout"):
                d.source_guard(self.evidence({("status", "--porcelain=v1", "--untracked-files=all"): value}), environment())

    def test_baseline_tree_mismatch_rejected(self):
        with self.assertRaisesRegex(d.Refusal, "baseline-tree-mismatch"):
            d.source_guard(self.evidence({("rev-parse", d.BASE + "^{tree}"): b"d" * 40}), environment())

    def test_head_mismatch_rejected(self):
        with self.assertRaisesRegex(d.Refusal, "head-trigger-mismatch"):
            d.source_guard(self.evidence({("rev-parse", "HEAD"): b"c" * 40}), environment())

    def test_runtime_delta_rejected_but_infrastructure_subset_allowed(self):
        key = ("diff", "--no-renames", "--name-only", "-z", d.BASE, "HEAD")
        with self.assertRaisesRegex(d.Refusal, "runtime-differs"):
            d.source_guard(self.evidence({key: b"packages/core/source.ts\0"}), environment())
        d.source_guard(self.evidence({key: b"\0".join(p.encode() for p in d.INFRASTRUCTURE)}), environment())


if __name__ == "__main__":
    unittest.main()
