import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from client import Desktop, TransportError, require_success


class ClientTests(unittest.TestCase):
    def fixture(self, body):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        binary = Path(directory.name) / 'fixture'
        prelude = '''#!/usr/bin/env python3
import sys,json,time
identity={'pid':1,'generation':'1','bundle':'synthetic.fixture'}
common={'success':True,'target':identity,'foregroundBefore':identity,'foregroundAfter':identity,'focusChangesDuringOperation':0}
'''
        binary.write_text(prelude + body)
        binary.chmod(0o700)
        return binary

    def assert_poisoned(self, desktop, error):
        self.assertTrue(desktop.closed)
        self.assertIsNotNone(desktop.process.poll())
        with patch('client.os.write') as write:
            with self.assertRaises(TransportError) as again:
                desktop.request({'op': 'observe', 'window': 'w'})
            write.assert_not_called()
        self.assertIs(again.exception, error)
        self.assertFalse(error.retry_safe)

    def test_round_trip_and_explicit_action_opt_in(self):
        binary = self.fixture("for line in sys.stdin:\n print(json.dumps(dict(common,windows=[],request=json.loads(line),args=sys.argv[1:])),flush=True)\n")
        with Desktop(binary) as desktop:
            result = desktop.request({'op': 'windows'})
            self.assertEqual(result['args'], ['session'])
            self.assertEqual(result['request'], {'op': 'windows'})
            with self.assertRaises(ValueError):
                desktop.request({'op': 'windows', 'extra': 'x' * 16385})
            self.assertTrue(desktop.request({'op': 'windows'})['success'])
        self.assertEqual(desktop.process.returncode, 0)
        desktop.close()  # Context cleanup is idempotent, not menu cleanup.
        with Desktop(binary, allow_menu_actions=True) as desktop:
            self.assertIn('--allow-menu-actions', desktop.request({'op': 'windows'})['args'])

    def test_output_eof_json_and_framing_failures_poison_transport(self):
        for body in [
            "sys.stdin.readline()\n",
            "sys.stdin.readline()\nprint('invalid',flush=True)\n",
            "sys.stdin.readline()\nprint('[]',flush=True)\n",
            "sys.stdin.readline()\nsys.stdout.write('x' * (600 * 1024));sys.stdout.flush()\n",
            "sys.stdin.readline()\nsys.stderr.write('x' * (600 * 1024));sys.stderr.flush()\n",
            "sys.stdin.readline()\nprint('{}\\n{}',flush=True)\n",
            "sys.stdin.readline()\nsys.stdout.write('{}');sys.stdout.flush()\n",
        ]:
            with self.subTest(body=body), Desktop(self.fixture(body), allow_menu_actions=True) as desktop:
                with self.assertRaises(TransportError) as failed:
                    desktop.request({'op': 'menu', 'action': 'AXShowMenu'})
                self.assertTrue(failed.exception.action_may_have_dispatched)
                self.assert_poisoned(desktop, failed.exception)

    def test_timeout_cannot_return_late_menu_reply_as_observation(self):
        # The review's 12.3-second late response, with a shorter clock for this inert test.
        binary = self.fixture('''first=json.loads(sys.stdin.readline())
time.sleep(0.4)
print(json.dumps(dict(common,actionDispatched=True,action='AXShowMenu',effect='unverified',retrySafe=False)),flush=True)
for line in sys.stdin:
 print(json.dumps(dict(common,nodes=[],window='w',snapshot='s',visited=0,incomplete=False)),flush=True)
''')
        with patch('client.REQUEST_TIMEOUT', 0.2), Desktop(binary, allow_menu_actions=True) as desktop:
            with self.assertRaises(TransportError) as failed:
                desktop.request({'op': 'menu', 'action': 'AXShowMenu'})
            self.assertIsInstance(failed.exception.__cause__, TimeoutError)
            self.assertTrue(failed.exception.action_may_have_dispatched)
            self.assert_poisoned(desktop, failed.exception)

    def test_write_uses_same_deadline_and_handles_partial_writes(self):
        with patch('client.REQUEST_TIMEOUT', 0.1), Desktop(self.fixture('time.sleep(10)\n')) as desktop:
            # Fill a real pipe whose child never reads; request must not block in write/flush.
            while True:
                try:
                    os.write(desktop.process.stdin.fileno(), b'x' * 4096)
                except BlockingIOError:
                    break
            started = time.monotonic()
            with self.assertRaises(TransportError) as failed:
                desktop.request({'op': 'windows'})
            self.assertLess(time.monotonic() - started, 1)
            self.assertIsInstance(failed.exception.__cause__, TimeoutError)
            self.assertFalse(failed.exception.action_may_have_dispatched)
            self.assert_poisoned(desktop, failed.exception)
        binary = self.fixture("for line in sys.stdin:\n print(json.dumps(dict(common,windows=[],request=json.loads(line))),flush=True)\n")
        real_write = os.write
        with Desktop(binary) as desktop, patch('client.os.write', side_effect=lambda fd, data: real_write(fd, data[:3])):
            self.assertEqual(desktop.request({'op': 'windows'})['request'], {'op': 'windows'})

    def test_response_shape_must_match_request(self):
        responses = [
            "dict(common,actionDispatched=True,action='AXShowMenu',effect='unverified',retrySafe=False)",
            "dict(common,nodes='wrong',window='w',snapshot='s',visited=0,incomplete=False)",
            "dict(common,nodes=[],window='another-root',snapshot='s',visited=0,incomplete=False)",
            "{'success':False,'code':'ax_action','actionDispatched':True,'retrySafe':True}",
        ]
        for expression in responses:
            with self.subTest(expression=expression), Desktop(self.fixture(
                f"sys.stdin.readline()\nprint(json.dumps({expression}),flush=True)\n"
            )) as desktop:
                with self.assertRaisesRegex(TransportError, 'shape') as failed:
                    desktop.request({'op': 'observe', 'window': 'w'})
                self.assert_poisoned(desktop, failed.exception)

    def test_menu_success_retains_uncertainty_after_later_eof(self):
        binary = self.fixture("sys.stdin.readline()\nprint(json.dumps(dict(common,actionDispatched=True,action='AXShowMenu',effect='unverified',retrySafe=False)),flush=True)\nsys.stdin.readline()\n")
        with Desktop(binary, allow_menu_actions=True) as desktop:
            result = require_success(desktop.request({'op': 'menu', 'action': 'AXShowMenu'}))
            self.assertEqual(result['effect'], 'unverified')
            with self.assertRaises(TransportError) as failed:
                desktop.request({'op': 'observe', 'window': 'w'})
            self.assertTrue(failed.exception.action_may_have_dispatched)
            self.assert_poisoned(desktop, failed.exception)

    def test_well_framed_indeterminate_action_allows_deliberate_inspection(self):
        binary = self.fixture('''for line in sys.stdin:
 request=json.loads(line)
 if request['op']=='menu':
  result={'success':False,'code':'ax_action','actionDispatched':True,'retrySafe':False}
 else:
  result=dict(common,nodes=[],window='w',snapshot='s',visited=0,incomplete=False)
 print(json.dumps(result),flush=True)
''')
        with Desktop(binary, allow_menu_actions=True) as desktop:
            result = desktop.request({'op': 'menu', 'action': 'AXShowMenu'})
            self.assertFalse(result['success'])
            self.assertTrue(result['actionDispatched'])
            self.assertTrue(desktop.action_may_have_dispatched)
            with self.assertRaises(RuntimeError):
                require_success(result)
            self.assertEqual(require_success(desktop.request({'op': 'observe', 'window': 'w'}))['nodes'], [])


if __name__ == '__main__':
    unittest.main()
