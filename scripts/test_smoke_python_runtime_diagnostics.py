"""Stdlib unit tests for Office failure summaries; never launch the runtime."""
from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SMOKE = runpy.run_path(str(Path(__file__).with_name("smoke-python-runtime.py")))
REPORT = SMOKE["report_office_diagnostics"]
PREFIX = "smoke-python-runtime: office diagnostics "


class OfficeDiagnosticsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="dsh-office-diagnostics-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stages = self.root / "phases.jsonl"
        self.output = self.root / "output.pdf"
        self.result = self.root / "result.json"

    def report(self) -> tuple[dict[str, object], str]:
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream):
            REPORT(self.stages, self.output, self.result)
        text = stream.getvalue()
        self.assertTrue(text.startswith(PREFIX))
        self.assertEqual(text.count("\n"), 1)
        self.assertLessEqual(len(text), 2048)
        self.assertNotIn(str(self.root), text)
        return json.loads(text.removeprefix(PREFIX)), text

    def test_reports_only_allowed_phases_and_file_metadata(self) -> None:
        record = {"phase": "render", "state": "start", "elapsedMs": 17}
        self.stages.write_text(json.dumps(record) + "\n", encoding="utf-8")
        self.output.write_bytes(b"DO_NOT_LOG_DOCUMENT")
        self.result.write_text("DO_NOT_LOG_RESULT", encoding="utf-8")
        summary, text = self.report()
        self.assertEqual(summary, {
            "recordStatus": "ok", "stages": [record],
            "output": {"exists": True, "bytes": self.output.stat().st_size},
            "result": {"exists": True, "bytes": self.result.stat().st_size},
        })
        self.assertNotIn("DO_NOT_LOG", text)

    def test_missing_record_and_outputs_are_explicit(self) -> None:
        summary, _ = self.report()
        self.assertEqual(summary, {
            "recordStatus": "missing", "stages": [],
            "output": {"exists": False}, "result": {"exists": False},
        })

    def test_invalid_partial_oversized_or_unexpected_records_are_not_echoed(self) -> None:
        valid = {"phase": "create", "state": "start", "elapsedMs": 0}
        candidates = [
            "DO_NOT_LOG_SECRET",
            '{"phase":"render",',
            json.dumps({**valid, "phase": "DO_NOT_LOG_SECRET"}),
            json.dumps({**valid, "state": "DO_NOT_LOG_SECRET"}),
            json.dumps({**valid, "elapsedMs": True}),
            json.dumps({**valid, "elapsedMs": -1}),
            json.dumps({**valid, "elapsedMs": 2_147_483_648}),
            json.dumps({**valid, "extra": "DO_NOT_LOG_SECRET"}),
            json.dumps(valid) + "\nDO_NOT_LOG_SECRET",
            (json.dumps(valid) + "\n") * 11,
            "X" * 2049,
        ]
        for payload in candidates:
            with self.subTest(payload_length=len(payload)):
                self.stages.write_text(payload, encoding="utf-8")
                summary, text = self.report()
                self.assertEqual(summary["recordStatus"], "invalid")
                self.assertEqual(summary["stages"], [])
                self.assertNotIn("DO_NOT_LOG", text)

    def test_ten_maximum_elapsed_records_fit_the_output_bound(self) -> None:
        records = [
            {"phase": phase, "state": state, "elapsedMs": 2_147_483_647}
            for phase in ("import", "create", "render", "result-write", "dispose")
            for state in ("start", "done")
        ]
        self.stages.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        summary, _ = self.report()
        self.assertEqual(summary["stages"], records)

    def test_unreadable_record_and_metadata_do_not_echo_exception(self) -> None:
        with patch.object(Path, "open", side_effect=PermissionError("DO_NOT_LOG_SECRET")):
            with patch.object(Path, "stat", side_effect=PermissionError("DO_NOT_LOG_SECRET")):
                summary, text = self.report()
        self.assertEqual(summary["recordStatus"], "unavailable")
        self.assertEqual(summary["output"], {"status": "unavailable"})
        self.assertEqual(summary["result"], {"status": "unavailable"})
        self.assertNotIn("DO_NOT_LOG", text)

    def test_broken_diagnostic_sink_does_not_raise(self) -> None:
        sink = unittest.mock.Mock()
        sink.write.side_effect = OSError("diagnostic sink unavailable")
        with contextlib.redirect_stderr(sink):
            REPORT(self.stages, self.output, self.result)

    def test_smoke_reports_before_cleanup_and_reraises_original_timeout(self) -> None:
        executable = self.root / "deepseek-harness-sdk-runtime-win-x64.exe"
        executable.write_bytes(b"unit fixture only; never executed")
        modules = self.root / "deepseek-harness-sdk-runtime-win-x64-office/node_modules/@deepseek-ai"
        adapter = modules / "libreoffice-kit"
        engine = modules / "libreoffice-kit-win32-x64"
        adapter.mkdir(parents=True)
        engine.mkdir()
        (adapter / "package.json").write_text(json.dumps({
            "optionalDependencies": {"@deepseek-ai/libreoffice-kit-win32-x64": "0.0.1"},
        }), encoding="utf-8")
        (engine / "prebuilds.json").write_text('{"engine":{"kind":"native"}}', encoding="utf-8")
        original = TimeoutError("unit initialize timeout")
        captured: dict[str, object] = {}

        class FakeHarness:
            def __init__(self, **kwargs: object) -> None:
                captured.update(kwargs)

            def __enter__(self) -> None:
                patch_path = Path(captured["patches"][0])
                config = json.loads(patch_path.read_text())[0]["insert"][0]["config"]
                Path(config["diagnostics"]).write_text('{"phase":"import","state":"start","elapsedMs":0}\n', encoding="utf-8")
                raise original

            def __exit__(self, *_args: object) -> None:
                raise AssertionError("a failed context entry must not call exit")

        smoke = SMOKE["smoke_sdk_office"]
        real_report = smoke.__globals__["report_office_diagnostics"]

        def checked_report(stages: Path, output: Path, result: Path) -> None:
            self.assertTrue(stages.parent.is_dir())
            self.assertTrue(stages.is_file())
            real_report(stages, output, result)

        stream = io.StringIO()
        with patch.dict(sys.modules, {"deepseek_harness": types.SimpleNamespace(DeepSeekHarness=FakeHarness)}):
            with patch.dict(smoke.__globals__, {"report_office_diagnostics": checked_report}):
                with contextlib.redirect_stderr(stream):
                    with self.assertRaises(TimeoutError) as raised:
                        smoke(executable)
        self.assertIs(raised.exception, original)
        self.assertEqual(captured["request_timeout_seconds"], 180)
        self.assertNotIn("initialize_timeout_seconds", captured)
        self.assertFalse(Path(captured["cwd"]).exists())
        summary = json.loads(stream.getvalue().removeprefix(PREFIX))
        self.assertEqual(summary["stages"], [{"phase": "import", "state": "start", "elapsedMs": 0}])
        self.assertNotIn(str(self.root), stream.getvalue())


if __name__ == "__main__":
    unittest.main()
