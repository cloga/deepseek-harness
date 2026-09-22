"""Offline stdlib tests: python3 -B scripts/test_prepare_auto_expected_goldens.py.

No Git/package commands, real refreshes, builds or network calls are executed.
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest import mock

DRIVER = Path(__file__).with_name("prepare-auto-expected-goldens.py")
spec = importlib.util.spec_from_file_location("expected_proposal", DRIVER)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def environment():
    return {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "cloga/deepseek-harness",
            "GITHUB_EVENT_NAME": "push", "GITHUB_REF": d.REF, "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "a" * 40, "PATH": os.environ.get("PATH", "")}


def row(data=b"old", kind="file", mode=0o644, stamp=1):
    return {"sha256": d.digest(data), "kind": kind, "mode": mode, "mtime_ns": stamp, "ctime_ns": stamp}


class Guards(unittest.TestCase):
    def test_import_has_no_side_effects(self):
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError), \
             mock.patch.object(Path, "open", side_effect=AssertionError), \
             mock.patch.object(signal, "signal", side_effect=AssertionError):
            spec.loader.exec_module(d)

    def test_exact_push_identity_allowed(self):
        d.guard_environment(environment(), "Linux")

    def test_wrong_identity_ref_event_attempt_and_sha_rejected(self):
        for key, value in {"GITHUB_ACTIONS": "false", "GITHUB_REPOSITORY": "fork/deepseek-harness",
                           "GITHUB_REF": "refs/heads/cloga-auto-minimal-golden-113",
                           "GITHUB_EVENT_NAME": "pull_request", "GITHUB_RUN_ATTEMPT": "2",
                           "GITHUB_SHA": "HEAD"}.items():
            with self.subTest(key=key), self.assertRaises(d.Refusal):
                d.guard_environment(dict(environment(), **{key: value}), "Linux")

    def test_linux_required(self):
        for system in ("Windows", "Darwin"):
            with self.subTest(system=system), self.assertRaisesRegex(d.Refusal, "linux-required"):
                d.guard_environment(environment(), system)

    def test_inherited_snapshot_mode_and_loader_options_rejected(self):
        for mode in ("refresh", "record", "", "arbitrary"):
            with self.subTest(mode=mode), self.assertRaises(d.Refusal):
                d.guard_environment(dict(environment(), DSH_SNAPSHOT=mode), "Linux")
        with self.assertRaises(d.Refusal):
            d.guard_environment(dict(environment(), NODE_OPTIONS="--import=/injected"), "Linux")

    def test_child_is_lib_keyless_and_has_no_arbitrary_node_path(self):
        env = dict(environment(), HOME="/home/runner", DSH_EXAMPLE_MODE="source", NODE_PATH="/injected",
                   NODE_OPTIONS="--import=/injected", DSH_SNAPSHOT="record", API_KEY="secret", GH_TOKEN="secret",
                   DSH_ARBITRARY_OVERRIDE="bad", NODE_EXTRA_CA_CERTS="/trusted/cert.pem", PNPM_HOME="/pnpm")
        for mode in ("refresh", "replay"):
            child = d.child_environment(env, mode)
            self.assertEqual(child["DSH_SNAPSHOT"], mode)
            self.assertEqual(child["DSH_EXAMPLE_MODE"], "lib")
            self.assertEqual(child["DSH_TELEMETRY_DISABLED"], "1")
            for name in ("HOME", "PATH", "NODE_EXTRA_CA_CERTS", "PNPM_HOME"):
                self.assertEqual(child[name], env[name])
            for name in ("API_KEY", "GH_TOKEN", "NODE_PATH", "NODE_OPTIONS", "DSH_ARBITRARY_OVERRIDE"):
                self.assertNotIn(name, child)

    def test_lib_and_telemetry_cannot_be_overridden(self):
        for mode in (None, "refresh", "replay"):
            for inherited in (None, "", "source", "lib", "arbitrary"):
                with self.subTest(mode=mode, inherited=inherited):
                    env = environment()
                    if inherited is not None:
                        env["DSH_EXAMPLE_MODE"] = inherited
                    env["DSH_TELEMETRY_DISABLED"] = "0"
                    child = d.child_environment(env, mode)
                    self.assertEqual(child["DSH_EXAMPLE_MODE"], "lib")
                    self.assertEqual(child["DSH_TELEMETRY_DISABLED"], "1")
                    self.assertEqual(env.get("DSH_EXAMPLE_MODE"), inherited)
        with self.assertRaises(d.Refusal):
            d.child_environment(environment(), "record")

    def test_refresh_exact_two_files_and_anchored_two_case_names(self):
        self.assertEqual(d.REFRESH_COMMAND, ["pnpm", "run", "test:expected:refresh",
            "apps/cli/tests/profiles/headless/tests/headless.expected.e2e.ts",
            "apps/cli/tests/profiles/headless/tests/subagent-inheritance.expected.e2e.ts", "-t",
            "(delivers a continuable child result without parent polling|confines a delegated child through the assembled headless app)$"])
        self.assertNotIn("--", d.REFRESH_COMMAND)
        self.assertNotIn("node", d.REFRESH_COMMAND)

    def test_replay_uses_full_suite_and_unchanged_outer_budgets(self):
        self.assertEqual(d.REPLAY_COMMAND, ["pnpm", "run", "test:expected"])
        self.assertEqual((d.REFRESH_SECONDS, d.REPLAY_SECONDS), (600, 900))
        self.assertEqual(d.SCRIPT_VALUES, {
            "test:expected:refresh": "DSH_SNAPSHOT=refresh vitest run --config vitest.expected.config.ts",
            "test:expected": "vitest run --config vitest.expected.config.ts"})

    def test_changed_package_script_contract_rejected(self):
        d.check_scripts(json.dumps({"scripts": d.SCRIPT_VALUES}))
        for value in ("vitest run --update", "DSH_SNAPSHOT=record vitest run", "node custom-generator.js"):
            with self.subTest(value=value), self.assertRaises(d.Refusal):
                d.check_scripts(json.dumps({"scripts": dict(d.SCRIPT_VALUES, **{"test:expected:refresh": value})}))


class ChangePolicy(unittest.TestCase):
    def test_exact_four_candidate_allowlist(self):
        root = "apps/cli/tests/profiles/headless/tests/expected/"
        self.assertEqual(d.CANDIDATES, {root + name for name in (
            "subagent-settlement/child.expected.jsonl", "subagent-settlement/stream-json.expected.jsonl",
            "subagent-inheritance/parent.expected.jsonl", "subagent-inheritance/child.expected.jsonl")})

    def test_all_four_existing_candidate_content_changes_allowed(self):
        for name in d.CANDIDATES:
            with self.subTest(name=name):
                self.assertEqual(d.check_changes({name: row()}, {name: row(b"new")}, {name}), [name])

    def test_candidates_must_all_exist_tracked(self):
        before = {name: row() for name in d.CANDIDATES}
        d.check_candidates(before, set(before))
        for missing in d.CANDIDATES:
            with self.subTest(missing=missing), self.assertRaises(d.Refusal):
                d.check_candidates(before, set(before) - {missing})
            with self.subTest(missing=missing), self.assertRaises(d.Refusal):
                d.check_candidates({k: v for k, v in before.items() if k != missing}, set(before))

    def test_candidate_symlink_refused_before_refresh(self):
        before = {name: row() for name in d.CANDIDATES}
        before[next(iter(d.CANDIDATES))] = row(kind="link")
        with self.assertRaises(d.Refusal):
            d.check_candidates(before, set(before))

    def test_other_expected_content_change_rejected(self):
        for name in ("apps/cli/tests/other.expected.jsonl", d.OWNER + "expected/subagent-inheritance/extra.expected.jsonl"):
            with self.subTest(name=name), self.assertRaisesRegex(d.Refusal, "non-candidate-content"):
                d.check_changes({name: row()}, {name: row(b"new")}, {name})

    def test_input_override_config_and_typescript_content_rejected(self):
        for name in (d.OWNER + "expected/subagent-settlement/parent.replay.jsonl",
                     d.OWNER + "expected/subagent-inheritance/child.replay.v3.jsonl",
                     d.OWNER + "expected/subagent-inheritance/replay.override.json",
                     d.OWNER + "../subagent-inheritance-snapshot.patch.yml", d.TARGET_FILES[0],
                     "pnpm-lock.yaml", "package.json", "vitest.expected.config.ts", d.DRIVER):
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.check_changes({name: row()}, {name: row(b"new")}, {name})

    def test_canonical_and_historical_sessions_reject_content_and_metadata(self):
        for tree in ("snapshots", "scripts/snapshots"):
            for filename in ("session.jsonl", "session.v1.jsonl", "session.1.v2.jsonl", "session.v3.jsonl", "stdout.expected.jsonl"):
                name = tree + "/case/" + filename
                for after in (row(b"new"), row(stamp=2)):
                    with self.subTest(name=name, after=after), self.assertRaises(d.Refusal):
                        d.check_changes({name: row()}, {name: after}, {name})

    def test_only_tracked_owner_expected_metadata_may_change(self):
        for name in ("apps/cli/tests/other.expected.jsonl", "apps/cli/tests/deep/stderr.expected.txt",
                     "apps/cli/tests/prompt.expected.md", "apps/cli/tests/result.expected.json"):
            self.assertEqual(d.check_changes({name: row()}, {name: row(stamp=2)}, {name}), [name])
            with self.assertRaises(d.Refusal):
                d.check_changes({name: row()}, {name: row(stamp=2)}, set())

    def test_metadata_boundary_rejects_input_source_outside_and_bad_extension(self):
        for name in ("apps/cli/tests/source.ts", "apps/cli/tests/input.replay.jsonl", "apps/cli/tests/replay.override.json",
                     "apps/cli/tests/fake.expected.ts", "apps/cli/tests/fake.expected.yml", "apps/cli/tests/fake.expected.json.bak",
                     "apps/cli/tests/workspace.expected/child.expected.jsonl", "apps/cli/tests/workspace.expected.json",
                     "apps/cli/tests/../../child.expected.jsonl", "apps/web/tests/child.expected.jsonl"):
            self.assertFalse(d.metadata_output(name))
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.check_changes({name: row()}, {name: row(stamp=2)}, {name})

    def test_new_files_including_candidate_name_forbidden(self):
        for name in (*d.CANDIDATES, "apps/cli/tests/new.expected.jsonl", "rogue.txt"):
            with self.subTest(name=name), self.assertRaisesRegex(d.Refusal, "new-file-forbidden"):
                d.check_changes({}, {name: row()}, {name})

    def test_deletion_forbidden(self):
        name = next(iter(d.CANDIDATES))
        with self.assertRaisesRegex(d.Refusal, "deletion-forbidden"):
            d.check_changes({name: row()}, {}, {name})

    def test_mode_and_symlink_mutation_forbidden(self):
        name = next(iter(d.CANDIDATES))
        for after in (row(mode=0o755), row(kind="link")):
            with self.subTest(after=after), self.assertRaises(d.Refusal):
                d.check_changes({name: row()}, {name: after}, {name})
        with self.assertRaises(d.Refusal):
            d.check_changes({name: row(kind="link")}, {name: row()}, {name})

    def test_replay_rejects_content_metadata_new_and_deleted_files(self):
        name = next(iter(d.CANDIDATES))
        for before, after in (({name: row()}, {name: row(b"new")}), ({name: row()}, {name: row(stamp=2)}),
                              ({}, {name: row()}), ({name: row()}, {})):
            with self.subTest(after=after), self.assertRaisesRegex(d.Refusal, "replay-wrote"):
                d.check_changes(before, after, {name}, replay=True)
        self.assertEqual(d.check_changes({name: row()}, {name: row()}, {name}, replay=True), [])

    def test_before_after_hash_binding(self):
        self.assertNotEqual(row()["sha256"], row(b"new")["sha256"])
        self.assertEqual(row()["sha256"], d.digest(b"old"))


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="expected-driver-test-", dir=DRIVER.parent.parent)
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
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def symlink(self, path, target, is_dir=False):
        try:
            path.symlink_to(target, target_is_directory=is_dir)
        except OSError:
            self.skipTest("symlink creation unavailable on this test platform")

    def test_early_output_unique_external_evidence(self):
        first, second = self.evidence(), self.evidence()
        self.assertNotEqual(first.path, second.path)
        self.assertFalse(first.path.is_relative_to(self.root))
        self.assertIn("evidence_path=" + str(first.path), self.output.read_text())

    def test_checkout_evidence_and_output_rejected(self):
        with self.assertRaises(d.Refusal):
            d.Evidence(self.root, dict(self.env, RUNNER_TEMP=str(self.root)))
        output = self.write("output")
        with self.assertRaises(d.Refusal):
            d.Evidence(self.root, dict(self.env, GITHUB_OUTPUT=str(output)))

    def test_traversal_and_git_internal_paths_rejected(self):
        for name in ("../secret", "/secret", ".git/config", "snapshots/../../secret"):
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.safe_path(self.root, name)

    def test_symlink_escape_rejected_without_reading_target_bytes(self):
        self.symlink(self.root / "escape", self.output)
        with self.assertRaisesRegex(d.Refusal, "symlink-escape"):
            d.safe_path(self.root, "escape")
        evidence = self.evidence()
        with mock.patch.object(evidence, "git", return_value=b"escape\0"):
            with self.assertRaises(d.Refusal):
                evidence.inventory()
            after = evidence.inventory(strict=False)
        self.assertEqual(after["escape"]["kind"], "unsafe-link")
        self.assertEqual((evidence.path / "blobs" / after["escape"]["sha256"]).read_bytes(),
                         os.fsencode(os.readlink(self.root / "escape")))

    def test_internal_alias_readable_but_symlink_parent_refused(self):
        target = self.write("dir/file")
        self.symlink(self.root / "alias", target)
        self.assertEqual(d.safe_path(self.root, "alias"), self.root / "alias")
        self.symlink(self.root / "linked", target.parent, True)
        with self.assertRaisesRegex(d.Refusal, "symlink-parent"):
            d.safe_path(self.root, "linked/file")

    def test_protected_tree_parent_escape_is_not_walked(self):
        outside = self.runner / "external-apps"
        (outside / "cli" / "tests").mkdir(parents=True)
        self.symlink(self.root / "apps", outside, True)
        evidence = self.evidence()
        with mock.patch.object(evidence, "git", return_value=b""), \
             mock.patch.object(d.os, "walk", return_value=[]) as walk:
            with self.assertRaises(d.Refusal):
                evidence.inventory()
            walk.assert_not_called()
            after = evidence.inventory(strict=False)
            self.assertEqual(after["apps/cli/tests"]["kind"], "unsafe-path")
            self.assertTrue(all(call.args[0] != self.root / "apps/cli/tests" for call in walk.call_args_list))

    def test_inventory_includes_ignored_files_in_all_protected_trees(self):
        names = [tree + "/rogue.tmp" for tree in d.PROTECTED_TREES]
        for name in names:
            self.write(name)
        evidence = self.evidence()
        with mock.patch.object(evidence, "git", return_value=b""):
            inventory = evidence.inventory()
        self.assertEqual(set(inventory), set(names))
        with self.assertRaises(d.Refusal):
            d.check_changes({}, inventory, set())

    def test_guard_failure_retains_early_evidence(self):
        with mock.patch.object(d.platform, "system", return_value="Linux"):
            status = d.execute(self.root, dict(self.env, GITHUB_REF="refs/heads/main"))
        self.assertEqual(status, 1)
        result = json.loads((next(self.runner.iterdir()) / "result.json").read_text())
        self.assertFalse(result["successful"])
        self.assertIn("evidence_path=", self.output.read_text())

    def test_failure_messages_sanitized_and_artifact_hashes_bound(self):
        with mock.patch.object(d.platform, "system", return_value="Linux"), \
             mock.patch.object(d, "source_guard", side_effect=RuntimeError("API_KEY=never-print-me")):
            self.assertEqual(d.execute(self.root, self.env), 1)
        path = next(self.runner.iterdir())
        result = (path / "result.json").read_bytes()
        self.assertNotIn(b"never-print-me", result)
        self.assertEqual(json.loads(result)["error_code"], "internal-failure")
        hashes = json.loads((path / "artifact-sha256.json").read_text())
        self.assertEqual(hashes["result.json"], d.digest(result))
        for name, sha in hashes.items():
            self.assertEqual(d.digest((path / name).read_bytes()), sha)

    def pipeline(self, failure=None, mutation=None, mutate_stage="refresh", timeout=None, lock_mismatch=False, capture_failure=None):
        for name in (d.WORKFLOW, d.DRIVER, d.TEST, "pnpm-lock.yaml", "vitest.expected.config.ts", *d.TARGET_FILES):
            self.write(name, b"input")
        self.write("package.json", json.dumps({"scripts": d.SCRIPT_VALUES}).encode())
        for name in d.CANDIDATES:
            self.write(name, ("original:" + name).encode())
        extra = "apps/cli/tests/other.expected.txt"
        self.write(extra)
        self.write("snapshots/case/session.v2.jsonl")
        tracked = {p.relative_to(self.root).as_posix() for p in self.root.rglob("*") if p.is_file()}
        evidence = self.evidence()
        stages, identity_checks = [], []
        candidate = d.OWNER + "expected/subagent-settlement/child.expected.jsonl"
        def git(*args, **kwargs):
            if args == ("ls-files", "-z", "--cached"):
                return b"\0".join(name.encode() for name in sorted(tracked))
            if args[0] == "ls-files":
                return b"\0".join(p.relative_to(self.root).as_posix().encode()
                                   for p in self.root.rglob("*") if p.is_file())
            if args[0] == "show":
                return b"wrong-lock" if lock_mismatch else b"input"
            if args[0] == "rev-parse":
                if stages:
                    identity_checks.append((stages[-1], "head"))
                return (b"b" if stages and stages[-1] == mutate_stage and mutation == "head" else b"a") * 40
            if args[:3] == ("diff", "--cached", "--name-only"):
                if stages:
                    identity_checks.append((stages[-1], "index"))
                return b"staged" if stages and stages[-1] == mutate_stage and mutation == "index" else b""
            return b"GIT binary patch\n"
        def run(label, argv, stage_timeout=60, env=None, accepted=(0,)):
            if label.startswith("version-"):
                return {"version-node": b"v24.1.0", "version-pnpm": b"11.7.0", "version-git": b"git version 2.49.0"}[label]
            stages.append(label)
            self.assertEqual(accepted, (0,))
            self.assertEqual(argv, d.REFRESH_COMMAND if label == "refresh" else d.REPLAY_COMMAND)
            self.assertEqual(stage_timeout, d.REFRESH_SECONDS if label == "refresh" else d.REPLAY_SECONDS)
            self.assertEqual(env["DSH_SNAPSHOT"], label)
            self.assertEqual(env["DSH_EXAMPLE_MODE"], "lib")
            self.assertEqual(env["DSH_TELEMETRY_DISABLED"], "1")
            self.assertNotIn("NODE_PATH", env)
            if label == "refresh":
                self.write(candidate, b"proposal")
            if label == mutate_stage:
                if mutation == "source":
                    self.write(d.DRIVER, b"bad")
                elif mutation == "canonical":
                    self.write("snapshots/case/session.v2.jsonl", b"bad")
                elif mutation == "metadata":
                    path = self.root / extra
                    info = path.stat()
                    os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
                elif mutation == "candidate":
                    self.write(candidate, b"replay-write")
                elif mutation == "new":
                    self.write("apps/cli/tests/new.expected.jsonl", b"bad")
            receipt = {"classification": "timeout" if timeout == label else "exited", "exit_code": 1 if failure == label else 0}
            d.write_json(evidence.path / (label + ".mock-receipt.json"), receipt)
            d.require(receipt["classification"] == "exited", "stage-timeout")
            d.require(receipt["exit_code"] == 0, "stage-failed")
            return b""
        original_capture = evidence.capture
        def capture(label, before):
            after = original_capture(label, before)
            d.require(capture_failure != label, "capture-failed")
            return after
        binding = {"source_sha": "a" * 40, "source_tree": "b" * 40, "base_sha": d.BASE, "base_tree": d.BASE_TREE}
        with mock.patch.object(d, "Evidence", return_value=evidence), \
             mock.patch.object(d.platform, "system", return_value="Linux"), \
             mock.patch.object(d, "source_guard", return_value=binding), \
             mock.patch.object(evidence, "git", side_effect=git), mock.patch.object(evidence, "run", side_effect=run), \
             mock.patch.object(evidence, "capture", side_effect=capture):
            status = d.execute(self.root, dict(self.env, DSH_EXAMPLE_MODE="injected", NODE_PATH="/injected"))
        return status, stages, evidence.path, identity_checks

    def test_pipeline_targeted_refresh_then_full_replay_and_all_four_candidates(self):
        status, stages, path, checks = self.pipeline()
        self.assertEqual(status, 0)
        self.assertEqual(stages, ["refresh", "replay"])
        self.assertEqual(checks, [(s, k) for s in stages for k in ("head", "index")])
        original = json.loads((path / "original.candidates.json").read_text())
        refreshed = json.loads((path / "refresh.candidates.json").read_text())
        replayed = json.loads((path / "replay.candidates.json").read_text())
        self.assertEqual(set(original), d.CANDIDATES)
        self.assertEqual(set(refreshed), d.CANDIDATES)
        self.assertEqual(refreshed, replayed)
        for name in d.CANDIDATES:
            self.assertEqual((path / "blobs" / original[name]["sha256"]).read_bytes(), ("original:" + name).encode())
            self.assertTrue((path / "blobs" / refreshed[name]["sha256"]).is_file())
        parent = d.OWNER + "expected/subagent-inheritance/parent.expected.jsonl"
        self.assertEqual(original[parent], refreshed[parent])
        self.assertEqual((path / "refresh.patch").read_bytes(), b"GIT binary patch\n")
        result = json.loads((path / "result.json").read_text())
        self.assertTrue(result["successful"])
        self.assertTrue(result["proposal_only"])
        self.assertFalse(result["independently_qualified"])

    def test_source_binding_hashes_scripts_lock_and_full_inventory(self):
        status, stages, path, checks = self.pipeline()
        binding = json.loads((path / "source-binding.json").read_text())
        self.assertEqual(binding["base_sha"], d.BASE)
        self.assertEqual(binding["base_tree"], d.BASE_TREE)
        self.assertEqual(binding["lock_sha256"], d.digest(b"input"))
        self.assertEqual(binding["input_sha256"][d.DRIVER], d.digest(b"input"))
        self.assertEqual(binding["all_generator_inputs"], "original.inventory.json")
        self.assertTrue(all(name in binding["input_sha256"] for name in d.TARGET_FILES))
        self.assertEqual(json.loads((path / "tool-versions.json").read_text())["pnpm"], "11.7.0")

    def test_refresh_exit_one_fails_without_retry_or_replay_and_keeps_bytes(self):
        status, stages, path, checks = self.pipeline(failure="refresh")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh"])
        self.assertEqual(checks, [("refresh", "head"), ("refresh", "index")])
        self.assertEqual((path / "blobs" / d.digest(b"proposal")).read_bytes(), b"proposal")
        self.assertTrue((path / "refresh.inventory.json").exists())
        self.assertFalse(json.loads((path / "result.json").read_text())["successful"])
        self.assertEqual(json.loads((path / "refresh.mock-receipt.json").read_text())["exit_code"], 1)

    def test_replay_failure_keeps_evidence_and_checks_head_index(self):
        status, stages, path, checks = self.pipeline(failure="replay")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh", "replay"])
        self.assertIn(("replay", "head"), checks)
        self.assertIn(("replay", "index"), checks)
        self.assertTrue((path / "replay.inventory.json").exists())

    def test_refresh_source_mutation_stops_before_replay_even_on_failure(self):
        status, stages, path, checks = self.pipeline(failure="refresh", mutation="source")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh"])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "non-candidate-content-mutation")
        self.assertIn(("refresh", "index"), checks)

    def test_canonical_snapshot_write_rejected(self):
        status, stages, path, checks = self.pipeline(mutation="canonical")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh"])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "non-candidate-content-mutation")

    def test_metadata_only_owner_refresh_allowed(self):
        status, stages, path, checks = self.pipeline(mutation="metadata")
        self.assertEqual(status, 0)
        self.assertEqual(stages, ["refresh", "replay"])

    def test_replay_metadata_write_rejected(self):
        status, stages, path, checks = self.pipeline(mutation="metadata", mutate_stage="replay")
        self.assertEqual(status, 1)
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "replay-wrote-source-or-output")

    def test_replay_content_write_rejected_and_retained(self):
        status, stages, path, checks = self.pipeline(mutation="candidate", mutate_stage="replay")
        self.assertEqual(status, 1)
        self.assertEqual((path / "blobs" / d.digest(b"replay-write")).read_bytes(), b"replay-write")
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "replay-wrote-source-or-output")

    def test_new_expected_file_rejected_and_retained(self):
        status, stages, path, checks = self.pipeline(mutation="new")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh"])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "new-file-forbidden")

    def test_head_and_index_mutations_rejected_on_both_stages(self):
        for stage in ("refresh", "replay"):
            for mutation in ("head", "index"):
                with self.subTest(stage=stage, mutation=mutation):
                    status, stages, path, checks = self.pipeline(mutation=mutation, mutate_stage=stage)
                    self.assertEqual(status, 1)
                    self.assertEqual(stages[-1], stage)
                    self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], mutation + "-mutated")

    def test_lock_mismatch_stops_before_refresh(self):
        status, stages, path, checks = self.pipeline(lock_mismatch=True)
        self.assertEqual(status, 1)
        self.assertEqual(stages, [])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "baseline-lock-mismatch")

    def test_capture_failure_still_checks_head_and_index_at_both_stages(self):
        for stage in ("refresh", "replay"):
            with self.subTest(stage=stage):
                status, stages, path, checks = self.pipeline(capture_failure=stage)
                self.assertEqual(status, 1)
                self.assertEqual(stages[-1], stage)
                self.assertIn((stage, "head"), checks)
                self.assertIn((stage, "index"), checks)
                self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "capture-failed")

    def test_stage_timeout_captures_failure_without_retry(self):
        status, stages, path, checks = self.pipeline(timeout="refresh")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh"])
        self.assertTrue((path / "refresh.candidates.json").exists())
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "stage-timeout")

    def run_fake_process(self, waits, returncode, error=None):
        evidence = self.evidence()
        proc = mock.Mock(pid=412345, returncode=returncode)
        proc.wait.side_effect = waits
        with mock.patch.object(d.subprocess, "Popen", return_value=proc) as popen, \
             mock.patch.object(d.os, "killpg", create=True) as kill, mock.patch.object(d.signal, "SIGKILL", 9, create=True):
            if error:
                with self.assertRaises(error):
                    evidence.run("fake", ["python", "offline-only"], timeout=7)
            else:
                evidence.run("fake", ["python", "offline-only"], timeout=7)
            kill.assert_called_once_with(proc.pid, 9)
            self.assertTrue(popen.call_args.kwargs["start_new_session"])
            self.assertNotIn("shell", popen.call_args.kwargs)
            self.assertEqual(proc.wait.call_args_list[-1], mock.call(timeout=10))
        return json.loads(next(evidence.path.glob("*.receipt.json")).read_text())

    def test_process_success_receipt_and_owned_group_cleanup(self):
        receipt = self.run_fake_process([0, 0], 0)
        self.assertEqual(receipt["classification"], "exited")
        self.assertEqual(receipt["exit_code"], 0)

    def test_process_exit_one_is_failure_with_raw_receipt(self):
        receipt = self.run_fake_process([1, 1], 1, d.Refusal)
        self.assertEqual(receipt["classification"], "exited")
        self.assertEqual(receipt["exit_code"], 1)

    def test_process_timeout_even_exit_zero_is_failure(self):
        receipt = self.run_fake_process([subprocess.TimeoutExpired("owned", 7), 0], 0, d.Refusal)
        self.assertEqual(receipt["classification"], "timeout")
        self.assertEqual(receipt["timeout_seconds"], 7)

    def test_cancellation_keeps_receipt_and_cleans_owned_group(self):
        receipt = self.run_fake_process([KeyboardInterrupt(), -9], -9, KeyboardInterrupt)
        self.assertEqual(receipt["classification"], "cancelled")

    def test_spawn_failure_never_kills_an_unowned_group(self):
        evidence = self.evidence()
        with mock.patch.object(d.subprocess, "Popen", side_effect=OSError("secret-never-print")), \
             mock.patch.object(d.os, "killpg", create=True) as kill:
            with self.assertRaises(OSError):
                evidence.run("fake", ["missing"])
            kill.assert_not_called()
        receipt = json.loads(next(evidence.path.glob("*.receipt.json")).read_text())
        self.assertEqual(receipt["classification"], "spawn-failed")
        self.assertNotIn("secret", json.dumps(receipt))


class SourceBinding(unittest.TestCase):
    def evidence(self, overrides=None, ancestor_error=False):
        root = Path.cwd().resolve()
        values = {("rev-parse", "--show-toplevel"): str(root).encode(), ("rev-parse", "HEAD"): b"a" * 40,
                  ("status", "--porcelain=v1", "--untracked-files=all"): b"",
                  ("rev-parse", d.BASE + "^{tree}"): d.BASE_TREE.encode(),
                  ("merge-base", "--is-ancestor", d.BASE, "HEAD"): b"",
                  ("diff", "--no-renames", "--name-only", "-z", d.BASE, "HEAD"): (d.DRIVER + "\0").encode(),
                  ("rev-parse", "HEAD^{tree}"): b"b" * 40}
        values.update(overrides or {})
        def git(*args):
            if ancestor_error and args[0] == "merge-base":
                raise d.Refusal("stage-failed")
            return values[args]
        return mock.Mock(root=root, git=mock.Mock(side_effect=git))

    def test_new_fixed_base_tree_and_exact_four_infrastructure_paths(self):
        self.assertEqual(d.BASE, "1f429e3245fe516b429547698b9399d8934b01cb")
        self.assertEqual(d.BASE_TREE, "462497bc508bc23be34297d9ac587cde45932fbf")
        self.assertEqual(d.REF, "refs/heads/cloga-auto-minimal-expected-113")
        self.assertEqual(d.INFRASTRUCTURE, {".github/workflows/auto-expected-prepare.yml",
                         "scripts/ci-workflow.spec.ts", "scripts/prepare-auto-expected-goldens.py",
                         "scripts/test_prepare_auto_expected_goldens.py"})

    def test_exact_source_commit_and_tree_binding(self):
        binding = d.source_guard(self.evidence(), environment())
        self.assertEqual(binding["source_sha"], "a" * 40)
        self.assertEqual(binding["source_tree"], "b" * 40)
        self.assertEqual(binding["base_sha"], d.BASE)

    def test_head_must_match_trigger(self):
        with self.assertRaisesRegex(d.Refusal, "head-trigger-mismatch"):
            d.source_guard(self.evidence({("rev-parse", "HEAD"): b"c" * 40}), environment())

    def test_clean_tracked_and_untracked_source_required(self):
        for value in (b" M source.ts\n", b"?? rogue.txt\n"):
            with self.subTest(value=value), self.assertRaisesRegex(d.Refusal, "dirty-checkout"):
                d.source_guard(self.evidence({("status", "--porcelain=v1", "--untracked-files=all"): value}), environment())

    def test_exact_baseline_tree_required(self):
        with self.assertRaisesRegex(d.Refusal, "baseline-tree-mismatch"):
            d.source_guard(self.evidence({("rev-parse", d.BASE + "^{tree}"): b"c" * 40}), environment())

    def test_baseline_must_be_an_ancestor(self):
        with self.assertRaises(d.Refusal):
            d.source_guard(self.evidence(ancestor_error=True), environment())

    def test_extra_infrastructure_and_source_deltas_rejected(self):
        key = ("diff", "--no-renames", "--name-only", "-z", d.BASE, "HEAD")
        for name in ("packages/core/source.ts", ".github/workflows/auto-routing-prepare.yml",
                     "scripts/prepare-auto-snapshot-goldens.py", next(iter(d.CANDIDATES))):
            with self.subTest(name=name), self.assertRaisesRegex(d.Refusal, "runtime-differs"):
                d.source_guard(self.evidence({key: name.encode() + b"\0"}), environment())
        d.source_guard(self.evidence({key: b"\0".join(name.encode() for name in d.INFRASTRUCTURE)}), environment())

    def test_checkout_root_required(self):
        with self.assertRaisesRegex(d.Refusal, "checkout-root-required"):
            d.source_guard(self.evidence({("rev-parse", "--show-toplevel"): b"/somewhere/else"}), environment())


if __name__ == "__main__":
    unittest.main()
