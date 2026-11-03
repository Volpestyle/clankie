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
import struct
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

    def closed_child(self):
        return self.child(lambda _: (self.client.close(), self.peer.close(), self.server.close()))

    def after_listing(self, proof, action, *, every=False, before=None):
        """Run an actual owned process change right after a real /proc listing
        (the first, or every one); `before` runs ahead of listing N instead."""
        observe = proof.listing
        calls = []

        def listing():
            if before is not None and len(calls) == before:
                action(len(calls))
            observed = observe()
            if before is None and (every or not calls):
                action(len(calls))
            calls.append(None)
            return observed

        proof.listing = listing
        return calls

    def holder(self):
        """A child that keeps its inherited copy of the socket."""
        return self.child(lambda _: None)

    def reuse_pid(self, pid, start):
        """As root, fork an owned child that receives exactly this freed PID."""
        for _ in range(100):
            with open("/proc/sys/kernel/ns_last_pid", "w") as last:
                last.write(str(pid - 1))
            child = start()
            if child == pid:
                return child
            self.reap(child)
        self.fail("PID reuse lost every race to the machine")

    def test_births_are_read_without_restarting_the_census(self):
        # An actual owned birth after the first real PID list is one more
        # process to read (#440); before, every birth restarted the census.
        with module.Proof() as proof:
            calls = self.after_listing(proof, lambda _: self.closed_child())
            result = proof.socket_proof(self.ports)
            self.assertEqual(result["owner"]["pid"], os.getpid())
            self.assertGreaterEqual(len(calls), 2)
            self.assertEqual(proof.census_refusals, [])

    def test_continuous_real_census_churn_refuses_without_partial_result(self):
        # A birth after every listing never settles: refuse, never return a partial census.
        with module.Proof() as proof:
            self.after_listing(proof, lambda _: self.closed_child(), every=True)
            with self.assertRaises(module.Refusal) as refused:
                proof.socket_proof(self.ports)
            self.assertIn(refused.exception.reason, ("attempts_exhausted", "budget_exhausted"))

    def test_birth_that_takes_the_socket_mid_census_refuses(self):
        # A process forked after the first listing inherits the socket.
        with module.Proof() as proof:
            self.after_listing(proof, lambda _: self.holder())
            with self.assertRaises(module.Refusal) as refused:
                proof.socket_proof(self.ports)
            self.assertEqual(refused.exception.reason, "multiple_owners")

    def test_socket_passed_to_an_already_read_process_refuses_by_the_closing_census(self):
        # SCM_RIGHTS into a process the first census already read: the census
        # itself cannot see a later transfer, so the bracketing census must.
        ours, theirs = socket.socketpair()

        def receive(ready):
            ours.close()
            self.client.close(), self.peer.close(), self.server.close()
            os.write(ready, b"ready")
            # Keep the received descriptor open in this process's table.
            _, ancillary, _, _ = theirs.recvmsg(1, socket.CMSG_LEN(4))
            if len(ancillary) != 1:
                os._exit(97)
            while True:
                signal.pause()

        self.child(receive)
        theirs.close()
        try:
            with module.Proof() as proof:
                def send(index):
                    if index == 1:
                        ours.sendmsg([b"x"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                               struct.pack("i", self.client.fileno()))])
                        time.sleep(0.05)
                self.after_listing(proof, send, every=True)
                with self.assertRaises(module.Refusal) as refused:
                    proof.socket_proof(self.ports)
                self.assertEqual(refused.exception.reason, "multiple_owners")
        finally:
            ours.close()

    def record_reads(self, proof):
        """Each completed read: (PID, the instance inode it read)."""
        reads = []
        scan = proof.scan

        def recorded(pid, *rest):
            instance = scan(pid, *rest)
            reads.append((pid, instance))
            return instance

        proof.scan = recorded
        return reads

    @unittest.skipUnless(os.getuid() == 0, "PID reuse needs ns_last_pid, which only root may write")
    def test_reused_pid_of_a_read_process_is_read_again(self):
        # A PID the census already read, freed and reused by a socket holder
        # before the next listing. Before #440 an unchanged PID list hid the new
        # process from the census; now its new inode is read in the same attempt.
        old = self.closed_child()
        reused = []

        def replace(_):
            self.reap(old)
            reused.append(self.reuse_pid(old, self.holder))

        with module.Proof() as proof:
            reads = self.record_reads(proof)
            self.after_listing(proof, replace, before=1)
            with self.assertRaises(module.Refusal) as refused:
                proof.census(proof.tcp(*map(int, self.ports))[0])
            self.assertEqual(refused.exception.reason, "multiple_owners")
            self.assertEqual(reused, [old])
            self.assertEqual(proof.census_attempts, 1)
            instances = [instance for pid, instance in reads if pid == old]
            # The old instance's read completed; the reused PID's new inode was
            # read next, and that read raised multiple_owners, so it is not recorded.
            self.assertEqual(len(instances), 1)
            directory = os.open(f"/proc/{old}", os.O_RDONLY | os.O_DIRECTORY)
            try:
                self.assertNotEqual(os.fstat(directory).st_ino, instances[0])
            finally:
                os.close(directory)

    @unittest.skipIf(os.getuid() == 0, "Root reads non-dumpable tables, so nothing is unreadable")
    def test_unreadable_process_that_vanishes_mid_census_needs_a_confirmed_exit(self):
        # A same-user table the census could not read, gone from the next
        # listing: settling needs its exit confirmed, never mere absence.
        def unobservable(_):
            self.client.close(), self.peer.close(), self.server.close()
            if ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE.
                os._exit(98)

        pid = self.child(unobservable)
        with module.Proof() as proof:
            confirmations = []
            exited = proof.exited

            def recorded(target, *rest, **options):
                result = exited(target, *rest, **options)
                if target == pid and not rest:
                    confirmations.append(result)
                return result

            proof.exited = recorded
            self.after_listing(proof, lambda _: self.reap(pid), before=1)
            result = proof.socket_proof(self.ports)
            self.assertEqual(result["owner"]["pid"], os.getpid())
            # The denied read stayed unresolved until the kernel confirmed the exit.
            self.assertIn(True, confirmations)

    def test_owner_that_exits_and_is_replaced_is_never_admitted_as_itself(self):
        # The only owner hands its socket on and exits mid-census, and (as root)
        # the new holder takes the owner's very PID. The census restarts and
        # names the new holder; the original owner's fences then refuse.
        ours, theirs = socket.socketpair()
        go, command = os.pipe()

        def original(ready):
            os.close(command)
            ours.close()
            self.peer.close(), self.server.close()
            os.write(ready, b"ready")
            os.read(go, 1)
            theirs.sendmsg([b"x"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                     struct.pack("i", self.client.fileno()))])
            os._exit(0)

        def successor(target, _):
            self.peer.close(), self.server.close()
            if target is not None and os.getpid() != target:
                return  # Lost the PID race: leave the queued socket for the next try.
            _, ancillary, _, _ = ours.recvmsg(1, socket.CMSG_LEN(4))
            if len(ancillary) != 1:
                os._exit(97)

        owner = self.child(original)
        os.close(go)
        theirs.close()
        self.client.close()
        try:
            result, before = self.run_proof()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(before["owner"]["pid"], owner)
            fences = [str(owner), *before["owner"]["birth"], before["owner"]["socket"],
                      before["owner"]["kernelIdentity"]]
            replaced = []

            def replace(_):
                os.write(command, b"x")
                os.waitpid(owner, 0)
                self.children.remove(owner)
                if os.getuid() == 0:
                    replaced.append(self.reuse_pid(owner, lambda: self.child(
                        lambda ready: successor(owner, ready))))
                else:
                    replaced.append(self.child(lambda ready: successor(None, ready)))

            with module.Proof() as proof:
                # After the census read the owner, before its next listing.
                self.after_listing(proof, replace, before=1)
                with self.assertRaises(module.Refusal) as refused:
                    proof.socket_proof([*self.ports, *fences])
                self.assertEqual(refused.exception.stage, "owner_pin")
                self.assertEqual(proof.census_refusals[0]["reason"], "process_census_changed")
            result, after = self.run_proof()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(after["owner"]["pid"], replaced[0])
            self.assertNotEqual(after["owner"]["kernelIdentity"], before["owner"]["kernelIdentity"])
            if os.getuid() == 0:
                self.assertEqual(replaced, [owner])
        finally:
            ours.close()
            os.close(command)

    def test_exit_churn_skips_confirmed_exits_instead_of_restarting(self):
        # Processes that never held the socket each exit while the census is
        # reading them, after the first PID list (#440). Before #440 every exit
        # restarted the whole census.
        exiting = {self.closed_child() for _ in range(12)}
        with module.Proof() as proof:
            observe = proof.identity

            def identity_then_exit(directory, pid):
                observed = observe(directory, pid)
                if pid in exiting:
                    exiting.remove(pid)
                    self.reap(pid)
                return observed

            proof.identity = identity_then_exit
            result = proof.socket_proof(self.ports)
            self.assertEqual(result["owner"]["pid"], os.getpid())
            self.assertFalse(exiting)
            # Twelve exits, yet at most one restart, left for an unrelated birth on the machine.
            self.assertLessEqual(len(proof.census_refusals), 1, proof.census_refusals)

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

    @unittest.skipIf(os.getuid() == 0, "Root reads non-dumpable tables, so nothing is unreadable")
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
