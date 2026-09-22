"""Offline owned-command cleanup regressions; taskkill and child processes are mocked, never invoked."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

SOURCE = Path(__file__).resolve().with_name('prepare-auto-sdk-goldens.py')
module = {'__name__': 'draft_sdk_owned_command_test'}
exec(compile(SOURCE.read_text(encoding='utf-8'), str(SOURCE), 'exec'), module)


class FakeChild:
    def __init__(self, outcomes, pid=424242):
        self.pid = pid
        self.outcomes = list(outcomes)
        self.waits = []

    def wait(self, *, timeout):
        self.waits.append(timeout)
        value = self.outcomes.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


class OwnedCommandTests(unittest.TestCase):
    def exercise(self, outcomes, kill=0, spawn_error=None, pid=424242, allow_failure=False):
        temporary = tempfile.TemporaryDirectory(prefix='sdk-owned-command-v2-')
        self.addCleanup(temporary.cleanup)
        evidence = Path(temporary.name)
        records = []
        cleanup_calls = []
        spawn_calls = []
        child = FakeChild(outcomes, pid)

        def popen(argv, **kwargs):
            spawn_calls.append((argv, kwargs))
            if spawn_error:
                raise spawn_error
            kwargs['stdout'].write(b'owned fixture output\n')
            return child

        def cleanup(argv, **kwargs):
            cleanup_calls.append((argv, kwargs))
            if isinstance(kill, BaseException):
                raise kill
            return SimpleNamespace(returncode=kill)

        clock = iter([10.0, 12.5])
        caught = None
        result = None
        try:
            result = module['execute_owned_command'](evidence, evidence, {}, records, 'fixture', ['owned-command'], 5,
                                                      allow_failure, popen=popen, run_cleanup=cleanup,
                                                      clock=lambda: next(clock))
        except RuntimeError as error:
            caught = error
        self.assertEqual(len(records), 1, 'Command attribution must survive all failure paths')
        self.assertEqual(records[0]['argv'], ['owned-command'])
        self.assertEqual(spawn_calls[0][0], ['owned-command'])
        self.assertEqual(spawn_calls[0][1]['cwd'], evidence)
        self.assertEqual(spawn_calls[0][1]['env'], {})
        self.assertNotIn('shell', spawn_calls[0][1])
        self.assertEqual(records[0]['durationSeconds'], 2.5)
        self.assertEqual(records[0]['timeoutSeconds'], 5)
        self.assertIsInstance(records[0]['startedAtUnixSeconds'], float)
        return evidence, records[0], child, cleanup_calls, spawn_calls, caught, result

    def test_success_never_invokes_kill_and_seals_after_wait(self):
        evidence, record, child, cleanup, _, error, result = self.exercise([0])
        self.assertIsNone(error)
        self.assertEqual(child.waits, [5])
        self.assertEqual(cleanup, [])
        self.assertTrue(record['cleanupComplete'])
        self.assertTrue(record['evidenceComplete'])
        self.assertIn('logSha256', record)
        self.assertEqual(result[:2], (0, False))
        receipt = {'commands': [record], 'outcome': 'proposal-reproduced'}
        module['seal_review_evidence'](evidence, receipt)
        self.assertTrue((evidence / 'receipt.json').is_file())
        self.assertTrue(receipt['evidenceSealed'])

    def test_spawn_failure_is_recorded_and_never_targets_an_unowned_pid(self):
        _, record, child, cleanup, _, error, _ = self.exercise([], spawn_error=FileNotFoundError('owned fixture'))
        self.assertIsNotNone(error)
        self.assertFalse(record['spawned'])
        self.assertEqual(record['failureType'], 'FileNotFoundError')
        self.assertEqual(child.waits, [])
        self.assertEqual(cleanup, [])
        self.assertFalse(record['termination']['attempted'])
        self.assertIsNone(record['exitCode'])

    def test_timeout_with_successful_owned_termination_is_still_failed_not_drift(self):
        _, record, child, cleanup, _, error, _ = self.exercise([subprocess.TimeoutExpired('owned', 5), 1])
        self.assertRegex(str(error), 'Command timed out')
        self.assertTrue(record['timedOut'])
        self.assertTrue(record['cleanupComplete'])
        self.assertTrue(record['termination']['rootReaped'])
        self.assertEqual(child.waits, [5, 30])
        self.assertEqual(cleanup[0][0], ['taskkill', '/PID', '424242', '/T', '/F'])
        self.assertEqual(cleanup[0][1]['timeout'], 10)
        self.assertEqual(record['termination']['killExitCode'], 0)

    def test_hung_taskkill_and_double_timeout_records_all_outcomes_without_hashing_live_log(self):
        evidence, record, child, cleanup, _, error, _ = self.exercise(
            [subprocess.TimeoutExpired('owned', 5), subprocess.TimeoutExpired('owned', 30)],
            kill=subprocess.TimeoutExpired('taskkill', 10))
        self.assertRegex(str(error), 'UNSEALED')
        self.assertEqual(child.waits, [5, 30])
        self.assertEqual(cleanup[0][1]['timeout'], 10)
        self.assertTrue(record['timedOut'])
        self.assertTrue(record['termination']['killTimedOut'])
        self.assertTrue(record['termination']['waitTimedOut'])
        self.assertFalse(record['termination']['rootReaped'])
        self.assertFalse(record['evidenceComplete'])
        self.assertNotIn('logSha256', record)
        receipt = {'commands': [record], 'outcome': 'failed'}
        original_digest = module['digest']
        module['digest'] = lambda *_: self.fail('Unsealed evidence must not be hashed')
        try:
            module['seal_review_evidence'](evidence, receipt)
        finally:
            module['digest'] = original_digest
        self.assertFalse((evidence / 'receipt.json').exists())
        retained = json.loads((evidence / 'unsealed-failure.json').read_text())
        self.assertEqual(retained['outcome'], 'failed-unsealed')
        self.assertFalse(retained['evidenceSealed'])
        self.assertNotIn('evidenceHashes', retained)
        # Model a still-live writer after bookkeeping: there is no false stable hash claim.
        (evidence / 'fixture.log').write_text('late owned output\n')
        self.assertEqual(json.loads((evidence / 'unsealed-failure.json').read_text()), retained)

    def test_failed_taskkill_stays_unsealed_even_if_root_exits(self):
        _, record, _, _, _, error, _ = self.exercise([subprocess.TimeoutExpired('owned', 5), 1], kill=5)
        self.assertRegex(str(error), 'UNSEALED')
        self.assertTrue(record['termination']['rootReaped'])
        self.assertFalse(record['cleanupComplete'], 'Root exit alone does not prove descendant cleanup')
        self.assertNotIn('logSha256', record)

    def test_taskkill_spawn_error_and_second_wait_error_are_both_recorded(self):
        _, record, _, _, _, error, _ = self.exercise(
            [subprocess.TimeoutExpired('owned', 5), OSError('wait fixture')], kill=FileNotFoundError('kill fixture'))
        self.assertRegex(str(error), 'UNSEALED')
        self.assertEqual(record['termination']['killErrorType'], 'FileNotFoundError')
        self.assertEqual(record['termination']['waitErrorType'], 'OSError')
        self.assertFalse(record['cleanupComplete'])

    def test_successful_kill_but_second_wait_timeout_does_not_claim_quiescence(self):
        _, record, _, _, _, error, _ = self.exercise(
            [subprocess.TimeoutExpired('owned', 5), subprocess.TimeoutExpired('owned', 30)], kill=0)
        self.assertRegex(str(error), 'UNSEALED')
        self.assertEqual(record['termination']['killExitCode'], 0)
        self.assertTrue(record['termination']['waitTimedOut'])
        self.assertFalse(record['evidenceComplete'])

    def test_refuses_current_process_or_invalid_pid_cleanup(self):
        for pid in (os.getpid(), -1, '424242'):
            with self.subTest(pid=pid):
                _, record, _, cleanup, _, error, _ = self.exercise([subprocess.TimeoutExpired('owned', 5)], pid=pid)
                self.assertRegex(str(error), 'UNSEALED')
                self.assertEqual(cleanup, [])
                self.assertEqual(record['failureType'], 'RuntimeError')
                self.assertFalse(record['cleanupComplete'])

    def test_initial_wait_fault_is_recorded_even_after_successful_cleanup(self):
        _, record, child, cleanup, _, error, _ = self.exercise([OSError('wait fixture'), 1])
        self.assertRegex(str(error), 'setup/wait failed')
        self.assertEqual(record['failureType'], 'OSError')
        self.assertEqual(child.waits, [5, 30])
        self.assertEqual(len(cleanup), 1)
        self.assertTrue(record['cleanupComplete'])
        self.assertEqual(record['termination']['waitErrorType'], 'OSError')

    def test_expected_exit_one_remains_available_to_mismatch_classifier(self):
        _, record, _, cleanup, _, error, result = self.exercise([1], allow_failure=True)
        self.assertIsNone(error)
        self.assertEqual(result[:2], (1, False))
        self.assertEqual(cleanup, [])
        self.assertTrue(record['evidenceComplete'])


if __name__ == '__main__':
    unittest.main()
