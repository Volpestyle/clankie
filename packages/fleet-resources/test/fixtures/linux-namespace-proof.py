"""Portable journal contracts and opt-in real Linux namespace proofs (VUH-2091).

python3 -I -B linux-namespace-proof.py
python3 -I -B linux-namespace-proof.py --integration
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

HERE = Path(__file__).parents[2] / "src"
spec = importlib.util.spec_from_file_location("containment", HERE / "linux-namespace.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def record():
    birth = str(uuid.uuid4()) + ":123"
    proof = {"pid": 123, "uid": os.getuid(), "startTime": birth,
             "namespacePid": 1, "namespaceInode": 100}
    return {"schemaVersion": 1, "id": str(uuid.uuid4()), "permitId": str(uuid.uuid4()),
            "token": "a" * 64, "owner": proof, "namespaceInit": proof,
            "phase": "held", "empty": True}


class JournalContract(unittest.TestCase):
    def test_unknown_or_reported_empty_is_not_release_authority(self):
        receipt = record()
        for observation in (None, {"status": "unknown"}, {"empty": True},
                            {"status": "live", "identity": receipt["namespaceInit"]}):
            self.assertEqual(runtime.recovery(receipt, observation), "held")
        self.assertEqual(runtime.recovery(receipt, {"status": "exited"}), "released")
        changed = copy.deepcopy(receipt["namespaceInit"])
        changed["startTime"] = str(uuid.uuid4()) + ":456"
        changed["namespacePid"] = 42  # A reused PID need not be another init.
        self.assertEqual(runtime.recovery(receipt, {"status": "live", "identity": changed}), "released")
        del receipt["namespaceInit"]
        self.assertEqual(runtime.recovery(receipt, {"status": "exited"}), "held")

    def test_invalid_claims_and_journal_binding_fail_closed(self):
        self.assertFalse(runtime.valid_id("invalid"))
        self.assertFalse(runtime.valid_id(None))
        with tempfile.TemporaryDirectory() as directory:
            receipt = record()
            journal = runtime.Journal(directory, receipt["id"], create=True)
            try:
                journal.write(receipt)
                bad = copy.deepcopy(receipt)
                bad["id"] = str(uuid.uuid4())
                with self.assertRaises(RuntimeError):
                    journal.write(bad)
                runtime.native.write_state(str(journal.path), bad)
                with self.assertRaises(RuntimeError):
                    journal.read()
            finally:
                journal.close()

    def test_atomic_journal_and_crash_lock_are_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = record()
            journal = runtime.Journal(directory, receipt["id"], create=True)
            try:
                journal.write(receipt)
                inode = (journal.path / "state.json").stat().st_ino
                with self.assertRaises(BlockingIOError):
                    runtime.Journal(directory, receipt["id"])
                receipt["phase"] = "cleanup"
                journal.write(receipt)
                self.assertNotEqual((journal.path / "state.json").stat().st_ino, inode)
                self.assertEqual(journal.read(), receipt)
                self.assertEqual((journal.path / "state.json").stat().st_mode & 0o777, 0o600)
            finally:
                journal.close()
            reopened = runtime.Journal(directory, receipt["id"])
            reopened.close()
            with self.assertRaises(FileExistsError):
                runtime.Journal(directory, receipt["id"], create=True)
            missing = str(uuid.uuid4())
            with self.assertRaises(RuntimeError):
                runtime.Journal(directory, missing)
            self.assertFalse((Path(directory) / missing).exists())


# Real command tree: a detached double-fork plus a nested PID namespace. Neither
# remains in the command's process group. Heartbeats prove useful live work.
TREE = r'''
import os, subprocess, sys, time
from pathlib import Path
directory = Path(sys.argv[1])
if os.fork() == 0:
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    nested = "from pathlib import Path; import time; p=Path(%r);\nwhile True: p.write_text(str(time.monotonic())); time.sleep(.03)" % str(directory / "nested")
    subprocess.Popen(["unshare", "--user", "--map-root-user", "--pid", "--fork", sys.executable, "-I", "-B", "-c", nested])
    while True:
        (directory / "detached").write_text(str(time.monotonic()))
        time.sleep(.03)
(directory / "command").write_text("started")
while not (directory / "exit").exists():
    time.sleep(.03)
'''


def eventually(check, seconds=5):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = check()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("Real containment proof timed out")


class Job:
    def __init__(self, root, command, args):
        self.request = {"id": str(uuid.uuid4()), "permitId": str(uuid.uuid4()),
                        "token": uuid.uuid4().hex + uuid.uuid4().hex,
                        "command": command, "args": args}
        self.root = root
        self.pending = b""
        self.frames = []
        self.stderr = tempfile.TemporaryFile()
        self.process = subprocess.Popen([sys.executable, "-I", "-B", str(HERE / "linux-namespace.py"),
                                         "run", str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr)
        self.send(self.request)

    def send(self, value):
        self.process.stdin.write((json.dumps(value) + "\n").encode())
        self.process.stdin.flush()

    def control(self, action, token=None):
        self.send({"id": self.request["id"], "token": token or self.request["token"], "action": action})

    def phase(self, phase, seconds=15):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            for frame in self.frames:
                if frame.get("phase") == phase:
                    return frame
                if frame.get("error"):
                    raise AssertionError(frame)
            if select.select([self.process.stdout], [], [], .1)[0]:
                data = os.read(self.process.stdout.fileno(), 65536)
                if not data:
                    self.stderr.seek(0)
                    raise AssertionError((self.frames, self.stderr.read().decode()))
                self.pending += data
                while b"\n" in self.pending:
                    raw, self.pending = self.pending.split(b"\n", 1)
                    self.frames.append(json.loads(raw))
        raise AssertionError(("Missing phase", phase, self.frames))

    def receipt(self):
        return json.loads((self.root / self.request["id"] / "state.json").read_text())

    def inspect(self):
        result = subprocess.run([sys.executable, "-I", "-B", str(HERE / "linux-namespace.py"),
                                 "inspect", str(self.root), self.request["id"]], capture_output=True, timeout=5)
        return json.loads(result.stdout)

    def close(self):
        if self.process.poll() is None:
            self.process.kill()  # Our exact unreaped child; its death kills init.
        self.process.wait(timeout=15)
        self.process.stdin.close()
        self.process.stdout.close()
        self.stderr.close()


class NamespaceProof(unittest.TestCase):
    def setUp(self):
        runtime.supported()
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / "jobs"
        self.work = Path(self.directory.name) / "work"
        self.work.mkdir(mode=0o700)
        self.jobs = []
        # An unrelated same-user process must survive every cleanup below.
        self.unrelated = subprocess.Popen([sys.executable, "-I", "-B", "-c", "import time; time.sleep(90)"])

    def tearDown(self):
        for job in self.jobs:
            job.close()
        self.unrelated.kill()
        self.unrelated.wait()
        self.directory.cleanup()

    def job(self, tree=True):
        job = Job(self.root, sys.executable, ["-I", "-B", "-c", TREE, str(self.work)] if tree else ["-c", "pass"])
        self.jobs.append(job)
        return job

    def running_tree(self):
        job = self.job()
        proof = job.phase("prepared")["namespaceInit"]
        job.control("go")
        job.phase("running")
        eventually(lambda: all((self.work / name).exists() for name in ("command", "detached", "nested")))
        # Narrow ancestry walk from our exact init, never a global /proc census.
        def descendants(pid):
            try:
                children = [int(value) for value in Path("/proc/%s/task/%s/children" % (pid, pid)).read_text().split()]
            except FileNotFoundError:
                return []
            return children + [child for direct in children for child in descendants(direct)]
        pids = descendants(proof["pid"])
        births = [runtime.native.identity(pid) for pid in pids]
        births = [value for value in births if value]
        self.assertGreaterEqual(len(births), 4)  # root, detached, unshare, nested
        self.assertNotEqual(proof["namespaceInode"], os.stat("/proc/self/ns/pid").st_ino)
        return job, proof, births

    def gone(self, proof, births):
        def absent(birth):
            current = runtime.native.identity(birth["pid"])
            return current is None or current["startTime"] != birth["startTime"]
        eventually(lambda: all(absent(birth) for birth in [proof] + births))
        self.assertIsNone(self.unrelated.poll())
        for name in ("detached", "nested"):
            before = (self.work / name).read_text()
            time.sleep(.08)
            self.assertEqual((self.work / name).read_text(), before)

    def test_durable_gate_and_live_lock_before_command(self):
        job = self.job()
        proof = job.phase("prepared")["namespaceInit"]
        self.assertEqual(job.receipt()["namespaceInit"], proof)
        self.assertEqual(job.receipt()["phase"], "prepared")
        self.assertFalse((self.work / "command").exists())
        self.assertEqual(job.inspect()["reason"], "live-lock")
        job.control("go", "b" * 64)  # Wrong capability must never execute.
        self.assertTrue(job.phase("released")["empty"])
        self.assertFalse((self.work / "command").exists())
        self.assertNotIn(TREE, json.dumps(job.receipt()))
        self.assertIsNone(self.unrelated.poll())

    def test_cancel_kills_double_fork_and_nested_namespace(self):
        job, proof, births = self.running_tree()
        job.control("cancel")
        self.assertTrue(job.phase("released")["empty"])
        self.gone(proof, births)

    def test_wrapper_interruption_cancels_owned_tree(self):
        job, proof, births = self.running_tree()
        job.process.send_signal(signal.SIGTERM)
        self.assertTrue(job.phase("released")["empty"])
        self.assertEqual(job.process.wait(timeout=15), 130)
        self.gone(proof, births)

    def test_prepared_wrapper_crash_never_executes_command(self):
        job = self.job()
        proof = job.phase("prepared")["namespaceInit"]
        job.process.kill()
        job.process.wait(timeout=15)
        eventually(lambda: runtime.native.identity(proof["pid"]) is None)
        self.assertTrue(job.inspect()["empty"])
        self.assertFalse((self.work / "command").exists())
        self.assertIsNone(self.unrelated.poll())

    def test_transport_eof_kills_owned_tree(self):
        job, proof, births = self.running_tree()
        job.process.stdin.close()
        self.assertTrue(job.phase("released")["empty"])
        self.gone(proof, births)

    def test_wrapper_crash_releases_lock_then_recovers(self):
        job, proof, births = self.running_tree()
        job.process.kill()
        job.process.wait(timeout=15)
        self.gone(proof, births)
        self.assertTrue(job.inspect()["empty"])
        self.assertEqual(job.receipt()["phase"], "released")

    def test_init_crash_proves_empty_without_signalling_unrelated(self):
        job, proof, births = self.running_tree()
        fd = os.pidfd_open(proof["pid"])
        try:
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        finally:
            os.close(fd)
        self.assertTrue(job.phase("released")["empty"])
        self.gone(proof, births)

    def test_root_exit_keeps_receipt_until_leftovers_are_dead(self):
        job, proof, births = self.running_tree()
        (self.work / "exit").touch()
        job.phase("cleanup")
        self.assertEqual(job.receipt()["phase"], "cleanup")
        self.assertIsNotNone(runtime.native.identity(proof["pid"]))
        self.assertFalse(job.receipt().get("empty", False))
        self.assertTrue(job.phase("released")["empty"])
        self.gone(proof, births)


if __name__ == "__main__":
    integration = "--integration" in sys.argv
    suite = unittest.TestLoader().loadTestsFromTestCase(NamespaceProof if integration else JournalContract)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
