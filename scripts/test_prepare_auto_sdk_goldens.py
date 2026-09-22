"""Offline draft-driver guards only; never invoke packaging, GitHub, pip, uv, or the smoke runner."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().with_name('prepare-auto-sdk-goldens.py')
module = {'__name__': 'draft_sdk_review_test_import'}
exec(compile(SOURCE.read_text(encoding='utf-8'), str(SOURCE), 'exec'), module)


class Guards(unittest.TestCase):
    def test_driver_parses_without_execution(self):
        self.assertTrue(callable(module['main']))

    def test_expected_snapshot_mismatch_is_distinct_from_general_failure(self):
        text = standalone_mismatch()
        module['assert_expected_mismatch'](1, False, text)
        for code, timeout, log in [(0, False, text), (1, True, text), (2, False, text), (1, False, 'ModuleNotFoundError'), (1, False, text.replace('@@', 'NO_DIFF')), (1, False, text.replace('result.json', 'other.json'))]:
            with self.subTest(code=code, timeout=timeout, log=log):
                with self.assertRaises(RuntimeError):
                    module['assert_expected_mismatch'](code, timeout, log)

    def test_output_path_traversal_rejected(self):
        with tempfile.TemporaryDirectory(prefix='sdk-review-guard-') as temporary:
            root = Path(temporary)
            for name in ('../escape', '/absolute', 'C:/outside', 'nested\\bad', './name', 'nested//name'):
                with self.subTest(name=name), self.assertRaises(RuntimeError):
                    module['safe_relative'](root, name)
            self.assertEqual(module['safe_relative'](root, 'normal/file.json'), root / 'normal/file.json')

    def test_generated_outputs_preserve_real_native_selection(self):
        with tempfile.TemporaryDirectory(prefix='sdk-review-goldens-') as temporary:
            root = Path(temporary)
            (root / 'result.json').write_text(json.dumps({'final_response': 'ADVANCED_EXECUTABLE_OK'}))
            header = {'type': 'session', 'version': 3}
            for name in module['GOLDENS'][1:]:
                records = [header]
                if name != 'session.v3.jsonl':
                    records.extend([{'type': 'subagent/model-selection', 'data': {'source': 'inheritance', 'provider': 'test', 'model': 'small', 'reasoningEffort': 'low'}}, {'type': 'request/header', 'data': {'header': {'config': {'provider': 'test', 'model': 'small', 'reasoningEffort': 'low'}}}}])
                (root / name).write_text('\n'.join(map(json.dumps, records)) + '\n')
            self.assertEqual(len(module['inspect_current_goldens'](root)), 2)
            path = root / 'session.1.v3.jsonl'
            original = path.read_text()
            for changed in (original.replace('"version": 3', '"version": 4'), original.replace('"source": "inheritance"', '"source": "invented"'), original.replace('"reasoningEffort": "low"', '"reasoningEffort": "high"', 1), original.splitlines()[0] + '\n'):
                path.write_text(changed)
                with self.assertRaises(RuntimeError):
                    module['inspect_current_goldens'](root)
            path.write_text(original)
            records = path.read_text().splitlines()
            path.write_text('\n'.join([*records, records[1]]) + '\n')
            with self.assertRaises(RuntimeError):
                module['inspect_current_goldens'](root)

    def preparation_fixture(self, root):
        src, artifact = root / 'source', root / 'prep'
        src.mkdir(); artifact.mkdir()
        inputs_paths = ['package.json', 'packages/llm/model-routing-learning/package.json', 'pnpm-workspace.yaml', '.github/workflows/auto-routing-prepare.yml']
        for name in inputs_paths:
            path = src / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('{}\n')
        (src / 'pnpm-lock.yaml').write_text('fixture-lock\n')
        (artifact / 'pnpm-lock.yaml').write_bytes((src / 'pnpm-lock.yaml').read_bytes())
        sha = 'a' * 40
        lock = module['digest'](src / 'pnpm-lock.yaml')
        fields = {'schemaVersion': 1, 'repository': module['REPOSITORY'], 'sourceSha': sha, 'workflowSha': sha, 'workflowRef': f"{module['REPOSITORY']}/.github/workflows/auto-routing-prepare.yml@{module['BRANCH']}", 'runId': '123', 'runAttempt': '1', 'originalLockSha256': lock, 'inputHashes': {p: module['digest'](src / p) for p in inputs_paths}}
        (artifact / 'inputs.json').write_text(json.dumps(fields))
        evidence = ['inputs.json', 'generated-lock.json', 'generate.log', 'frozen-install.json', 'frozen-install.log', 'focused-tests.json', 'focused-tests.log', 'contracts.log', 'third-party-notices.log', 'THIRD_PARTY_NOTICES.md']
        for name in evidence:
            if name == 'inputs.json': continue
            (artifact / name).write_text(json.dumps({'exitCode': 0}) if name.endswith('.json') else 'owned-log\n')
        receipt = {**fields, 'outcomes': copy.deepcopy(module['OUTCOMES']), 'finalQualification': False, 'inputIntegrityPassed': True, 'integrityErrors': [], 'focusedTestsPassed': True, 'resultingLockSha256': lock, 'evidenceHashes': {p: module['digest'](artifact / p) for p in evidence}}
        (artifact / 'receipt.json').write_text(json.dumps(receipt))
        metadata = {'run': {'id': 123, 'run_attempt': 1, 'head_sha': sha, 'head_branch': 'cloga-auto-minimal-golden-113', 'repository': {'full_name': module['REPOSITORY']}, 'head_repository': {'full_name': module['REPOSITORY']}, 'status': 'completed', 'conclusion': 'success', 'event': 'push', 'path': '.github/workflows/auto-routing-prepare.yml'}, 'artifact': {'id': 789, 'name': f'auto-routing-prepare-{sha}-123-1', 'expired': False}}
        meta = root / 'metadata.json'; meta.write_text(json.dumps(metadata))
        module['git'] = lambda *_args: '\0'.join(inputs_paths) + '\0'
        return src, artifact, meta, sha, lock, receipt, metadata

    def test_preparation_binding_and_rehashed_negatives(self):
        for mutation in ('none', 'wrong-sha', 'failed-run', 'contracts-skipped', 'old-lock', 'missing-input', 'tampered-log', 'nonzero-test', 'wrong-artifact'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory(prefix='sdk-review-prep-') as temporary:
                src, artifact, meta, sha, lock, receipt, metadata = self.preparation_fixture(Path(temporary))
                if mutation == 'wrong-sha': metadata['run']['head_sha'] = 'b' * 40
                if mutation == 'failed-run': metadata['run']['conclusion'] = 'failure'
                if mutation == 'contracts-skipped': receipt['outcomes']['hostAndClientContracts'] = 'skipped'
                if mutation == 'old-lock': receipt['originalLockSha256'] = 'b' * 64
                if mutation == 'missing-input': del receipt['inputHashes']['package.json']
                if mutation == 'tampered-log': (artifact / 'contracts.log').write_text('changed')
                if mutation == 'nonzero-test':
                    (artifact / 'focused-tests.json').write_text(json.dumps({'exitCode': 1}))
                    receipt['evidenceHashes']['focused-tests.json'] = module['digest'](artifact / 'focused-tests.json')
                if mutation == 'wrong-artifact': metadata['artifact']['name'] = 'other'
                meta.write_text(json.dumps(metadata)); (artifact / 'receipt.json').write_text(json.dumps(receipt))
                if mutation == 'none':
                    self.assertTrue(module['validate_preparation'](src, artifact, meta, sha, lock, '123')['allFiveOutcomesPassed'])
                else:
                    with self.assertRaises(RuntimeError):
                        module['validate_preparation'](src, artifact, meta, sha, lock, '123')


def standalone_mismatch(filename='result.json'):
    return (
        'Traceback (most recent call last):\n'
        '  File "smoke-python-runtime.py", line 2509, in <module>\n'
        '    main()\n'
        '  File "smoke-python-runtime.py", line 2501, in compare_snapshot_files\n'
        '    raise AssertionError(\n'
        f'AssertionError: advanced executable snapshot mismatch in {filename}; '
        'rerun with --update-snapshots after reviewing the behavior\n'
        f'--- expected/{filename}\n+++ actual/{filename}\n@@ -1 +1 @@\n-old\n+new\n\n'
    )


class TerminalMismatchRegression(unittest.TestCase):
    def test_refuses_mismatch_then_cleanup_traceback(self):
        combined = standalone_mismatch() + (
            'During handling of the above exception, another exception occurred:\n\n'
            'Traceback (most recent call last):\n'
            '  File "tempfile.py", line 947, in __exit__\n'
            '    self.cleanup()\n'
            'PermissionError: [WinError 5] Access is denied\n'
        )
        with self.assertRaisesRegex(RuntimeError, 'chained/secondary'):
            module['assert_expected_mismatch'](1, False, combined)

    def test_real_python_context_manager_cleanup_failure_is_not_snapshot_drift(self):
        import subprocess
        import sys
        message = standalone_mismatch().split('AssertionError: ', 1)[1].rstrip('\n')
        script = (
            'class Cleanup:\n'
            '    def __enter__(self): return self\n'
            '    def __exit__(self, *args): raise PermissionError("[WinError 5] fixture cleanup denied")\n'
            'with Cleanup():\n'
            f'    raise AssertionError({message!r})\n'
        )
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn('PermissionError: [WinError 5] fixture cleanup denied', result.stderr)
        with self.assertRaisesRegex(RuntimeError, 'chained/secondary'):
            module['assert_expected_mismatch'](result.returncode, False, result.stdout + result.stderr)

    def test_real_standalone_python_assertion_with_multihunk_diff_is_accepted(self):
        import difflib
        import subprocess
        import sys
        before = [f'{number}\n' for number in range(30)]
        after = list(before)
        after[1], after[25] = 'changed-first\n', 'changed-last\n'
        diff = ''.join(difflib.unified_diff(before, after, fromfile='expected/result.json', tofile='actual/result.json'))
        message = 'advanced executable snapshot mismatch in result.json; rerun with --update-snapshots after reviewing the behavior\n' + diff
        result = subprocess.run([sys.executable, '-c', f'raise AssertionError({message!r})'], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        module['assert_expected_mismatch'](result.returncode, False, result.stderr)
        module['assert_expected_mismatch'](result.returncode, False, result.stderr.replace('\n', '\r\n'))

    def test_rejects_secondary_errors_even_without_a_second_traceback_header(self):
        for suffix in (
            'PermissionError: cleanup denied\n',
            'RuntimeError: later failure\n',
            'Exception ignored in: <function cleanup>\n',
            'The above exception was the direct cause of the following exception:\n',
            '+PermissionError: prefixed but outside any declared hunk\n',
        ):
            with self.subTest(suffix=suffix), self.assertRaises(RuntimeError):
                module['assert_expected_mismatch'](1, False, standalone_mismatch() + suffix)

    def test_rejects_chained_failure_even_when_expected_assertion_is_last(self):
        prefix = (
            'Traceback (most recent call last):\n'
            '  File "fixture.py", line 1, in <module>\n'
            '    fail()\n'
            'PermissionError: earlier failure\n\n'
            'The above exception was the direct cause of the following exception:\n\n'
        )
        with self.assertRaises(RuntimeError):
            module['assert_expected_mismatch'](1, False, prefix + standalone_mismatch())

    def test_rejects_plain_printed_mismatch_without_top_level_traceback(self):
        log = standalone_mismatch().split('AssertionError: ', 1)[1]
        with self.assertRaises(RuntimeError):
            module['assert_expected_mismatch'](1, False, 'AssertionError: ' + log)

    def test_rejects_partial_or_counterfeit_hunks(self):
        valid = standalone_mismatch()
        for invalid in (
            valid.replace('@@ -1 +1 @@', '@@ -1,2 +1 @@'),
            valid.replace('-old\n+new', '-old'),
            valid.replace('-old\n+new', ' unchanged'),
            valid.replace('@@ -1 +1 @@\n-old\n+new', '@@ -0,0 +0,0 @@'),
        ):
            with self.subTest(invalid=invalid), self.assertRaises(RuntimeError):
                module['assert_expected_mismatch'](1, False, invalid)

    def test_all_four_current_golden_roles_allow_terminal_mismatch(self):
        for filename in module['GOLDENS']:
            with self.subTest(filename=filename):
                module['assert_expected_mismatch'](1, False, standalone_mismatch(filename))


class PnpmInvocationTests(unittest.TestCase):
    def setup_paths(self):
        temporary = tempfile.TemporaryDirectory(prefix='sdk-pnpm-entry-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        node = root / 'node.exe'
        node.write_text('owned executable path fixture')
        return root, str(node)

    def test_explicit_javascript_entry_preserves_argument_array(self):
        root, node = self.setup_paths()
        for suffix in ('.js', '.cjs', '.mjs'):
            entry = root / ('pnpm entry' + suffix)
            entry.write_text('owned JavaScript path fixture')
            args = ['exec', 'tsx', 'path with spaces.ts', '--targets=node24-win-x64']
            self.assertEqual(module['pnpm_invocation'](args, {'npm_execpath': str(entry)}, node),
                             [node, str(entry.resolve()), *args])

    def test_pnpm_home_uses_existing_builder_layout_without_cmd_execution(self):
        root, node = self.setup_paths()
        home = root / 'node_modules' / '.bin'
        package_bin = home.parent / 'pnpm' / 'bin'
        package_bin.mkdir(parents=True)
        entry = package_bin / 'pnpm.cjs'
        entry.write_text('owned fixture')
        self.assertTrue(entry.is_file())
        for environment in ({'PNPM_HOME': str(home)}, {'PNPM_HOME': str(home), 'npm_execpath': str(home / 'pnpm.cmd')}):
            self.assertEqual(module['pnpm_invocation'](['--version'], environment, node), [node, str(entry.resolve()), '--version'])
        preferred = package_bin / 'pnpm.mjs'
        preferred.write_text('owned fixture')
        self.assertTrue(preferred.is_file())
        self.assertEqual(module['pnpm_invocation'](['--version'], {'PNPM_HOME': str(home)}, node),
                         [node, str(preferred.resolve()), '--version'])

    def test_missing_and_invalid_entries_refuse_windows_fallbacks(self):
        root, node = self.setup_paths()
        cases = ({}, {'npm_execpath': ''}, {'PNPM_HOME': str(root / 'absent')},
                 {'npm_execpath': str(root / 'missing.mjs')}, {'npm_execpath': str(root / 'pnpm.txt')},
                 {'npm_execpath': str(root / 'pnpm.cmd')})
        for environment in cases:
            with self.subTest(environment=environment), self.assertRaises(RuntimeError):
                module['pnpm_invocation'](['install'], environment, node)

    def test_invalid_explicit_entry_does_not_silently_select_home(self):
        root, node = self.setup_paths()
        home = root / '.bin'
        entry = root / 'pnpm' / 'bin' / 'pnpm.mjs'
        entry.parent.mkdir(parents=True)
        entry.write_text('owned fixture')
        with self.assertRaises(RuntimeError):
            module['pnpm_invocation'](['install'], {'npm_execpath': str(root / 'missing.mjs'), 'PNPM_HOME': str(home)}, node)

    def test_missing_node_refuses_before_invocation(self):
        root, _ = self.setup_paths()
        for node in (None, str(root / 'missing-node.exe')):
            with self.subTest(node=node), self.assertRaises(RuntimeError):
                module['pnpm_invocation'](['--version'], {}, node)


if __name__ == '__main__':
    unittest.main()
