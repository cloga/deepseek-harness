#!/usr/bin/env python3
"""CI-only candidate EXE -> four proposed advanced SDK goldens; never commits/adopts/publishes.
No work executes on import. Only the explicit source-bound manual workflow may call main().
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

REPOSITORY = "cloga/deepseek-harness"
BRANCH = "refs/heads/cloga-auto-minimal-golden-113"
WORKFLOW = ".github/workflows/build-exe-for-python-sdk.yml"
GOLDEN_DIRECTORY = "scripts/snapshots/python-sdk-single-exe/advanced"
GOLDENS = ("result.json", "session.v3.jsonl", "session.1.v3.jsonl", "session.2.v3.jsonl")
OUTCOMES = {key: "success" for key in ("generation", "frozenInstall", "notices", "focusedTests", "hostAndClientContracts")}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save(path: Path, value) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def safe_relative(root: Path, raw: str) -> Path:
    require(isinstance(raw, str) and raw != "", "Empty evidence path")
    require("\\" not in raw and not raw.startswith("/") and ":" not in raw, "Non-repository evidence path")
    require(all(part not in ("", ".", "..") for part in raw.split("/")), "Unsafe evidence path")
    target = root.joinpath(*raw.split("/"))
    require(target.resolve().is_relative_to(root.resolve()), "Evidence path escapes its root")
    return target


def git(root: Path, *arguments: str) -> str:
    result = subprocess.run(["git", *arguments], cwd=root, check=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, encoding="utf-8", env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    return result.stdout.strip()


def tracked_changes(root: Path) -> set[str]:
    return set(filter(None, git(root, "diff", "--name-only", "HEAD", "--").splitlines()))


def validate_preparation(root: Path, directory: Path, metadata_path: Path, sha: str, lock_hash: str, run_id: str) -> dict:
    metadata = load(metadata_path)
    run, artifact = metadata["run"], metadata["artifact"]
    require(str(run["id"]) == run_id and run["head_sha"] == sha, "Wrong preparation run/source")
    require(run["head_branch"] == BRANCH.removeprefix("refs/heads/"), "Wrong preparation branch")
    require(run["repository"]["full_name"] == REPOSITORY and run["head_repository"]["full_name"] == REPOSITORY, "Wrong preparation repository")
    require(run["status"] == "completed" and run["conclusion"] == "success" and run["event"] == "push", "Preparation did not succeed")
    require(run["path"] == ".github/workflows/auto-routing-prepare.yml", "Unexpected preparation workflow")
    require(artifact["name"] == f"auto-routing-prepare-{sha}-{run_id}-{run['run_attempt']}" and not artifact["expired"], "Wrong preparation artifact")
    inputs, receipt = load(directory / "inputs.json"), load(directory / "receipt.json")
    for record in (inputs, receipt):
        require(record["schemaVersion"] == 1 and record["repository"] == REPOSITORY, "Wrong preparation receipt schema/repository")
        require(record["sourceSha"] == sha and record["workflowSha"] == sha and record["runId"] == run_id and record["runAttempt"] == str(run["run_attempt"]), "Wrong preparation receipt binding")
        require(record["workflowRef"] == f"{REPOSITORY}/.github/workflows/auto-routing-prepare.yml@{BRANCH}", "Wrong preparation workflow ref")
        require(record["originalLockSha256"] == lock_hash, "Preparation was before lock adoption; use an idempotent exact-candidate run")
    require(receipt["outcomes"] == OUTCOMES and receipt["finalQualification"] is False, "All five preparation outcomes are required")
    require(receipt["inputIntegrityPassed"] is True and receipt["integrityErrors"] == [], "Preparation integrity failed")
    require(receipt["focusedTestsPassed"] is True, "Preparation tests did not pass")
    require(receipt["resultingLockSha256"] == lock_hash and digest(directory / "pnpm-lock.yaml") == lock_hash, "Preparation regenerated a different lock")
    require((directory / "pnpm-lock.yaml").read_bytes() == (root / "pnpm-lock.yaml").read_bytes(), "Preparation lock not byte-identical")
    tracked = git(root, "ls-files", "-z").split("\0")
    expected = {p for p in tracked if p == "package.json" or p.endswith("/package.json")}
    expected.update(("pnpm-workspace.yaml", ".github/workflows/auto-routing-prepare.yml"))
    require(set(inputs["inputHashes"]) == expected and receipt["inputHashes"] == inputs["inputHashes"], "Preparation manifest inventory differs from source")
    for name, value in inputs["inputHashes"].items():
        require(digest(safe_relative(root, name)) == value, f"Preparation source input changed: {name}")
    expected_evidence = {"inputs.json", "generated-lock.json", "generate.log", "frozen-install.json", "frozen-install.log", "focused-tests.json", "focused-tests.log", "contracts.log", "third-party-notices.log", "THIRD_PARTY_NOTICES.md"}
    require(set(receipt["evidenceHashes"]) == expected_evidence, "Preparation evidence inventory incomplete")
    for name, value in receipt["evidenceHashes"].items():
        require(digest(safe_relative(directory, name)) == value, f"Preparation evidence changed: {name}")
    require((directory / "contracts.log").stat().st_size > 0, "Preparation contracts log empty")
    for name in ("generated-lock.json", "frozen-install.json", "focused-tests.json"):
        require(load(directory / name)["exitCode"] == 0, f"Preparation command failed: {name}")
    return {"runId": run_id, "runAttempt": run["run_attempt"], "artifactId": artifact["id"],
            "receiptSha256": digest(directory / "receipt.json"), "metadataSha256": digest(metadata_path),
            "inputCount": len(expected), "allFiveOutcomesPassed": True}


def assert_expected_mismatch(exit_code: int, timed_out: bool, log: str) -> None:
    """Admit only one unchained top-level mismatch traceback ending in a complete unified diff."""
    require(not timed_out, "Original comparison timed out; not snapshot drift")
    require(exit_code == 1, "Original comparison must reproduce a concrete mismatch, not succeed/crash by another exit")
    lines = log.replace("\r\n", "\n").splitlines()
    traceback_header = "Traceback (most recent call last):"
    tracebacks = [index for index, line in enumerate(lines) if line.strip() == traceback_header]
    require(len(tracebacks) == 1 and lines[tracebacks[0]] == traceback_header,
            "Original comparison must have exactly one top-level traceback; chained/secondary failures are refused")
    chain_markers = {
        "During handling of the above exception, another exception occurred:",
        "The above exception was the direct cause of the following exception:",
    }
    require(not any(line.strip() in chain_markers for line in lines), "Chained exception is not standalone snapshot drift")
    exception_pattern = re.compile(
        r"AssertionError: advanced executable snapshot mismatch in ([^;]+); "
        r"rerun with --update-snapshots after reviewing the behavior"
    )
    matches = [(index, exception_pattern.fullmatch(line)) for index, line in enumerate(lines)]
    matches = [(index, match) for index, match in matches if match is not None]
    require(len(matches) == 1, "Original failure is not the single expected top-level snapshot assertion")
    assertion_index, match = matches[0]
    filename = match.group(1)
    require(filename in GOLDENS and tracebacks[0] < assertion_index, "Wrong snapshot or traceback order")
    prefix = lines[:tracebacks[0]]
    require(not any(re.match(r"^(?:[\w.]+(?:Error|Exception|Interrupt|Exit):|Exception ignored in:|Exception in thread)", line)
                    for line in prefix), "An earlier independent exception was printed before the mismatch")
    frames = lines[tracebacks[0] + 1:assertion_index]
    require(any(re.fullmatch(r'  File ".+", line [0-9]+(?:, in .+)?', line) for line in frames),
            "Expected assertion has no Python traceback frame")
    require(all(not line or line.startswith((" ", "\t")) for line in frames),
            "Unexpected top-level exception before the mismatch assertion")
    tail = lines[assertion_index + 1:]
    while tail and tail[-1] == "":
        tail.pop()
    require(len(tail) >= 3 and tail[0] == f"--- expected/{filename}" and tail[1] == f"+++ actual/{filename}",
            "Terminal mismatch lacks its exact unified diff headers")
    # Consume the whole exception payload as valid difflib hunks. Merely finding
    # an earlier diff would admit a later cleanup PermissionError or traceback.
    cursor = 2
    hunks = 0
    changed = False
    while cursor < len(tail):
        hunk = re.fullmatch(r"@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@", tail[cursor])
        require(hunk is not None, "Secondary error or unexpected text after the snapshot diff")
        old_remaining = int(hunk.group(2)) if hunk.group(2) is not None else 1
        new_remaining = int(hunk.group(4)) if hunk.group(4) is not None else 1
        require(old_remaining + new_remaining > 0, "Empty diff hunk cannot justify regeneration")
        cursor += 1
        hunks += 1
        while old_remaining or new_remaining:
            require(cursor < len(tail), "Truncated snapshot diff")
            line = tail[cursor]
            require(bool(line) and line[0] in " +-", "Non-diff exception/cleanup output in snapshot payload")
            if line[0] in " -":
                old_remaining -= 1
            if line[0] in " +":
                new_remaining -= 1
            require(old_remaining >= 0 and new_remaining >= 0, "Diff hunk lengths do not match its body")
            changed = changed or line[0] in "+-"
            cursor += 1
    require(hunks > 0 and changed, "No complete changed hunk in terminal snapshot mismatch")


def inspect_current_goldens(directory: Path) -> dict:
    result = load(directory / "result.json")
    require(result["final_response"] == "ADVANCED_EXECUTABLE_OK", "Advanced result sentinel missing")
    proof = {}
    for ordinal, name in enumerate(GOLDENS[1:]):
        records = [json.loads(line) for line in (directory / name).read_text(encoding="utf-8").splitlines()]
        require(records[0]["type"] == "session" and records[0]["version"] == 3, "Refuse unreviewed Session generation change")
        if ordinal:
            decisions = [r for r in records if r.get("type") == "subagent/model-selection"]
            require(len(decisions) == 1, f"Expected one actual durable child selection in {name}")
            decision = decisions[0]["data"]
            require(decision.get("source") in {"request", "parent-rule", "auto", "inheritance"}, "Unexpected child selection source")
            headers = [r for r in records if r.get("type") == "request/header"]
            require(bool(headers), "Child request header missing")
            config = headers[0]["data"]["header"]["config"]
            for field in ("provider", "model", "reasoningEffort"):
                if field in decision:
                    require(decision[field] == config.get(field), f"Child decision/header {field} differs")
            proof[name] = {"selectionEventCount": 1, "decision": decision,
                           "requestRoute": {key: config[key] for key in ("provider", "model", "reasoningEffort") if key in config}}
    return proof


def execute_owned_command(root: Path, evidence: Path, command_env: dict, commands: list,
                          label: str, argv: list[str], timeout: int, allow_failure: bool = False,
                          *, popen=subprocess.Popen, run_cleanup=subprocess.run,
                          clock=time.monotonic) -> tuple[int, bool, Path]:
    """Record every attempt; bounded cleanup failure leaves its output explicitly unsealed."""
    log_path = evidence / f"{label}.log"
    start = clock()
    record = {
        "label": label, "argv": list(argv), "startedAtUnixSeconds": time.time(),
        "timeoutSeconds": timeout, "exitCode": None, "timedOut": False,
        "spawned": False, "pid": None, "failureType": None, "log": log_path.name,
        "cleanupComplete": False, "evidenceComplete": False,
        "termination": {
            "attempted": False, "method": "owned taskkill /PID /T /F",
            "killTimeoutSeconds": 10, "killExitCode": None, "killTimedOut": False,
            "killErrorType": None, "waitTimeoutSeconds": 30, "waitTimedOut": False,
            "waitErrorType": None, "rootReaped": False,
        },
    }
    child = None
    try:
        with log_path.open("xb") as handle:
            try:
                child = popen(argv, cwd=root, env=command_env, stdout=handle, stderr=subprocess.STDOUT)
                record["spawned"] = True
                record["pid"] = child.pid
                try:
                    record["exitCode"] = child.wait(timeout=timeout)
                    record["termination"]["rootReaped"] = True
                    record["cleanupComplete"] = True
                except subprocess.TimeoutExpired:
                    record["timedOut"] = True
                except Exception as error:
                    record["failureType"] = type(error).__name__
                    record["termination"]["waitErrorType"] = type(error).__name__
                if not record["termination"]["rootReaped"]:
                    termination = record["termination"]
                    # Never enumerate or target another process: only this Popen's owned PID.
                    require(isinstance(child.pid, int) and child.pid > 0 and child.pid != os.getpid(),
                            "Refuse cleanup without a distinct owned child PID")
                    termination["attempted"] = True
                    try:
                        killed = run_cleanup(
                            ["taskkill", "/PID", str(child.pid), "/T", "/F"],
                            stdout=handle, stderr=subprocess.STDOUT, check=False,
                            timeout=termination["killTimeoutSeconds"],
                        )
                        termination["killExitCode"] = killed.returncode
                    except subprocess.TimeoutExpired:
                        termination["killTimedOut"] = True
                    except Exception as error:
                        termination["killErrorType"] = type(error).__name__
                    try:
                        record["exitCode"] = child.wait(timeout=termination["waitTimeoutSeconds"])
                        termination["rootReaped"] = True
                    except subprocess.TimeoutExpired:
                        termination["waitTimedOut"] = True
                    except Exception as error:
                        termination["waitErrorType"] = type(error).__name__
                    # Reaping the root alone does not prove descendants stopped after a failed kill.
                    record["cleanupComplete"] = (
                        termination["killExitCode"] == 0
                        and not termination["killTimedOut"]
                        and termination["killErrorType"] is None
                        and termination["rootReaped"]
                    )
            except Exception as error:
                record["failureType"] = type(error).__name__
                if child is None:
                    record["cleanupComplete"] = True  # Spawn failed: no owned process can write this log.
    except Exception as error:
        record["failureType"] = type(error).__name__
        if child is None:
            record["cleanupComplete"] = True
    finally:
        record["durationSeconds"] = round(clock() - start, 3)
        record["evidenceComplete"] = record["cleanupComplete"] and log_path.is_file()
        # Append before hashing so a filesystem/hash failure cannot erase command attribution.
        commands.append(record)
        if record["evidenceComplete"]:
            try:
                record["logSha256"] = digest(log_path)
            except Exception as error:
                record["evidenceComplete"] = False
                record["hashErrorType"] = type(error).__name__
    require(record["cleanupComplete"], f"Owned command termination unconfirmed: {label}; failure logs remain UNSEALED")
    require(record["failureType"] is None, f"Command setup/wait failed: {label}; inspect recorded outcomes")
    require(not record["timedOut"], f"Command timed out: {label}")
    require(record["evidenceComplete"], f"Command evidence incomplete: {label}")
    if not allow_failure:
        require(record["exitCode"] == 0, f"Command failed: {label}; inspect retained original log")
    return record["exitCode"], record["timedOut"], log_path


def seal_review_evidence(evidence: Path, receipt: dict) -> None:
    """Do not hash possibly live writer output or create a normal receipt after incomplete cleanup."""
    complete = all(command.get("evidenceComplete") is True and command.get("cleanupComplete") is True
                   for command in receipt["commands"])
    if not complete:
        receipt["outcome"] = "failed-unsealed"
        receipt["evidenceSealed"] = False
        receipt["unsealedReason"] = "At least one owned command has incomplete termination or evidence; output may still change."
        receipt.pop("evidenceHashes", None)
        save(evidence / "unsealed-failure.json", receipt)
        return
    hashes = {path.relative_to(evidence).as_posix(): digest(path)
              for path in sorted(evidence.rglob("*")) if path.is_file()}
    receipt["evidenceHashes"] = hashes
    receipt["evidenceSealed"] = True
    save(evidence / "receipt.json", receipt)


def pnpm_invocation(arguments: list[str], environment: dict[str, str], node_executable: str | None) -> list[str]:
    """Use the native builder's npm_execpath/PNPM_HOME JS entry layout, without a shell or guessed binaries."""
    require(node_executable is not None and Path(node_executable).is_file(), "Pinned Node executable is unavailable")
    entry = environment.get("npm_execpath", "").strip()
    if entry:
        extension = Path(entry).suffix.lower()
        if extension in (".js", ".cjs", ".mjs"):
            require(Path(entry).is_file(), "Explicit pnpm JavaScript entrypoint does not exist")
            return [node_executable, str(Path(entry).resolve()), *arguments]
        require(extension == ".cmd", "pnpm npm_execpath must expose a JavaScript entrypoint on Windows")
    home = environment.get("PNPM_HOME", "").strip()
    if home:
        package_bin = Path(home).resolve().parent / "pnpm" / "bin"
        for name in ("pnpm.mjs", "pnpm.cjs"):
            candidate = package_bin / name
            if candidate.is_file():
                return [node_executable, str(candidate), *arguments]
    raise RuntimeError("pnpm must expose a JavaScript entrypoint through npm_execpath or PNPM_HOME on Windows")


