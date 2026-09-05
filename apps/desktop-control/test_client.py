import json
from pathlib import Path
import tempfile
import unittest

from client import Desktop


class ClientTests(unittest.TestCase):
    def fixture(self, body):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        binary = Path(directory.name) / "fixture"
        binary.write_text("#!/usr/bin/env python3\nimport sys,json\n" + body)
        binary.chmod(0o700)
        return binary

    def test_round_trip_and_explicit_action_opt_in(self):
        binary = self.fixture("for line in sys.stdin:\n print(json.dumps({'request':json.loads(line),'args':sys.argv[1:]}),flush=True)\n")
        with Desktop(binary) as desktop:
            result = desktop.request({"op": "windows"})
            self.assertEqual(result["args"], ["session"])
            self.assertEqual(result["request"], {"op": "windows"})
            with self.assertRaises(ValueError):
                desktop.request({"op": "x" * 16385})
        self.assertEqual(desktop.process.returncode, 0)
        with Desktop(binary, allow_menu_actions=True) as desktop:
            self.assertIn("--allow-menu-actions", desktop.request({"op": "windows"})["args"])

    def test_response_bound(self):
        binary = self.fixture("sys.stdin.readline()\nsys.stdout.write('x' * (600 * 1024));sys.stdout.flush()\n")
        with Desktop(binary) as desktop:
            with self.assertRaisesRegex(RuntimeError, "bound"):
                desktop.request({"op": "windows"})

    def test_eof_and_invalid_json_are_failures(self):
        for body, error in [("sys.stdin.readline()\n", RuntimeError),
                            ("sys.stdin.readline()\nprint('invalid',flush=True)\n", json.JSONDecodeError)]:
            with self.subTest(body=body), Desktop(self.fixture(body)) as desktop:
                with self.assertRaises(error):
                    desktop.request({"op": "windows"})


if __name__ == "__main__":
    unittest.main()
