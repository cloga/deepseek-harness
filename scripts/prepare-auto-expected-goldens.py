#!/usr/bin/env python3
"""Linux CI-only, keyless owner-local expected-output proposal; never adopts it.

Invoke from checkout root without arguments. GITHUB_OUTPUT receives evidence_path
before source checks. Evidence retains all source hashes, original/proposed bytes,
raw logs, receipts and binary diffs. Ignored dependency/build trees are not source;
all tracked/nonignored files and complete CLI-test/canonical snapshot trees are.
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

BASE = "781dda4f92b0c15fa8d0e58998933d76c3d1994c"
BASE_TREE = "34b18526d3eabb00c5617c92441077476856c105"
REF = "refs/heads/cloga-auto-minimal-expected-113"
WORKFLOW = ".github/workflows/auto-expected-prepare.yml"
DRIVER = "scripts/prepare-auto-expected-goldens.py"
TEST = "scripts/test_prepare_auto_expected_goldens.py"
INFRASTRUCTURE = {WORKFLOW, DRIVER, TEST, "scripts/ci-workflow.spec.ts",
                  "scripts/prepare-auto-web-goldens.py", "scripts/test_prepare_auto_web_goldens.py"}
OWNER = "apps/cli/tests/profiles/headless/tests/"
TARGET_FILES = [OWNER + "headless.expected.e2e.ts", OWNER + "subagent-inheritance.expected.e2e.ts"]
TARGET_PATTERN = ("(delivers a continuable child result without parent polling|"
                  "confines a delegated child through the assembled headless app)$")
CANDIDATES = frozenset(OWNER + "expected/" + name for name in (
    "subagent-settlement/child.expected.jsonl", "subagent-settlement/stream-json.expected.jsonl",
    "subagent-inheritance/parent.expected.jsonl", "subagent-inheritance/child.expected.jsonl"))
REFRESH_COMMAND = ["pnpm", "run", "test:expected:refresh", *TARGET_FILES, "-t", TARGET_PATTERN]
REPLAY_COMMAND = ["pnpm", "run", "test:expected"]
REFRESH_SECONDS = 600
REPLAY_SECONDS = 900
SCRIPT_VALUES = {"test:expected:refresh": "DSH_SNAPSHOT=refresh vitest run --config vitest.expected.config.ts",
                 "test:expected": "vitest run --config vitest.expected.config.ts"}
PROTECTED_TREES = ("apps/cli/tests", "snapshots", "scripts/snapshots")


class Refusal(Exception):
    """Only fixed credential-free codes may cross this boundary."""


def require(condition, code):
    if not condition:
        raise Refusal(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, data):
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, sort_keys=True, indent=2)
        stream.write("\n")


def guard_environment(env, system):
    require(system == "Linux", "linux-required")
    for key, value in {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "cloga/deepseek-harness",
                       "GITHUB_EVENT_NAME": "push", "GITHUB_REF": REF, "GITHUB_RUN_ATTEMPT": "1"}.items():
        require(env.get(key) == value, "ci-identity-ref-or-attempt")
    require(re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")), "invalid-source-sha")
    require(env.get("DSH_SNAPSHOT", "replay") == "replay", "inherited-snapshot-mode")
    require(not env.get("NODE_OPTIONS"), "inherited-node-options")


def child_environment(env, mode=None):
    keys = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ",
            "TMPDIR", "TMP", "TEMP", "RUNNER_TEMP", "CI", "TERM", "PNPM_HOME",
            "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR")
    result = {key: env[key] for key in keys if key in env}
    result.update({"CI": "true", "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_CONFIG_GLOBAL": os.devnull, "GIT_OPTIONAL_LOCKS": "0",
                   "DSH_TELEMETRY_DISABLED": "1", "DSH_EXAMPLE_MODE": "lib"})
    if mode is not None:
        require(mode in ("refresh", "replay"), "invalid-stage-mode")
        result["DSH_SNAPSHOT"] = mode
    return result


def safe_path(root, name):
    p = PurePosixPath(name)
    require(not p.is_absolute() and p.parts and all(x not in ("..", ".git") for x in p.parts), "unsafe-source-path")
    path = root.joinpath(*p.parts)
    require(path.resolve().is_relative_to(root.resolve()), "symlink-escape")
    for parent in path.parents:
        if parent == root:
            break
        require(not parent.is_symlink(), "symlink-parent")
    return path


def metadata_output(name):
    p = PurePosixPath(name)
    return (p.parts[:3] == ("apps", "cli", "tests") and ".." not in p.parts
            and not any(x.startswith("workspace.expected") for x in p.parts)
            and bool(re.fullmatch(r".+\.expected\.(?:jsonl|json|md|txt)", p.name)))


def check_changes(before, after, tracked, replay=False):
    changed = [name for name in sorted(before.keys() | after.keys()) if before.get(name) != after.get(name)]
    if replay:
        require(not changed, "replay-wrote-source-or-output")
    for name in changed:
        old, new = before.get(name), after.get(name)
        require(old is not None and name in tracked, "new-file-forbidden")
        require(new is not None, "deletion-forbidden")
        require(old["kind"] == new["kind"] == "file", "symlink-mutation")
        require(old["mode"] == new["mode"], "file-mode-mutation")
        if old["sha256"] != new["sha256"]:
            require(name in CANDIDATES, "non-candidate-content-mutation")
        else:
            require(metadata_output(name), "non-owner-metadata-mutation")
    return changed


def check_candidates(before, tracked):
    require(CANDIDATES <= tracked, "candidates-must-be-tracked")
    require(all(name in before and before[name]["kind"] == "file" for name in CANDIDATES),
            "candidates-must-be-regular-files")


def check_scripts(data):
    scripts = json.loads(data).get("scripts", {})
    require(all(scripts.get(name) == value for name, value in SCRIPT_VALUES.items()), "expected-script-contract")


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
        self.path = Path(tempfile.mkdtemp(prefix="auto-expected-proposal-", dir=temp))
        with output.open("a", encoding="utf-8") as stream:
            stream.write("evidence_path=" + str(self.path) + "\n")
        self.env = child_environment(env)
        self.counter = 0
        (self.path / "blobs").mkdir()

    def run(self, label, argv, timeout=60, env=None, accepted=(0,)):
        self.counter += 1
        prefix = "%03d-%s" % (self.counter, label)
        out, err = self.path / (prefix + ".stdout"), self.path / (prefix + ".stderr")
        receipt = {"argv": argv, "timeout_seconds": timeout, "classification": "spawn-failed",
                   "exit_code": None, "owned_process_group": None}
        start = time.monotonic()
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
                    # Only the session/group created by this invocation; also
                    # clean remaining group members after the leader exits.
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # This owned group already exited.
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

    def tracked(self):
        return set(os.fsdecode(x) for x in self.git("ls-files", "-z", "--cached").split(b"\0") if x)

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
        for tree in PROTECTED_TREES:
            try:
                start = safe_path(self.root, tree)
            except Refusal:
                require(not strict, "protected-root-symlink")
                names.add(tree)
                continue
            if start.is_symlink():
                require(not strict, "protected-root-symlink")
                names.add(tree)
                continue
            for directory, dirs, files in os.walk(start, followlinks=False):
                for name in dirs + files:
                    path = Path(directory) / name
                    if path.is_symlink() or path.is_file():
                        names.add(path.relative_to(self.root).as_posix())
        result = {}
        for name in sorted(names):
            try:
                path = safe_path(self.root, name)
            except Refusal:
                if strict:
                    raise
                path = self.root / name
                if not any(p.is_symlink() for p in path.parents if p != self.root) and path.is_symlink():
                    result[name] = {"sha256": self.blob(os.fsencode(os.readlink(path))), "kind": "unsafe-link",
                                    "mode": stat.S_IMODE(path.lstat().st_mode)}
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
            result[name] = {"sha256": self.blob(data), "kind": kind, "mode": stat.S_IMODE(info.st_mode),
                            "mtime_ns": info.st_mtime_ns, "ctime_ns": info.st_ctime_ns}
        return result

    def candidate_record(self, label, inventory):
        # Include all four, even an unchanged parent; missing proposals are null.
        write_json(self.path / (label + ".candidates.json"), {name: inventory.get(name) for name in sorted(CANDIDATES)})

    def capture(self, label, before):
        after = self.inventory(strict=False)
        write_json(self.path / (label + ".inventory.json"), after)
        self.candidate_record(label, after)
        write_json(self.path / (label + ".changes.json"), [
            {"path": name, "before": before.get(name), "after": after.get(name)}
            for name in sorted(before.keys() | after.keys()) if before.get(name) != after.get(name)])
        require(all(item["kind"] not in ("unsafe-path", "special") for item in after.values()), "unsafe-tree-diff-refused")
        patch = self.git("diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--")
        for name in sorted(after.keys() - self.tracked()):
            patch += self.git("diff", "--no-index", "--binary", "--full-index", "--no-ext-diff",
                              "--no-textconv", "--", os.devnull, name, accepted=(0, 1))
        with (self.path / (label + ".patch")).open("xb") as stream:
            stream.write(patch)
        return after

    def seal(self):
        write_json(self.path / "artifact-sha256.json", {
            p.relative_to(self.path).as_posix(): digest(p.read_bytes()) for p in self.path.rglob("*") if p.is_file()})
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
    head = evidence.git("rev-parse", "HEAD").decode().strip()
    index_delta = evidence.git("diff", "--cached", "--name-only")
    require(head == source_binding["source_sha"], "head-mutated")
    require(not index_delta, "index-mutated")


def execute(root, env):
    evidence = None
    result = {"successful": False, "proposal_only": True, "independently_qualified": False,
              "error_code": "initialization-failed"}
    try:
        evidence = Evidence(root, env)
        guard_environment(env, platform.system())
        source_binding = source_guard(evidence, env)
        write_json(evidence.path / "source.json", source_binding)
        tracked = evidence.tracked()
        before = evidence.inventory()
        write_json(evidence.path / "original.inventory.json", before)
        evidence.candidate_record("original", before)
        check_candidates(before, tracked)
        check_scripts(safe_path(root, "package.json").read_text(encoding="utf-8"))
        require(before["pnpm-lock.yaml"]["sha256"] == digest(evidence.git("show", BASE + ":pnpm-lock.yaml")), "baseline-lock-mismatch")
        inputs = [WORKFLOW, DRIVER, TEST, "package.json", "pnpm-lock.yaml", "vitest.expected.config.ts", *TARGET_FILES]
        require(all(name in before and before[name]["kind"] == "file" for name in inputs), "missing-input")
        source_binding.update(input_sha256={name: before[name]["sha256"] for name in inputs},
                              all_generator_inputs="original.inventory.json", lock_sha256=before["pnpm-lock.yaml"]["sha256"],
                              python_version=platform.python_version())
        write_json(evidence.path / "source-binding.json", source_binding)
        versions = {}
        for name, command in (("node", ["node", "--version"]), ("pnpm", ["pnpm", "--version"]), ("git", ["git", "--version"])):
            value = evidence.run("version-" + name, command).decode().strip()
            require(bool(re.fullmatch(r"(?:v|git version )?[0-9]+\.[0-9]+\.[0-9]+", value)), "invalid-tool-version")
            versions[name] = value
        write_json(evidence.path / "tool-versions.json", versions)
        require(versions["node"].startswith("v24.") and versions["pnpm"] == "11.7.0", "toolchain-mismatch")
        refreshed = None
        try:
            evidence.run("refresh", REFRESH_COMMAND, REFRESH_SECONDS, child_environment(env, "refresh"))
        finally:
            try:
                refreshed = evidence.capture("refresh", before)
            finally:
                check_git_identity(evidence, source_binding)
            check_changes(before, refreshed, tracked)
        try:
            evidence.run("replay", REPLAY_COMMAND, REPLAY_SECONDS, child_environment(env, "replay"))
        finally:
            try:
                replayed = evidence.capture("replay", refreshed)
            finally:
                check_git_identity(evidence, source_binding)
            check_changes(refreshed, replayed, tracked, replay=True)
            check_changes(before, replayed, tracked)
        result.update(successful=True, error_code=None)
    except Refusal as error:
        result["error_code"] = str(error)
    except BaseException:
        result["error_code"] = "cancelled" if sys.exc_info()[0] in (KeyboardInterrupt, SystemExit) else "internal-failure"
    finally:
        if evidence is not None:
            write_json(evidence.path / "result.json", result)
            evidence.seal()
    return 0 if result["successful"] else 1


def main():
    def cancelled(signum, frame):
        raise KeyboardInterrupt
    previous = signal.signal(signal.SIGTERM, cancelled)
    try:
        require(len(sys.argv) == 1, "no-arguments-accepted")
        return execute(Path.cwd(), dict(os.environ))
    except BaseException:
        return 1  # Finalization errors must not print arbitrary OS diagnostics.
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    sys.exit(main())