def main() -> int:
    # Reject before allocating outputs or running commands outside the approved hosted job.
    require(os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true", "CI-only Windows SDK golden review")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and os.environ.get("GITHUB_REF") == BRANCH, "Wrong CI repository/ref")
    require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "Manual first-attempt review only")
    sha = os.environ.get("SDK_GOLDEN_SOURCE_SHA", "")
    lock_hash = os.environ.get("SDK_GOLDEN_LOCK_SHA256", "")
    prep_id = os.environ.get("SDK_GOLDEN_PREPARATION_RUN", "")
    require(re.fullmatch(r"[a-f0-9]{40}", sha) is not None and sha == os.environ.get("GITHUB_SHA"), "Wrong approved SHA")
    require(sha == os.environ.get("GITHUB_WORKFLOW_SHA"), "Workflow implementation is not bound to the candidate")
    require(re.fullmatch(r"[a-f0-9]{64}", lock_hash) is not None and re.fullmatch(r"[1-9][0-9]*", prep_id) is not None, "Explicit lock/run binding required")
    root = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    require(git(root, "rev-parse", "HEAD") == sha and not tracked_changes(root), "Checkout does not equal the clean approved candidate")
    require(digest(root / "pnpm-lock.yaml") == lock_hash, "Approved lock changed")
    evidence = Path(tempfile.mkdtemp(prefix="auto-sdk-golden-review-", dir=os.environ["RUNNER_TEMP"]))
    # Keep the venv physically outside the artifact root, including on abrupt runner cancellation.
    python_environment = Path(tempfile.mkdtemp(prefix="auto-sdk-golden-python-", dir=os.environ["RUNNER_TEMP"])) / "venv"
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"evidence_path={evidence}\n")
    receipt = {"schemaVersion": 1, "purpose": "proposed SDK goldens for human review, NOT final CI or release qualification",
               "sourceSha": sha, "sourceTree": git(root, "rev-parse", "HEAD^{tree}"), "lockSha256": lock_hash,
               "workflowPath": WORKFLOW, "workflowSha": os.environ["GITHUB_WORKFLOW_SHA"],
               "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": 1,
               "runUrl": f"https://github.com/{REPOSITORY}/actions/runs/{os.environ['GITHUB_RUN_ID']}/attempts/1",
               "commands": [], "outcome": "failed", "finalQualification": False,
               "installedWheelAcceptance": False, "publicationAuthorized": False}
    failures = []
    command_env = dict(os.environ)
    for key in ("GITHUB_TOKEN", "GH_TOKEN", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "PYTHONPATH", "DSH_RUNTIME_MODE"):
        command_env.pop(key, None)
    command_env.update(DSH_TELEMETRY_DISABLED="1", DSH_BUILD_CLIENT_PROFILE="official",
                       UV_PROJECT_ENVIRONMENT=str(python_environment))

    def execute(label: str, argv: list[str], timeout: int, allow_failure: bool = False) -> tuple[int, bool, Path]:
        return execute_owned_command(root, evidence, command_env, receipt["commands"], label, argv, timeout, allow_failure)

    def pnpm(label: str, arguments: list[str], timeout: int) -> None:
        node = shutil.which("node", path=command_env.get("PATH"))
        execute(label, pnpm_invocation(arguments, command_env, node), timeout)

    try:
        prep = Path(os.environ["SDK_GOLDEN_PREPARATION_DIR"]).resolve()
        meta = Path(os.environ["SDK_GOLDEN_PREPARATION_METADATA"]).resolve()
        receipt["preparation"] = validate_preparation(root, prep, meta, sha, lock_hash, prep_id)
        (evidence / "preparation").mkdir()
        for name in ("inputs.json", "receipt.json", "contracts.log", "focused-tests.json"):
            shutil.copyfile(prep / name, evidence / "preparation" / name)
        shutil.copyfile(meta, evidence / "preparation" / "metadata.json")
        tracked = git(root, "ls-files", "-z").split("\0")
        selected = sorted(p for p in tracked if p and (p.startswith("scripts/") or p.startswith("python/") or p.startswith(".github/workflows/") or p.endswith("package.json") or p in ("pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.host.json", "tsconfig.client.json", "tsconfig.base.json")))
        original_hashes = {p: digest(safe_relative(root, p)) for p in selected}
        save(evidence / "source-input-hashes.json", original_hashes)
        current = root / GOLDEN_DIRECTORY
        original_names = sorted(p.name for p in current.iterdir() if p.is_file())
        require(set(GOLDENS).issubset(original_names), "All four committed v3 originals are required")
        (evidence / "original").mkdir()
        for name in original_names:
            shutil.copyfile(current / name, evidence / "original" / name)
        original_golden_hashes = {name: digest(current / name) for name in original_names}
        receipt["originalGoldens"] = original_golden_hashes
        require(not (root / "dist-exe/deepseek-harness-sdk-runtime-win-x64.exe").exists(), "Refuse an existing EXE; no binary reuse in this lane")
        execute("node-version", ["node", "--version"], 30)
        pnpm("pnpm-version", ["--version"], 30)
        execute("python-version", [sys.executable, "--version"], 30)
        require(load(root / "package.json")["packageManager"] == "pnpm@11.7.0", "Unexpected package manager")
        require((evidence / "pnpm-version.log").read_text().strip() == "11.7.0", "Wrong pnpm runtime")
        require(re.match(r"v24\.", (evidence / "node-version.log").read_text().strip()) is not None, "Wrong Node runtime")
        require(sys.version_info[:2] == (3, 10), "Python 3.10 is required")
        pnpm("frozen-install", ["install", "--frozen-lockfile"], 600)
        execute("host-types", ["node", "--max-old-space-size=4096", "node_modules/typescript/bin/tsc", "-b", "tsconfig.host.json"], 420)
        execute("host-bundle-typert", ["node", "node_modules/tsdown/dist/run.mjs", "--env.DSH_BUILD_FACE", "host"], 420)
        execute("client-types", ["node", "node_modules/typescript/bin/tsc", "-b", "tsconfig.client.json"], 420)
        # Use the established full native target build, not a guessed --skip-build optimization.
        pnpm("build-candidate-exe", ["exec", "tsx", "scripts/build-exe-for-python-sdk.ts", "--targets=node24-win-x64"], 1200)
        require(not tracked_changes(root), "Build changed tracked source; do not regenerate goldens from a changed checkout")
        exe = root / "dist-exe/deepseek-harness-sdk-runtime-win-x64.exe"
        rg = root / "dist-exe/deepseek-harness-sdk-runtime-win-x64-rg.exe"
        require(exe.is_file() and rg.is_file(), "Candidate executable or required sidecar missing")
        receipt["builtRuntime"] = {p.name: {"sha256": digest(p), "size": p.stat().st_size} for p in (exe, rg)}
        (evidence / "candidate-runtime").mkdir()
        for path in (exe, rg):
            shutil.copyfile(path, evidence / "candidate-runtime" / path.name)
        execute("python-tooling", [sys.executable, "-m", "pip", "install", "uv==0.11.23"], 180)
        execute("python-sdk-locked", ["uv", "sync", "--locked", "--python", "3.10", "--group", "test", "--project", "python/sdk"], 300)
        python = python_environment / "Scripts/python.exe"
        require(python.is_file(), "Owned source SDK environment missing")
        # The existing source-SDK mode uses --exe; it is not mislabeled --installed-wheel acceptance.
        snapshot_command = [str(python), str(root / "scripts/smoke-python-runtime.py"), "--scenario", "sdk-snapshot", "--exe", str(exe)]
        before_code, before_timeout, before_log = execute("compare-original", snapshot_command, 300, allow_failure=True)
        assert_expected_mismatch(before_code, before_timeout, before_log.read_text(encoding="utf-8", errors="replace"))
        require(not tracked_changes(root), "Original comparison mutated source/goldens")
        execute("regenerate-current", [*snapshot_command, "--update-snapshots"], 300)
        require(sorted(p.name for p in current.iterdir() if p.is_file()) == original_names, "Golden generation added/deleted files or changed generations")
        allowed = {f"{GOLDEN_DIRECTORY}/{name}" for name in GOLDENS}
        require(tracked_changes(root).issubset(allowed), "Unrelated tracked source changed during golden generation")
        for path, value in original_hashes.items():
            if path not in allowed:
                require(digest(root / path) == value, f"Protected source or historical generation changed: {path}")
        receipt["childSelectionEvidence"] = inspect_current_goldens(current)
        (evidence / "proposed").mkdir()
        for name in GOLDENS:
            shutil.copyfile(current / name, evidence / "proposed" / name)
        proposed_hashes = {name: digest(current / name) for name in GOLDENS}
        require(any(proposed_hashes[name] != original_golden_hashes[name] for name in GOLDENS), "No proposed golden changes")
        receipt["proposedGoldens"] = proposed_hashes
        patch = git(root, "diff", "--no-ext-diff", "--", *sorted(allowed))
        (evidence / "proposed.diff").write_text(patch + "\n", encoding="utf-8", newline="\n")
        execute("compare-proposed-unchanged", snapshot_command, 300)
        require({name: digest(current / name) for name in GOLDENS} == proposed_hashes, "Plain replay mutated proposed goldens")
        for path, value in original_hashes.items():
            if path not in allowed:
                require(digest(root / path) == value, f"Replay changed protected source: {path}")
        require(tracked_changes(root).issubset(allowed), "Replay changed unrelated tracked source")
        require(digest(root / "pnpm-lock.yaml") == lock_hash, "Lock changed")
        require({p.name: {"sha256": digest(p), "size": p.stat().st_size} for p in (exe, rg)} == receipt["builtRuntime"], "EXE/sidecar changed after initial comparison")
        receipt["outcome"] = "proposal-reproduced"
        receipt["nextStep"] = "Independently verify source/run/input/EXE/original/proposed hashes, review all four generated outputs and child events, commit only approved current goldens, then run unchanged required CI. This run does not qualify a merge or release."
    except Exception as error:
        # Store only our short command/validation failure summary; raw command evidence stays in its original log.
        failures.append({"type": type(error).__name__, "message": str(error)})
    finally:
        receipt["failures"] = failures
        # Unknown termination leaves logs unsealed; no ordinary receipt claims
        # their hashes or completeness while an owned process may still write.
        seal_review_evidence(evidence, receipt)
    return 0 if receipt["outcome"] == "proposal-reproduced" else 1


if __name__ == "__main__":
    sys.exit(main())
