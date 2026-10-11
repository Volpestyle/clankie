"""Real Linux sockets/processes only; owns every child and no host resources."""
import ctypes
import importlib.util
import importlib.machinery
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import unittest

HELPER = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_loader("linux_fleet_proof", importlib.machinery.SourceFileLoader("linux_fleet_proof", str(HELPER)))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LinuxProof(unittest.TestCase):
    def setUp(self):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen()
        self.client = socket.socket()
        self.client.connect(self.server.getsockname())
        self.peer, _ = self.server.accept()
        self.ports = [str(self.client.getsockname()[1]), str(self.server.getsockname()[1])]
        self.children = []

    def tearDown(self):
        for child in self.children:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
        self.client.close()
        self.peer.close()
        self.server.close()

    def run_proof(self, *args):
        result = subprocess.run([str(HELPER), *(args or self.ports), "--diagnostics"],
                                capture_output=True, text=True, timeout=2)
        return result, json.loads(result.stdout) if result.returncode == 0 else None

    def admitted(self):
        result, proof = self.run_proof()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(proof["owner"]["pid"], os.getpid())
        self.assertEqual(proof["owner"]["uid"], os.getuid())
        self.assertEqual(proof["ancestors"][0]["kernelIdentity"], proof["owner"]["kernelIdentity"])
        self.assertEqual(proof["census"]["attempts"], len(proof["census"]["refusals"]) + 2)
        return proof

    def child(self, action):
        read, write = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(read)
                action(write)
                os.write(write, b"ready")
                while True:
                    signal.pause()
            except BaseException:
                os._exit(99)
        self.children.append(pid)
        os.close(write)
        self.assertTrue(select.select([read], [], [], 2)[0], "Owned child did not signal readiness")
        ready = os.read(read, 5)
        os.close(read)
        self.assertEqual(ready, b"ready")
        return pid

    def reap(self, pid):
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        self.children.remove(pid)

    def test_kernel_owner_duplicate_fds_and_exact_lifetime_fences(self):
        before = self.admitted()
        duplicate = os.dup(self.client.fileno())
        try:
            after = self.admitted()
            self.assertEqual(after["owner"], before["owner"])
            self.assertEqual(after["ancestors"], before["ancestors"])
            owner = before["owner"]
            expected = [str(owner["pid"]), *owner["birth"], owner["socket"], owner["kernelIdentity"]]
            result, actual = self.run_proof(*self.ports, *expected)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(actual["owner"], before["owner"])
            self.assertEqual(actual["ancestors"], before["ancestors"])
            for index in (0, 1, 3, 4):
                wrong = expected.copy()
                wrong[index] += "1"
                result, _ = self.run_proof(*self.ports, *wrong)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
        finally:
            os.close(duplicate)

    def test_second_same_user_owner_including_descriptor_zero_refuses(self):
        self.admitted()

        def fd_zero(_):
            os.dup2(self.client.fileno(), 0)
            self.client.close()

        pid = self.child(fd_zero)
        result, _ = self.run_proof()
        self.assertEqual(result.returncode, 1)
        self.assertIn('"reason":"multiple_owners"', result.stderr)
        self.reap(pid)
        self.admitted()

    def test_real_census_churn_restarts_whole_scan_and_records_attempts(self):
        with module.Proof() as proof:
            observe = proof.entries
            changed = False

            def observe_then_birth(directory, maximum):
                nonlocal changed
                observed = observe(directory, maximum)
                if directory == proof.root and not changed:
                    changed = True
                    self.child(lambda _: (self.client.close(), self.peer.close(), self.server.close()))
                return observed

            # Schedule an actual owned birth after the actual kernel PID list.
            # No kernel facts or successful proof replies are fabricated.
            proof.entries = observe_then_birth
            result = proof.socket_proof(self.ports)
            self.assertEqual(result["owner"]["pid"], os.getpid())
            self.assertGreaterEqual(proof.census_attempts, 3)
            self.assertEqual(proof.census_refusals[0]["reason"], "process_census_changed")

    def test_continuous_real_census_churn_refuses_without_partial_result(self):
        with module.Proof() as proof:
            observe = proof.entries

            def observe_then_birth(directory, maximum):
                observed = observe(directory, maximum)
                if directory == proof.root:
                    self.child(lambda _: (self.client.close(), self.peer.close(), self.server.close()))
                return observed

            proof.entries = observe_then_birth
            with self.assertRaises(module.Refusal) as refused:
                proof.socket_proof(self.ports)
            self.assertIn(refused.exception.reason, ("attempts_exhausted", "budget_exhausted"))
            self.assertTrue(proof.census_refusals)

    def test_private_thread_fd_table_cannot_hide_second_owner(self):
        self.admitted()

        def private_table(_):
            ready = threading.Event()
            result = []

            def worker():
                library = ctypes.CDLL(None, use_errno=True)
                result.append(library.unshare(0x400))  # CLONE_FILES only.
                ready.set()
                while True:
                    time.sleep(1)

            threading.Thread(target=worker, daemon=True).start()
            if not ready.wait(1) or result != [0]:
                os._exit(98)
            self.client.close()  # Thread retains it in its private table.

        pid = self.child(private_table)
        result, _ = self.run_proof()
        self.assertEqual(result.returncode, 1)
        self.assertIn('"reason":"multiple_owners"', result.stderr)
        self.reap(pid)
        self.admitted()

    @unittest.skipUnless(os.getuid() == 0, "Requires owned root producer with readable foreign FD tables")
    def test_readable_foreign_user_cannot_hide_shared_socket(self):
        self.admitted()

        def foreign(_):
            os.setgroups([])
            os.setresgid(65533, 65533, 65533)
            os.setresuid(65533, 65533, 65533)
            if ctypes.CDLL(None).prctl(4, 1, 0, 0, 0) != 0:
                os._exit(98)

        pid = self.child(foreign)
        result, _ = self.run_proof()
        self.assertEqual(result.returncode, 1)
        self.assertIn('"reason":"multiple_owners"', result.stderr)
        self.reap(pid)
        self.admitted()

    def test_unreadable_same_user_process_refuses_instead_of_guessing(self):
        self.admitted()

        def unobservable(_):
            self.client.close()
            if ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE.
                os._exit(98)

        pid = self.child(unobservable)
        result, _ = self.run_proof()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn('"errno":13', result.stderr)
        self.reap(pid)
        self.admitted()

    def test_unreaped_exit_does_not_hide_or_invent_an_owner(self):
        pid = os.fork()
        if pid == 0:
            os._exit(0)
        self.children.append(pid)
        handle = os.pidfd_open(pid)
        try:
            self.assertTrue(select.select([handle], [], [], 2)[0])
            self.admitted()
        finally:
            os.close(handle)
            os.waitpid(pid, 0)
            self.children.remove(pid)

    def test_birth_mode_is_fresh_and_dead_original_refuses(self):
        pid = self.child(lambda _: self.client.close())
        result, first = self.run_proof("--birth", str(pid))
        self.assertEqual(result.returncode, 0, result.stderr)
        result, second = self.run_proof("--birth", str(pid))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(first, second)
        self.reap(pid)
        result, _ = self.run_proof("--birth", str(pid))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")

    def test_wrong_endpoint_and_closed_connection_refuse(self):
        self.admitted()
        unused = socket.socket()
        try:
            unused.bind(("127.0.0.1", 0))
            result, _ = self.run_proof(self.ports[0], str(unused.getsockname()[1]))
            self.assertEqual(result.returncode, 1)
        finally:
            unused.close()
        self.client.close()
        result, _ = self.run_proof()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")

    def test_pinned_ancestry_refuses_real_parent_exit(self):
        self.client.close()
        self.peer.close()
        parent = subprocess.Popen([sys.executable, "-I", "-c", """
import json, os, socket, sys, time
pid=os.fork()
if pid==0:
    s=socket.socket();s.connect(('127.0.0.1',int(sys.argv[1])))
    print(json.dumps({'pid':os.getpid(),'port':s.getsockname()[1]}),flush=True)
    while True: time.sleep(1)
while True: time.sleep(1)
""", str(self.server.getsockname()[1])], stdout=subprocess.PIPE, text=True)
        child = None
        handle = None
        try:
            self.assertTrue(select.select([parent.stdout], [], [], 2)[0])
            child = json.loads(parent.stdout.readline())
            handle = os.pidfd_open(child["pid"])
            peer, _ = self.server.accept()
            try:
                ports = [str(child["port"]), str(self.server.getsockname()[1])]
                with module.Proof() as proof:
                    initial = proof.socket_proof(ports)
                    self.assertIn(parent.pid, [row["pid"] for row in initial["ancestors"]])
                    parent.kill()
                    parent.wait(timeout=2)
                    self.assertRaises(module.Refusal, proof.socket_proof, ports)
            finally:
                peer.close()
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=2)
            parent.stdout.close()
            if handle is not None:
                signal.pidfd_send_signal(handle, signal.SIGKILL)
                os.close(handle)

    def test_serial_transport_rechecks_and_invalid_frame_closes(self):
        helper = subprocess.Popen([str(HELPER), "--serve"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            for request in (1, 2):
                helper.stdin.write(f"{request} {' '.join(self.ports)} --diagnostics\n")
                helper.stdin.flush()
                response = json.loads(helper.stdout.readline())
                self.assertEqual(response["id"], request)
                self.assertTrue(response["ok"], response["stderr"])
            helper.stdin.write("2 --birth 2\n")  # A repeated ID is not replayed.
            helper.stdin.flush()
            self.assertEqual(helper.wait(timeout=2), 1)
            self.assertEqual(helper.stdout.read(), "")
            self.assertEqual(helper.stderr.read(), "")
        finally:
            if helper.poll() is None:
                helper.kill()
                helper.wait(timeout=2)
            helper.stdin.close()
            helper.stdout.close()
            helper.stderr.close()


if __name__ == "__main__":
    print(json.dumps({"platform": sys.platform, "machine": os.uname().machine,
                      "kernel": os.uname().release, "uid": os.getuid()}), flush=True)
    unittest.main(verbosity=2)
