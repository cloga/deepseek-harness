#!/usr/bin/env python3
"""Linux CI-only, keyless snapshot proposal; never adopts or publishes output.

Invoke from checkout root, without arguments. GITHUB_OUTPUT receives evidence_path
before source checks. The artifact contains originals/content-addressed bytes,
per-stage inventories/diffs/exit receipts, source binding and result.json. Success is
NOT independent qualification. Ignored dependency/build trees are not source;
all tracked files, nonignored untracked files and the entire snapshots tree are.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time

BASE = "1b9a3a706344baed4fefbd8aff47f2bb94d07c9a"
BASE_TREE = "e08bc0e728b958316356af8aa2cc5c87c8922724"
REF = "refs/heads/cloga-auto-minimal-golden-113"
WORKFLOW = ".github/workflows/auto-routing-prepare.yml"
DRIVER = "scripts/prepare-auto-snapshot-goldens.py"
TEST = "scripts/test_prepare_auto_snapshot_goldens.py"
INFRASTRUCTURE = {WORKFLOW, DRIVER, TEST, ".github/workflows/build-exe-for-python-sdk.yml",
                  "scripts/prepare-auto-sdk-goldens.py", "scripts/test_prepare_auto_sdk_goldens.py",
                  "scripts/test_prepare_auto_sdk_golden_commands.py", "scripts/ci-workflow.spec.ts"}
VERSION_SOURCE = "packages/core/session/src/types.ts"
SUITE = ["node", "node_modules/vitest/vitest.mjs", "run", "--config", "vitest.snapshot.config.ts"]
STAGE_SECONDS = 1200
REPLAY_SECONDS = 600


class Refusal(Exception):
    """Only fixed, credential-free diagnostic codes may cross this boundary."""


def require(condition, code):
    if not condition:
        raise Refusal(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, data):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(data, stream, sort_keys=True, indent=2)
        stream.write("\n")


def guard_environment(env, system):
    require(system == "Linux", "linux-required")
    for key, value in {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "cloga/deepseek-harness",
                       "GITHUB_EVENT_NAME": "push", "GITHUB_REF": REF,
                       "GITHUB_RUN_ATTEMPT": "1"}.items():
        require(env.get(key) == value, "ci-identity-ref-or-attempt")
    require(re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")), "invalid-source-sha")
    require(env.get("DSH_SNAPSHOT", "replay") == "replay", "inherited-snapshot-mode")
    require(not env.get("NODE_OPTIONS"), "inherited-node-options")


def child_environment(env, mode=None):
    # No API keys, GitHub tokens, arbitrary DSH knobs or loader options are passed.
    keys = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ",
            "TMPDIR", "TMP", "TEMP", "RUNNER_TEMP", "CI", "TERM", "PNPM_HOME",
            "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR")
    result = {key: env[key] for key in keys if key in env}
    result.update({"CI": "true", "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_CONFIG_GLOBAL": os.devnull, "GIT_OPTIONAL_LOCKS": "0", "DSH_TELEMETRY_DISABLED": "1"})
    if mode is not None:
        require(mode in ("refresh", "replay"), "invalid-stage-mode")
        result["DSH_SNAPSHOT"] = mode
    # Match the established CI snapshot gate; never inherit a different mode.
    result["DSH_EXAMPLE_MODE"] = "lib"
    return result


def safe_path(root, name):
    p = PurePosixPath(name)
    require(not p.is_absolute() and p.parts and all(x not in ("..", ".git") for x in p.parts),
            "unsafe-source-path")
    path = root.joinpath(*p.parts)
    require(path.resolve().is_relative_to(root.resolve()), "symlink-escape")
    for parent in path.parents:
        if parent == root:
            break
        require(not parent.is_symlink(), "symlink-parent")
    return path


def allowed_output(name, version=3):
    p = PurePosixPath(name)
    if not p.parts or p.parts[0] != "snapshots" or ".." in p.parts:
        return False
    if any(x == "workspace.expected" or x.startswith("workspace.expected.") for x in p.parts):
        return False
    if re.fullmatch(r"session(?:\.[1-9][0-9]*)?\.v" + str(version) + r"\.jsonl", p.name):
        return True
    # Expectations are data, never source/configuration disguised by a marker.
    return bool(re.fullmatch(r".+\.expected\.(?:jsonl|json|md|txt)", p.name))


def current_version(data):
    matches = re.findall(r"^export const SESSION_FORMAT_VERSION = ([0-9]+)\s*$", data, re.M)
    require(matches == ["3"], "session-format-must-be-literal-three")
    return int(matches[0])


def check_changes(before, after, replay=False):
    changed = [name for name in sorted(before.keys() | after.keys()) if before.get(name) != after.get(name)]
    if replay:
        require(not changed, "replay-wrote-source-or-output")
    for name in changed:
        old, new = before.get(name), after.get(name)
        require(new is not None, "deletion-forbidden")
        require(allowed_output(name), "non-output-mutation")
        require(new["kind"] == "file" and (old is None or old["kind"] == "file"), "symlink-mutation")
        require(old is None or old["mode"] == new["mode"], "file-mode-mutation")
    return changed


class Evidence:
    def __init__(self, root, env):
        self.root = root.resolve()
        temp = Path(env.get("RUNNER_TEMP", ""))
        require(temp.is_absolute() and temp.is_dir() and not temp.is_symlink()
                and "\n" not in str(temp) and "\r" not in str(temp), "runner-temp-required")
        require(not temp.resolve().is_relative_to(self.root), "evidence-must-be-outside-checkout")
        output = Path(env.get("GITHUB_OUTPUT", ""))
        require(output.is_absolute() and output.is_file() and not output.is_symlink(), "github-output-required")
        require(not output.resolve().is_relative_to(self.root), "github-output-inside-checkout")
        self.path = Path(tempfile.mkdtemp(prefix="auto-snapshot-proposal-", dir=temp))
        with output.open("a", encoding="utf-8") as stream:
            stream.write("evidence_path=" + str(self.path) + "\n")
        self.env = child_environment(env)
        self.counter = 0
        (self.path / "blobs").mkdir()

    def run(self, label, argv, timeout=60, env=None, accepted=(0,)):
        self.counter += 1
        prefix = "%03d-%s" % (self.counter, label)
        out = self.path / (prefix + ".stdout")
        err = self.path / (prefix + ".stderr")
        receipt = {"argv": argv, "timeout_seconds": timeout, "classification": "spawn-failed",
                   "exit_code": None, "owned_process_group": None}
        start = time.monotonic()
        proc = None
        try:
            with out.open("xb") as stdout, err.open("xb") as stderr:
                proc = subprocess.Popen(argv, cwd=self.root, env=self.env if env is None else env,
                                        stdout=stdout, stderr=stderr, stdin=subprocess.DEVNULL,
                                        start_new_session=True)
                receipt["owned_process_group"] = proc.pid
                try:
                    proc.wait(timeout=timeout)
                    receipt["classification"] = "exited"
                except subprocess.TimeoutExpired:
                    receipt["classification"] = "timeout"
                except BaseException:
                    receipt["classification"] = "cancelled"
                    raise
                finally:
                    # The group ID is exactly the child session we created, never a
                    # discovered process name, parent group or unrelated PID. Kill
                    # remaining descendants even after the leader exits normally.
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(timeout=10)
                    receipt["exit_code"] = proc.returncode
        finally:
            receipt["elapsed_seconds"] = round(time.monotonic() - start, 3)
            write_json(self.path / (prefix + ".receipt.json"), receipt)
        require(receipt["classification"] == "exited" and receipt["exit_code"] in accepted,
                "stage-timeout" if receipt["classification"] == "timeout" else "stage-failed")
        return out.read_bytes()

    def git(self, *args, accepted=(0,)):
        return self.run("git", ["git", "--no-pager", "-c", "core.fsmonitor=false", *args], accepted=accepted)

    def blob(self, data):
        sha = digest(data)
        path = self.path / "blobs" / sha
        if not path.exists():
            with path.open("xb") as stream:
                stream.write(data)
            path.chmod(0o444)
        return sha

    def inventory(self, strict=True):
        raw = self.git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
        names = set(os.fsdecode(x) for x in raw.split(b"\0") if x)
        # Include ignored snapshot outputs too, but never follow symlink directories.
        snap = self.root / "snapshots"
        if snap.is_symlink():
            require(not strict, "snapshot-root-symlink")
            names.add("snapshots")
        for directory, dirs, files in os.walk(snap if not snap.is_symlink() else self.path / "absent", followlinks=False):
            for name in dirs + files:
                p = Path(directory) / name
                if p.is_symlink() or p.is_file():
                    names.add(p.relative_to(self.root).as_posix())
        result = {}
        for name in sorted(names):
            try:
                path = safe_path(self.root, name)
            except Refusal:
                if strict:
                    raise
                # Preserve the link itself, never dereference an escaping target.
                path = self.root / name
                if path.is_symlink() and not any(p.is_symlink() for p in path.parents if p != self.root):
                    result[name] = {"sha256": self.blob(os.fsencode(os.readlink(path))),
                                    "kind": "unsafe-link", "mode": stat.S_IMODE(path.lstat().st_mode)}
                else:
                    result[name] = {"sha256": None, "kind": "unsafe-path", "mode": None}
                continue
            if not path.exists() and not path.is_symlink():
                continue
            info = path.lstat()
            kind = "link" if stat.S_ISLNK(info.st_mode) else "file"
            if kind != "link" and not stat.S_ISREG(info.st_mode):
                require(not strict, "special-source-file")
                result[name] = {"sha256": None, "kind": "special", "mode": stat.S_IMODE(info.st_mode)}
                continue
            data = os.fsencode(os.readlink(path)) if kind == "link" else path.read_bytes()
            result[name] = {"sha256": self.blob(data), "kind": kind,
                            "mode": stat.S_IMODE(info.st_mode), "mtime_ns": info.st_mtime_ns,
                            "ctime_ns": info.st_ctime_ns}
        return result

    def capture(self, label, before):
        after = self.inventory(strict=False)
        write_json(self.path / (label + ".inventory.json"), after)
        changes = [{"path": name, "before": before.get(name), "after": after.get(name)}
                   for name in sorted(before.keys() | after.keys()) if before.get(name) != after.get(name)]
        write_json(self.path / (label + ".changes.json"), changes)
        # A mutated symlink parent must not make Git read files outside checkout.
        require(all(item["kind"] not in ("unsafe-path", "special") for item in after.values()),
                "unsafe-tree-diff-refused")
        patch = self.git("diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--")
        tracked = set(os.fsdecode(x) for x in self.git("ls-files", "-z", "--cached").split(b"\0") if x)
        # Include every untracked proposal file in both stages, not merely files
        # newly created by that stage (replay must retain refresh's additions).
        for name in sorted(after.keys() - tracked):
            patch += self.git("diff", "--no-index", "--binary", "--full-index", "--no-ext-diff",
                              "--no-textconv", "--", os.devnull, name, accepted=(0, 1))
        with (self.path / (label + ".patch")).open("xb") as stream:
            stream.write(patch)
        return after

    def seal(self):
        hashes = {p.relative_to(self.path).as_posix(): digest(p.read_bytes())
                  for p in self.path.rglob("*") if p.is_file()}
        write_json(self.path / "artifact-sha256.json", hashes)
        for directory, dirs, files in os.walk(self.path, topdown=False):
            for name in files:
                (Path(directory) / name).chmod(0o444)
            Path(directory).chmod(0o555)


def source_guard(evidence, env):
    git = evidence.git
    require(git("rev-parse", "--show-toplevel").decode().strip() == str(evidence.root), "checkout-root-required")
    sha = git("rev-parse", "HEAD").decode().strip()
    require(sha == env["GITHUB_SHA"], "head-trigger-mismatch")
    require(not git("status", "--porcelain=v1", "--untracked-files=all"), "dirty-checkout")
    require(git("rev-parse", BASE + "^{tree}").decode().strip() == BASE_TREE, "baseline-tree-mismatch")
    git("merge-base", "--is-ancestor", BASE, "HEAD")
    delta = set(os.fsdecode(x) for x in git("diff", "--no-renames", "--name-only", "-z", BASE, "HEAD").split(b"\0") if x)
    require(delta <= INFRASTRUCTURE, "runtime-differs-from-fixed-source")
    return {"source_sha": sha, "source_tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
            "base_sha": BASE, "base_tree": BASE_TREE, "ref": REF, "run_attempt": 1}


def check_git_identity(evidence, source_binding):
    require(evidence.git("rev-parse", "HEAD").decode().strip() == source_binding["source_sha"], "head-mutated")
    require(not evidence.git("diff", "--cached", "--name-only"), "index-mutated")


def execute(root, env):
    evidence = None
    result = {"successful": False, "proposal_only": True, "independently_qualified": False,
              "error_code": "initialization-failed"}
    try:
        evidence = Evidence(root, env)  # Publish path even when later CI/source guards reject.
        guard_environment(env, platform.system())
        source_binding = source_guard(evidence, env)
        write_json(evidence.path / "source.json", source_binding)
        before = evidence.inventory()
        write_json(evidence.path / "original.inventory.json", before)
        current_version(safe_path(root, VERSION_SOURCE).read_text(encoding="utf-8"))
        require(before["pnpm-lock.yaml"]["sha256"] == digest(evidence.git("show", BASE + ":pnpm-lock.yaml")),
                "baseline-lock-mismatch")
        inputs = [WORKFLOW, DRIVER, TEST, "pnpm-lock.yaml", "vitest.snapshot.config.ts", VERSION_SOURCE]
        require(all(name in before and before[name]["kind"] == "file" for name in inputs), "missing-input")
        source_binding["input_sha256"] = {name: before[name]["sha256"] for name in inputs}
        source_binding["all_generator_inputs"] = "original.inventory.json"
        source_binding["lock_sha256"] = before["pnpm-lock.yaml"]["sha256"]
        source_binding["python_version"] = platform.python_version()
        versions = {}
        for name, command in (("node", ["node", "--version"]), ("pnpm", ["pnpm", "--version"]),
                              ("git", ["git", "--version"])):
            value = evidence.run("version-" + name, command).decode().strip()
            require(bool(re.fullmatch(r"(?:v|git version )?[0-9]+\.[0-9]+\.[0-9]+", value)), "invalid-tool-version")
            versions[name] = value
        source_binding["tool_versions"] = versions
        write_json(evidence.path / "source-binding.json", source_binding)
        require(versions["node"].startswith("v24.") and versions["pnpm"] == "11.7.0", "toolchain-mismatch")
        # Fixed two-pass preparation: shared pins can be checked before their
        # owners refresh them. Pass 1 is never qualification; retain its raw
        # failure. Pass 2 is mandatory even if pass 1 exits zero, not a retry loop.
        result["first_refresh_is_qualification"] = False
        refreshed = before
        for label, accepted in (("refresh-pass1", (0, 1)), ("refresh-pass2", (0,))):
            previous = refreshed
            try:
                evidence.run(label, SUITE, STAGE_SECONDS, child_environment(env, "refresh"), accepted=accepted)
            finally:
                refreshed = evidence.capture(label, previous)
                check_changes(previous, refreshed)
                check_changes(before, refreshed)
                check_git_identity(evidence, source_binding)
        try:
            evidence.run("replay", SUITE, REPLAY_SECONDS, child_environment(env, "replay"))
        finally:
            replayed = evidence.capture("replay", refreshed)
        check_changes(refreshed, replayed, replay=True)
        check_changes(before, replayed)
        check_git_identity(evidence, source_binding)
        result.update(successful=True, error_code=None)
    except Refusal as error:
        result["error_code"] = str(error)
    except BaseException:
        # Do not serialize arbitrary exception strings, environment or credentials.
        result["error_code"] = "cancelled" if sys.exc_info()[0] in (KeyboardInterrupt, SystemExit) else "internal-failure"
    finally:
        if evidence is not None:
            write_json(evidence.path / "result.json", result)
            evidence.seal()
    return 0 if result["successful"] else 1


def main():
    # A SIGTERM from Actions gets the same owned-child cleanup/evidence as Ctrl-C.
    def cancelled(signum, frame):
        raise KeyboardInterrupt
    previous = signal.signal(signal.SIGTERM, cancelled)
    try:
        require(len(sys.argv) == 1, "no-arguments-accepted")
        return execute(Path.cwd(), dict(os.environ))
    except BaseException:
        # Includes failure to finalize evidence; never print arbitrary OS errors.
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    sys.exit(main())
