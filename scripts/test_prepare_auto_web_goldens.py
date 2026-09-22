"""Offline stdlib tests: python3 -B scripts/test_prepare_auto_web_goldens.py.

No Git/package commands, browser/model calls, builds or real refreshes execute.
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

DRIVER = Path(__file__).with_name("prepare-auto-web-goldens.py")
spec = importlib.util.spec_from_file_location("web_proposal", DRIVER)
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

    def test_exact_linux_push_identity_allowed(self):
        d.guard_environment(environment(), "Linux")

    def test_wrong_repository_ref_event_attempt_sha_and_platform_rejected(self):
        for key, value in {"GITHUB_ACTIONS": "false", "GITHUB_REPOSITORY": "fork/deepseek-harness",
                           "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "pull_request",
                           "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "HEAD"}.items():
            with self.subTest(key=key), self.assertRaises(d.Refusal):
                d.guard_environment(dict(environment(), **{key: value}), "Linux")
        for system in ("Windows", "Darwin"):
            with self.subTest(system=system), self.assertRaisesRegex(d.Refusal, "linux-required"):
                d.guard_environment(environment(), system)

    def test_inherited_record_refresh_and_loader_options_rejected(self):
        for mode in ("refresh", "record", "", "arbitrary"):
            with self.subTest(mode=mode), self.assertRaises(d.Refusal):
                d.guard_environment(dict(environment(), DSH_SNAPSHOT=mode), "Linux")
        with self.assertRaises(d.Refusal):
            d.guard_environment(dict(environment(), NODE_OPTIONS="--import=/injected"), "Linux")

    def test_exact_maintained_commands_without_filters_or_hmr_skip(self):
        targets = ["apps/web/tests/cordis-tool-round.e2e.ts", "apps/web/tests/ptc-round.e2e.ts",
                   "apps/web/tests/replay-round-trip.e2e.ts", "apps/web/tests/plugin-config.e2e.ts",
                   "apps/web/tests/manual-compact-model-selection.e2e.ts"]
        self.assertEqual(d.TARGET_FILES, targets)
        self.assertEqual(d.REFRESH_COMMAND, ["pnpm", "run", "test:web:built", *targets])
        self.assertEqual(d.REPLAY_COMMAND, ["pnpm", "run", "test:web:ci"])
        self.assertEqual(d.SCRIPT_VALUES, {"test:web:built": "vitest run --config vitest.web.config.ts",
                                          "test:web:ci": "tsx scripts/run-web-snapshots.ts"})
        self.assertEqual((d.REFRESH_SECONDS, d.REPLAY_SECONDS), (600, 1200))
        self.assertNotIn("--exclude", " ".join(d.REPLAY_COMMAND))
        self.assertNotIn("-t", d.REFRESH_COMMAND)

    def test_changed_script_contract_rejected(self):
        d.check_scripts(json.dumps({"scripts": d.SCRIPT_VALUES}))
        for value in ("vitest run --exclude=apps/web/tests/hmr-live.e2e.ts", "node custom-generator.js", "pnpm run test:web:built"):
            with self.subTest(value=value), self.assertRaises(d.Refusal):
                d.check_scripts(json.dumps({"scripts": dict(d.SCRIPT_VALUES, **{"test:web:ci": value})}))

    def test_lib_telemetry_and_worker_count_are_owned(self):
        for mode in (None, "refresh", "replay"):
            for inherited in (None, "", "source", "lib", "arbitrary"):
                env = dict(environment(), DSH_WEB_SNAPSHOT_WORKERS="99", DSH_TELEMETRY_DISABLED="0")
                if inherited is not None:
                    env["DSH_EXAMPLE_MODE"] = inherited
                child = d.child_environment(env, mode)
                self.assertEqual(child["DSH_EXAMPLE_MODE"], "lib")
                self.assertEqual(child["DSH_TELEMETRY_DISABLED"], "1")
                self.assertEqual(env.get("DSH_EXAMPLE_MODE"), inherited)
                if mode == "replay":
                    self.assertEqual(child["DSH_WEB_SNAPSHOT_WORKERS"], "2")
                else:
                    self.assertNotIn("DSH_WEB_SNAPSHOT_WORKERS", child)
                if mode is not None:
                    self.assertEqual(child["DSH_SNAPSHOT"], mode)
        with self.assertRaises(d.Refusal):
            d.child_environment(environment(), "record")

    def test_no_node_injection_api_secrets_or_skip_knobs_forwarded(self):
        env = dict(environment(), NODE_PATH="/injected", NODE_OPTIONS="--import=/injected", DEEPSEEK_API_KEY="secret",
                   GH_TOKEN="secret", DSH_SKIP_HMR="1", VITEST_SKIP="1", HOME="/home/runner", PNPM_HOME="/pnpm",
                   NODE_EXTRA_CA_CERTS="/trusted/cert.pem", PLAYWRIGHT_BROWSERS_PATH="/browsers", TMPDIR="/temp")
        for mode in ("refresh", "replay"):
            child = d.child_environment(env, mode)
            for name in ("NODE_PATH", "NODE_OPTIONS", "DEEPSEEK_API_KEY", "GH_TOKEN", "DSH_SKIP_HMR", "VITEST_SKIP"):
                self.assertNotIn(name, child)
            for name in ("PATH", "HOME", "PNPM_HOME", "NODE_EXTRA_CA_CERTS", "PLAYWRIGHT_BROWSERS_PATH", "TMPDIR"):
                self.assertEqual(child[name], env[name])

    def test_literal_current_session_version_three_required(self):
        self.assertEqual(d.current_version("export const SESSION_FORMAT_VERSION = 3\n"), 3)
        for value in ("export const SESSION_FORMAT_VERSION = 2", "export const SESSION_FORMAT_VERSION = VERSION",
                      "export const SESSION_FORMAT_VERSION = 3\nexport const SESSION_FORMAT_VERSION = 3"):
            with self.subTest(value=value), self.assertRaises(d.Refusal):
                d.current_version(value)


class ChangePolicy(unittest.TestCase):
    def test_exact_twenty_two_content_candidates_exclude_hmr(self):
        expected = {
            "snapshots/web/cordis-tool-round/session.v3.jsonl",
            "snapshots/web/cordis-tool-round/system-prompt.expected.md",
            "snapshots/web/cordis-tool-round/tool-schemas.expected.json",
            "snapshots/web/cordis-tool-round/ui.expected.md",
            "snapshots/web/ptc-round/session.v3.jsonl",
            "snapshots/web/ptc-round/system-prompt.expected.md",
            "snapshots/web/ptc-round/tool-schemas.expected.json",
            "snapshots/web/ptc-round/ui.expected.md",
            "snapshots/web/ptc-round/trajectory.expected.md",
            "snapshots/web/ptc-round/code.expected.md",
            "snapshots/web/fresh-round-trip/session.v3.jsonl",
            "snapshots/web/fresh-round-trip/system-prompt.expected.md",
            "snapshots/web/fresh-round-trip/tool-schemas.expected.json",
            "snapshots/web/fresh-round-trip/ui.expected.md",
            "snapshots/web/fresh-round-trip/submission-echo.expected.md",
            "snapshots/web/fresh-round-trip/ui-expanded.expected.md",
            "snapshots/web/fresh-round-trip/web-context.expected.md",
            "snapshots/web/manual-compact-model-selection/session.v3.jsonl",
            "snapshots/web/manual-compact-model-selection/system-prompt.expected.md",
            "snapshots/web/manual-compact-model-selection/tool-schemas.expected.json",
            "snapshots/web/manual-compact-model-selection/checkpoint.expected.md",
            "apps/web/tests/expected/plugin-config/section.expected.md",
        }
        self.assertEqual(len(d.CANDIDATES), 22)
        self.assertEqual(d.CANDIDATES, expected)
        self.assertIn(d.UI_ORACLE, d.CANDIDATES)
        self.assertNotIn(d.HMR_SOURCE, d.CANDIDATES)

    def test_only_candidates_allow_refresh_content_or_metadata_changes(self):
        for name in d.CANDIDATES:
            for after in (row(b"new"), row(stamp=2)):
                flags = d.check_changes({name: row()}, {name: after}, {name}, "refresh")
                self.assertFalse(flags["ownedHmrMetadataRestored"])
                self.assertNotIn("ownedUiMetadataUnchanged", flags)

    def test_cordis_ui_is_now_an_ordinary_content_candidate(self):
        name = d.UI_ORACLE
        for after in (row(b"different-aria"), row(stamp=2)):
            flags = d.check_changes({name: row()}, {name: after}, {name}, "refresh")
            self.assertNotIn("ownedUiMetadataUnchanged", flags)
            self.assertFalse(flags["ownedHmrMetadataRestored"])
        for after in (row(kind="link"), row(mode=0o755)):
            with self.subTest(after=after), self.assertRaises(d.Refusal):
                d.check_changes({name: row()}, {name: after}, {name}, "refresh")

    def test_ui_replay_metadata_is_not_exempt(self):
        name = d.UI_ORACLE
        with self.assertRaisesRegex(d.Refusal, "replay-wrote"):
            d.check_changes({name: row()}, {name: row(stamp=2)}, {name}, "replay")

    def test_hmr_exact_source_metadata_only_replay_exception(self):
        self.assertEqual(d.HMR_SOURCE, "packages/client/ui-conversation/src/client/locales.ts")
        name = d.HMR_SOURCE
        flags = d.check_changes({name: row()}, {name: row(stamp=2)}, {name}, "replay")
        self.assertTrue(flags["ownedHmrMetadataRestored"])
        self.assertNotIn("ownedUiMetadataUnchanged", flags)
        self.assertFalse(d.check_changes({name: row()}, {name: row()}, {name}, "replay")["ownedHmrMetadataRestored"])

    def test_hmr_content_mode_link_and_untracked_changes_never_exempt(self):
        name = d.HMR_SOURCE
        for after in (row(b"not-restored"), row(kind="link"), row(mode=0o755)):
            with self.subTest(after=after), self.assertRaises(d.Refusal):
                d.check_changes({name: row()}, {name: after}, {name}, "replay")
        with self.assertRaises(d.Refusal):
            d.check_changes({name: row()}, {name: row(stamp=2)}, set(), "replay")

    def test_hmr_refresh_metadata_is_not_exempt(self):
        name = d.HMR_SOURCE
        with self.assertRaises(d.Refusal):
            d.check_changes({name: row()}, {name: row(stamp=2)}, {name}, "refresh")

    def test_other_source_and_neighbor_metadata_changes_are_rejected(self):
        for name in ("packages/client/ui-conversation/src/client/other.ts", d.HMR_TEST, d.TARGET,
                     "snapshots/web/other/ui.expected.md", "apps/cli/tests/child.expected.jsonl", "pnpm-lock.yaml"):
            for stage in ("refresh", "replay"):
                with self.subTest(name=name, stage=stage), self.assertRaises(d.Refusal):
                    d.check_changes({name: row()}, {name: row(stamp=2)}, {name}, stage)

    def test_canonical_history_inputs_and_configs_cannot_change(self):
        for name in (d.OWNER + "session.jsonl", d.OWNER + "session.v1.jsonl", d.OWNER + "session.1.v2.jsonl",
                     d.OWNER + "session.v4.jsonl", d.OWNER + "snapshot.yml", "snapshots/other/session.v3.jsonl",
                     "scripts/snapshots/session.v3.jsonl", d.TARGET, d.HMR_TEST, "package.json", "pnpm-lock.yaml",
                     "vitest.web.config.ts", "scripts/run-web-snapshots.ts"):
            for stage in ("refresh", "replay"):
                with self.subTest(name=name, stage=stage), self.assertRaises(d.Refusal):
                    d.check_changes({name: row()}, {name: row(b"new")}, {name}, stage)

    def test_expansion_never_admits_sibling_extra_or_historical_outputs(self):
        for owner in ("cordis-tool-round", "ptc-round", "fresh-round-trip", "manual-compact-model-selection"):
            for filename in ("extra.expected.md", "session.v2.jsonl", "session.1.v3.jsonl", "snapshot.yml"):
                name = "snapshots/web/" + owner + "/" + filename
                for after in (row(b"new"), row(stamp=2)):
                    with self.subTest(name=name, after=after), self.assertRaises(d.Refusal):
                        d.check_changes({name: row()}, {name: after}, {name}, "refresh")
        for name in ("apps/web/tests/expected/plugin-config/extra.expected.md",
                     "apps/web/tests/expected/plugin-config-other/section.expected.md"):
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.check_changes({name: row()}, {name: row(b"new")}, {name}, "refresh")

    def test_candidate_replay_content_and_metadata_writes_rejected(self):
        for name in d.CANDIDATES:
            for after in (row(b"new"), row(stamp=2)):
                with self.subTest(name=name, after=after), self.assertRaisesRegex(d.Refusal, "replay-wrote"):
                    d.check_changes({name: row()}, {name: after}, {name}, "replay")

    def test_new_files_deletions_modes_and_links_rejected(self):
        for name in (*d.CANDIDATES, d.HMR_SOURCE, d.UI_ORACLE):
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.check_changes({}, {name: row()}, {name}, "refresh")
            for after in ({}, {name: row(kind="link")}, {name: row(mode=0o755)}):
                with self.subTest(name=name, after=after), self.assertRaises(d.Refusal):
                    d.check_changes({name: row()}, after, {name}, "refresh")

    def test_candidates_and_exceptions_must_preexist_tracked_regular(self):
        before = {name: row() for name in d.CANDIDATES | {d.HMR_SOURCE, d.UI_ORACLE}}
        d.check_required_files(before, set(before))
        for name in before:
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.check_required_files(before, set(before) - {name})
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.check_required_files(dict(before, **{name: row(kind="link")}), set(before))


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="web-driver-test-", dir=DRIVER.parent.parent)
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
                path = Path(directory) / name
                if not path.is_symlink():
                    path.chmod(0o600)
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

    def test_early_unique_external_evidence_path(self):
        first, second = self.evidence(), self.evidence()
        self.assertNotEqual(first.path, second.path)
        self.assertFalse(first.path.is_relative_to(self.root))
        self.assertIn("evidence_path=" + str(first.path), self.output.read_text())

    def test_evidence_and_github_output_inside_checkout_refused(self):
        with self.assertRaises(d.Refusal):
            d.Evidence(self.root, dict(self.env, RUNNER_TEMP=str(self.root)))
        with self.assertRaises(d.Refusal):
            d.Evidence(self.root, dict(self.env, GITHUB_OUTPUT=str(self.write("output"))))

    def test_traversal_and_git_internal_paths_rejected(self):
        for name in ("../secret", "/secret", ".git/config", "snapshots/../../secret"):
            with self.subTest(name=name), self.assertRaises(d.Refusal):
                d.safe_path(self.root, name)

    def test_escape_link_rejected_without_dereferencing(self):
        self.symlink(self.root / "escape", self.output)
        evidence = self.evidence()
        with mock.patch.object(evidence, "git", return_value=b"escape\0"):
            with self.assertRaises(d.Refusal):
                evidence.inventory()
            after = evidence.inventory(strict=False)
        self.assertEqual(after["escape"]["kind"], "unsafe-link")
        self.assertEqual((evidence.path / "blobs" / after["escape"]["sha256"]).read_bytes(),
                         os.fsencode(os.readlink(self.root / "escape")))

    def test_contained_link_readable_but_symlink_parent_refused(self):
        target = self.write("dir/file")
        self.symlink(self.root / "alias", target)
        self.assertEqual(d.safe_path(self.root, "alias"), self.root / "alias")
        self.symlink(self.root / "linked", target.parent, True)
        with self.assertRaisesRegex(d.Refusal, "symlink-parent"):
            d.safe_path(self.root, "linked/file")

    def test_protected_tree_escape_never_walked(self):
        outside = self.runner / "external-snapshots"
        outside.mkdir()
        self.symlink(self.root / "snapshots", outside, True)
        evidence = self.evidence()
        with mock.patch.object(evidence, "git", return_value=b""), mock.patch.object(d.os, "walk", return_value=[]) as walk:
            with self.assertRaises(d.Refusal):
                evidence.inventory()
            walk.assert_not_called()
            after = evidence.inventory(strict=False)
            self.assertEqual(after["snapshots"]["kind"], "unsafe-link")
            self.assertTrue(all(call.args[0] != self.root / "snapshots" for call in walk.call_args_list))

    def test_ignored_files_in_all_protected_trees_captured(self):
        names = [tree + "/rogue.tmp" for tree in d.PROTECTED_TREES]
        for name in names:
            self.write(name)
        evidence = self.evidence()
        with mock.patch.object(evidence, "git", return_value=b""):
            inventory = evidence.inventory()
        self.assertEqual(set(inventory), set(names))
        with self.assertRaises(d.Refusal):
            d.check_changes({}, inventory, set(), "refresh")

    def test_root_dotenv_fails_before_commands_and_without_copying_secrets(self):
        self.write(".env", b"API_KEY=never-copy-this")
        with mock.patch.object(d.platform, "system", return_value="Linux"), mock.patch.object(d, "source_guard") as source:
            self.assertEqual(d.execute(self.root, self.env), 1)
            source.assert_not_called()
        path = next(self.runner.iterdir())
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "root-dotenv-forbidden")
        for file in path.rglob("*"):
            if file.is_file():
                self.assertNotIn(b"never-copy-this", file.read_bytes())

    def test_root_dotenv_symlink_forbidden_even_when_dangling(self):
        self.symlink(self.root / ".env", self.runner / "missing")
        with self.assertRaises(d.Refusal):
            d.require_keyless_checkout(self.root)

    def test_poststage_dotenv_records_presence_not_secret_bytes_or_diff(self):
        self.write(".env", b"API_KEY=secret-during-stage")
        evidence = self.evidence()
        with mock.patch.object(evidence, "git", return_value=b"") as git:
            with self.assertRaisesRegex(d.Refusal, "unsafe-tree-diff-refused"):
                evidence.capture("refresh", {})
            self.assertFalse(any(call.args[0] == "diff" for call in git.call_args_list))
        inventory = json.loads((evidence.path / "refresh.inventory.json").read_text())
        self.assertEqual(inventory[".env"]["kind"], "forbidden-env")
        self.assertEqual(list((evidence.path / "blobs").iterdir()), [])

    def test_guard_failure_still_publishes_evidence(self):
        with mock.patch.object(d.platform, "system", return_value="Linux"):
            self.assertEqual(d.execute(self.root, dict(self.env, GITHUB_REF="refs/heads/main")), 1)
        self.assertIn("evidence_path=", self.output.read_text())
        self.assertFalse(json.loads((next(self.runner.iterdir()) / "result.json").read_text())["successful"])

    def test_errors_sanitized_and_artifact_hashes_exact(self):
        with mock.patch.object(d.platform, "system", return_value="Linux"), \
             mock.patch.object(d, "source_guard", side_effect=RuntimeError("TOKEN=never-print")):
            self.assertEqual(d.execute(self.root, self.env), 1)
        path = next(self.runner.iterdir())
        hashes = json.loads((path / "artifact-sha256.json").read_text())
        for name, sha in hashes.items():
            data = (path / name).read_bytes()
            self.assertEqual(d.digest(data), sha)
            self.assertNotIn(b"never-print", data)

    def pipeline(self, failure=None, mutation=None, mutate_stage="refresh", timeout=None, capture_failure=None, lock_mismatch=False):
        for name in (d.WORKFLOW, d.DRIVER, d.TEST, "pnpm-lock.yaml", "vitest.web.config.ts", *d.TARGET_FILES,
                     "apps/web/tests/scaffold.ts", "scripts/run-web-snapshots.ts", d.HMR_TEST, d.HMR_SOURCE, d.UI_ORACLE):
            self.write(name, b"input")
        self.write("package.json", json.dumps({"scripts": d.SCRIPT_VALUES}).encode())
        self.write(d.VERSION_SOURCE, b"export const SESSION_FORMAT_VERSION = 3\n")
        for name in d.CANDIDATES:
            self.write(name, ("original:" + name).encode())
        self.write(d.OWNER + "session.v2.jsonl")
        tracked = {p.relative_to(self.root).as_posix() for p in self.root.rglob("*") if p.is_file()}
        evidence = self.evidence()
        stages, identity_checks = [], []
        def touch(name):
            path = self.root / name
            info = path.stat()
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
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
            self.assertNotIn("DSH_SKIP_HMR", env)
            if label == "refresh":
                self.assertNotIn("DSH_WEB_SNAPSHOT_WORKERS", env)
                self.write(d.OWNER + "session.v3.jsonl", b"proposal")
                touch(d.UI_ORACLE)
            else:
                self.assertEqual(env["DSH_WEB_SNAPSHOT_WORKERS"], "2")
                touch(d.HMR_SOURCE)
            if label == mutate_stage:
                if mutation == "source":
                    self.write(d.DRIVER, b"bad")
                elif mutation == "history":
                    self.write(d.OWNER + "session.v2.jsonl", b"bad")
                elif mutation == "ui-content":
                    self.write(d.UI_ORACLE, b"changed-aria")
                elif mutation == "ui-metadata":
                    touch(d.UI_ORACLE)
                elif mutation == "hmr-content":
                    self.write(d.HMR_SOURCE, b"not-restored")
                elif mutation == "hmr-metadata":
                    touch(d.HMR_SOURCE)
                elif mutation == "candidate":
                    self.write(d.OWNER + "session.v3.jsonl", b"replay-write")
                elif mutation == "neighbor-metadata":
                    touch(d.HMR_TEST)
                elif mutation == "new":
                    self.write(d.OWNER + "extra.expected.jsonl", b"bad")
            manual_failure = failure == "manual-compact" and label == "refresh"
            if manual_failure:
                self.write("snapshots/web/manual-compact-model-selection/checkpoint.expected.md", b"partial-manual-checkpoint")
                (evidence.path / "refresh.mock.stderr").write_text("AggregateError: manual compact Web fixture cleanup failed\n", encoding="utf-8")
            receipt = {"classification": "timeout" if timeout == label else "exited",
                       "exit_code": 1 if failure == label or manual_failure else 0}
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
            status = d.execute(self.root, dict(self.env, DSH_EXAMPLE_MODE="injected", NODE_PATH="/injected",
                                             DSH_WEB_SNAPSHOT_WORKERS="99", DSH_SKIP_HMR="1"))
        return status, stages, evidence.path, identity_checks

    def test_pipeline_targeted_refresh_then_ordinary_gate_records_exact_exceptions(self):
        status, stages, path, checks = self.pipeline()
        self.assertEqual(status, 0)
        self.assertEqual(stages, ["refresh", "replay"])
        self.assertEqual(checks, [(stage, key) for stage in stages for key in ("head", "index")])
        result = json.loads((path / "result.json").read_text())
        self.assertTrue(result["successful"])
        self.assertTrue(result["ownedHmrMetadataRestored"])
        self.assertNotIn("ownedUiMetadataUnchanged", result)
        self.assertTrue(result["proposal_only"])
        self.assertFalse(result["independently_qualified"])
        self.assertEqual((path / "refresh.patch").read_bytes(), b"GIT binary patch\n")

    def test_all_twenty_two_originals_and_proposals_including_unchanged_are_retained(self):
        status, stages, path, checks = self.pipeline()
        original = json.loads((path / "original.candidates.json").read_text())
        refreshed = json.loads((path / "refresh.candidates.json").read_text())
        replayed = json.loads((path / "replay.candidates.json").read_text())
        self.assertEqual(set(original), d.CANDIDATES)
        self.assertEqual(set(refreshed), d.CANDIDATES)
        self.assertEqual(refreshed, replayed)
        self.assertEqual(len(original), 22)
        self.assertIn(d.UI_ORACLE, original)
        self.assertNotIn(d.HMR_SOURCE, original)
        for name in d.CANDIDATES:
            self.assertEqual((path / "blobs" / original[name]["sha256"]).read_bytes(), ("original:" + name).encode())
            self.assertTrue((path / "blobs" / refreshed[name]["sha256"]).is_file())
        self.assertEqual(original[d.OWNER + "system-prompt.expected.md"], refreshed[d.OWNER + "system-prompt.expected.md"])
        inventory = json.loads((path / "replay.inventory.json").read_text())
        self.assertEqual(inventory[d.HMR_SOURCE]["sha256"], d.digest(b"input"))
        self.assertEqual(inventory[d.UI_ORACLE]["sha256"], d.digest(("original:" + d.UI_ORACLE).encode()))

    def test_source_binding_includes_hmr_gate_scaffold_scripts_and_lock(self):
        status, stages, path, checks = self.pipeline()
        binding = json.loads((path / "source-binding.json").read_text())
        self.assertEqual(binding["base_sha"], d.BASE)
        self.assertEqual(binding["lock_sha256"], d.digest(b"input"))
        self.assertEqual(binding["session_format_version"], 3)
        self.assertEqual(binding["all_generator_inputs"], "original.inventory.json")
        for name in (d.WORKFLOW, d.DRIVER, d.TEST, d.HMR_SOURCE, d.HMR_TEST, *d.TARGET_FILES,
                     "apps/web/tests/scaffold.ts", "scripts/run-web-snapshots.ts"):
            self.assertEqual(binding["input_sha256"][name], d.digest(b"input"))
        self.assertEqual(json.loads((path / "tool-versions.json").read_text())["pnpm"], "11.7.0")

    def test_refresh_exit_one_keeps_partial_evidence_and_never_retries(self):
        status, stages, path, checks = self.pipeline(failure="refresh")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh"])
        self.assertEqual(checks, [("refresh", "head"), ("refresh", "index")])
        self.assertEqual((path / "blobs" / d.digest(b"proposal")).read_bytes(), b"proposal")
        self.assertFalse(json.loads((path / "result.json").read_text())["successful"])
        self.assertEqual(json.loads((path / "refresh.mock-receipt.json").read_text())["exit_code"], 1)

    def test_manual_compact_cleanup_error_is_a_strict_refresh_failure(self):
        status, stages, path, checks = self.pipeline(failure="manual-compact")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh"])
        result = json.loads((path / "result.json").read_text())
        self.assertFalse(result["successful"])
        self.assertEqual(result["error_code"], "stage-failed")
        self.assertIn("AggregateError", (path / "refresh.mock.stderr").read_text())
        self.assertEqual(json.loads((path / "refresh.mock-receipt.json").read_text())["exit_code"], 1)
        proposals = json.loads((path / "refresh.candidates.json").read_text())
        self.assertEqual(len(proposals), 22)
        name = "snapshots/web/manual-compact-model-selection/checkpoint.expected.md"
        self.assertEqual((path / "blobs" / proposals[name]["sha256"]).read_bytes(), b"partial-manual-checkpoint")
        self.assertIn(("refresh", "index"), checks)

    def test_replay_failure_with_restored_hmr_remains_unsuccessful(self):
        status, stages, path, checks = self.pipeline(failure="replay")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh", "replay"])
        self.assertIn(("replay", "index"), checks)
        result = json.loads((path / "result.json").read_text())
        self.assertFalse(result["successful"])
        self.assertTrue(result["ownedHmrMetadataRestored"])
        self.assertEqual(result["error_code"], "stage-failed")

    def test_cordis_ui_content_proposal_requires_successful_full_replay(self):
        status, stages, path, checks = self.pipeline(mutation="ui-content")
        self.assertEqual(status, 0)
        self.assertEqual(stages, ["refresh", "replay"])
        self.assertTrue(json.loads((path / "result.json").read_text())["successful"])
        proposals = json.loads((path / "refresh.candidates.json").read_text())
        self.assertEqual(proposals[d.UI_ORACLE]["sha256"], d.digest(b"changed-aria"))
        self.assertEqual((path / "blobs" / d.digest(b"changed-aria")).read_bytes(), b"changed-aria")

    def test_hmr_unrestored_content_fails_and_is_not_flagged_restored(self):
        status, stages, path, checks = self.pipeline(mutation="hmr-content", mutate_stage="replay")
        self.assertEqual(status, 1)
        result = json.loads((path / "result.json").read_text())
        self.assertFalse(result["ownedHmrMetadataRestored"])
        self.assertEqual(result["error_code"], "replay-wrote-source-or-output")
        self.assertEqual((path / "blobs" / d.digest(b"not-restored")).read_bytes(), b"not-restored")

    def test_ui_or_neighbor_replay_metadata_fails(self):
        for mutation in ("ui-metadata", "neighbor-metadata"):
            with self.subTest(mutation=mutation):
                status, stages, path, checks = self.pipeline(mutation=mutation, mutate_stage="replay")
                self.assertEqual(status, 1)
                self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "replay-wrote-source-or-output")

    def test_hmr_refresh_metadata_fails(self):
        status, stages, path, checks = self.pipeline(mutation="hmr-metadata")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh"])

    def test_source_and_history_changes_fail_even_on_failed_stage(self):
        for mutation in ("source", "history"):
            with self.subTest(mutation=mutation):
                status, stages, path, checks = self.pipeline(failure="refresh", mutation=mutation)
                self.assertEqual(status, 1)
                self.assertEqual(stages, ["refresh"])
                self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "non-candidate-refresh-mutation")
                self.assertIn(("refresh", "index"), checks)

    def test_replay_candidate_write_is_retained_and_rejected(self):
        status, stages, path, checks = self.pipeline(mutation="candidate", mutate_stage="replay")
        self.assertEqual(status, 1)
        self.assertEqual((path / "blobs" / d.digest(b"replay-write")).read_bytes(), b"replay-write")
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "replay-wrote-source-or-output")

    def test_extra_output_creation_fails(self):
        status, stages, path, checks = self.pipeline(mutation="new")
        self.assertEqual(status, 1)
        self.assertEqual(stages, ["refresh"])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "new-file-forbidden")

    def test_head_or_index_drift_never_grants_hmr_exception(self):
        for mutation in ("head", "index"):
            with self.subTest(mutation=mutation):
                status, stages, path, checks = self.pipeline(mutation=mutation, mutate_stage="replay")
                self.assertEqual(status, 1)
                result = json.loads((path / "result.json").read_text())
                self.assertFalse(result["ownedHmrMetadataRestored"])
                self.assertEqual(result["error_code"], mutation + "-mutated")
                self.assertIn(("replay", "head"), checks)
                self.assertIn(("replay", "index"), checks)

    def test_lock_mismatch_stops_before_refresh(self):
        status, stages, path, checks = self.pipeline(lock_mismatch=True)
        self.assertEqual(status, 1)
        self.assertEqual(stages, [])
        self.assertEqual(json.loads((path / "result.json").read_text())["error_code"], "baseline-lock-mismatch")

    def test_capture_failure_still_checks_head_and_index_at_each_stage(self):
        for stage in ("refresh", "replay"):
            with self.subTest(stage=stage):
                status, stages, path, checks = self.pipeline(capture_failure=stage)
                self.assertEqual(status, 1)
                self.assertEqual(stages[-1], stage)
                self.assertIn((stage, "head"), checks)
                self.assertIn((stage, "index"), checks)

    def test_timeout_captures_partial_outputs_without_retry(self):
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

    def test_process_success_receipt_and_owned_cleanup(self):
        receipt = self.run_fake_process([0, 0], 0)
        self.assertEqual(receipt["classification"], "exited")
        self.assertEqual(receipt["exit_code"], 0)

    def test_process_exit_one_keeps_raw_failure(self):
        receipt = self.run_fake_process([1, 1], 1, d.Refusal)
        self.assertEqual(receipt["exit_code"], 1)
        self.assertEqual(receipt["classification"], "exited")

    def test_process_timeout_even_exit_zero_fails(self):
        receipt = self.run_fake_process([subprocess.TimeoutExpired("owned", 7), 0], 0, d.Refusal)
        self.assertEqual(receipt["classification"], "timeout")
        self.assertEqual(receipt["timeout_seconds"], 7)

    def test_cancellation_keeps_receipt_and_cleans_owned_group(self):
        receipt = self.run_fake_process([KeyboardInterrupt(), -9], -9, KeyboardInterrupt)
        self.assertEqual(receipt["classification"], "cancelled")

    def test_spawn_failure_does_not_kill_unowned_processes(self):
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

    def test_exact_base_ref_and_six_infrastructure_paths(self):
        self.assertEqual(d.BASE, "781dda4f92b0c15fa8d0e58998933d76c3d1994c")
        self.assertEqual(d.BASE_TREE, "34b18526d3eabb00c5617c92441077476856c105")
        self.assertEqual(d.REF, "refs/heads/cloga-auto-minimal-expected-113")
        self.assertEqual(d.INFRASTRUCTURE, {".github/workflows/auto-expected-prepare.yml", "scripts/ci-workflow.spec.ts",
            "scripts/prepare-auto-expected-goldens.py", "scripts/test_prepare_auto_expected_goldens.py",
            "scripts/prepare-auto-web-goldens.py", "scripts/test_prepare_auto_web_goldens.py"})

    def test_exact_source_commit_tree_binding(self):
        binding = d.source_guard(self.evidence(), environment())
        self.assertEqual(binding["source_sha"], "a" * 40)
        self.assertEqual(binding["source_tree"], "b" * 40)
        self.assertEqual(binding["base_sha"], d.BASE)

    def test_head_must_match_trigger(self):
        with self.assertRaisesRegex(d.Refusal, "head-trigger-mismatch"):
            d.source_guard(self.evidence({("rev-parse", "HEAD"): b"c" * 40}), environment())

    def test_dirty_tracked_or_untracked_source_rejected(self):
        for value in (b" M source.ts\n", b"?? rogue.txt\n"):
            with self.subTest(value=value), self.assertRaisesRegex(d.Refusal, "dirty-checkout"):
                d.source_guard(self.evidence({("status", "--porcelain=v1", "--untracked-files=all"): value}), environment())

    def test_exact_baseline_tree_required(self):
        with self.assertRaisesRegex(d.Refusal, "baseline-tree-mismatch"):
            d.source_guard(self.evidence({("rev-parse", d.BASE + "^{tree}"): b"c" * 40}), environment())

    def test_base_must_be_ancestor(self):
        with self.assertRaises(d.Refusal):
            d.source_guard(self.evidence(ancestor_error=True), environment())

    def test_runtime_candidate_and_unapproved_infrastructure_deltas_rejected(self):
        key = ("diff", "--no-renames", "--name-only", "-z", d.BASE, "HEAD")
        for name in (d.HMR_SOURCE, d.TARGET, next(iter(d.CANDIDATES)), ".github/workflows/auto-routing-prepare.yml"):
            with self.subTest(name=name), self.assertRaisesRegex(d.Refusal, "runtime-differs"):
                d.source_guard(self.evidence({key: name.encode() + b"\0"}), environment())
        d.source_guard(self.evidence({key: b"\0".join(name.encode() for name in d.INFRASTRUCTURE)}), environment())

    def test_checkout_root_required(self):
        with self.assertRaisesRegex(d.Refusal, "checkout-root-required"):
            d.source_guard(self.evidence({("rev-parse", "--show-toplevel"): b"/elsewhere"}), environment())


if __name__ == "__main__":
    unittest.main()
