"""Sampled CPU budget for a server's owned process group, never a duration kill.

Loaded only by the registered runner. No forks for observations, no argv in
diagnostics. Short bursts can exceed the budget between 100 ms samples. Reaped
child time is charged too; a child already sampled may be charged again when
its parent reaps it, conservatively slowing rapid fork/reap workloads.
"""
import ctypes
import json
import os
import signal
import sys
import tempfile
import time


class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "user", "system", "idle", "interrupt", "pageins", "wired", "resident",
        "footprint", "start", "exit", "child_user", "child_system", "child_idle",
        "child_interrupt", "child_pageins", "child_elapsed", "read", "write",
    )]


def cpu_reader():
    if sys.platform == "darwin":
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        library.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        library.proc_listpids.restype = ctypes.c_int
        library.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        library.proc_pid_rusage.restype = ctypes.c_int
        system = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        system.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                                  ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                                  ctypes.c_void_p, ctypes.c_size_t]
        system.sysctl.restype = ctypes.c_int
        class ProcStatus(ctypes.Structure):
            # SDK sys/proc.h: the stable 64-bit extern_proc prefix of kinfo_proc.
            _fields_ = [("start", ctypes.c_byte * 16), ("vmspace", ctypes.c_void_p),
                        ("sigacts", ctypes.c_void_p), ("flags", ctypes.c_int),
                        ("status", ctypes.c_byte), ("pid", ctypes.c_int)]
        def zombie(pid):
            if ctypes.sizeof(ctypes.c_void_p) != 8 or ProcStatus.status.offset != 36:
                return False
            # libproc excludes zombies, but kern.proc.pid includes them. Never
            # turn a failed query or a PID race into an exit/ownership proof.
            mib = (ctypes.c_int * 4)(1, 14, 1, pid)  # CTL_KERN/KERN_PROC/PID
            data = ctypes.create_string_buffer(4096)
            size = ctypes.c_size_t(ctypes.sizeof(data))
            if system.sysctl(mib, 4, data, ctypes.byref(size), None, 0) or size.value < ctypes.sizeof(ProcStatus):
                return False
            status = ProcStatus.from_buffer(data)
            return status.pid == pid and status.status == 5  # SZOMB
        class Timebase(ctypes.Structure):
            _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]
        timebase = Timebase()
        if ctypes.CDLL("/usr/lib/libSystem.B.dylib").mach_timebase_info(ctypes.byref(timebase)) or not timebase.denom:
            raise RuntimeError("Server CPU timebase unavailable")
        def members(pgid):
            pids = (ctypes.c_int * 16384)()
            size = library.proc_listpids(2, pgid, pids, ctypes.sizeof(pids))
            if size <= 0 or size >= ctypes.sizeof(pids) or size % 4:
                raise RuntimeError("Server process census unavailable")
            return [pid for pid in pids[:size // 4] if pid > 1]
        def cpu(pid):
            usage = Usage()
            if library.proc_pid_rusage(pid, 2, ctypes.byref(usage)):
                raise RuntimeError("Server CPU observation unavailable")
            return (usage.user + usage.system + usage.child_user + usage.child_system) * timebase.numer / timebase.denom / 1e9
        return members, cpu, zombie
    if sys.platform.startswith("linux"):
        ticks = os.sysconf("SC_CLK_TCK")
        def fields(pid):
            with open("/proc/" + str(pid) + "/stat") as file:
                raw = file.read(8192)
            return raw[raw.rfind(")") + 2:].split()
        def members(pgid):
            result = []
            for name in os.listdir("/proc"):
                if not name.isdigit():
                    continue
                try:
                    row = fields(int(name))
                    if int(row[2]) == pgid and row[0] != "Z":
                        result.append(int(name))
                except (FileNotFoundError, ProcessLookupError):
                    pass
            return result
        def cpu(pid):
            row = fields(pid)
            return sum(int(row[index]) for index in (11, 12, 13, 14)) / ticks
        return members, cpu, lambda _: False
    raise RuntimeError("Server CPU governance requires Darwin or Linux")


def wait(child, runner, cores, identity, born_since, signal_bound, reader, status_path):
    if not 0 < cores <= 64:
        raise RuntimeError("Invalid server CPU budget")
    members, cpu, zombie = reader
    previous = {}
    stopped = {}
    balance = 0.0
    at = time.monotonic()
    interrupted = False
    uncertain = False
    degraded_since = None
    next_warning = None
    handlers = {}
    def warning(message):
        try:
            print(message, file=sys.stderr, flush=True)
        except OSError:
            # A disconnected log pipe must not kill the registered supervisor.
            pass
    def resume():
        for key, proof in list(stopped.items()):
            if signal_bound(proof, runner["pgid"], signal.SIGCONT):
                stopped.pop(key, None)
    def resume_group():
        # The registered runner is itself the living group leader. Its group
        # cannot be reused while it lives. CONT restores progress even when a
        # stopped member's identity is temporarily unobservable; it grants no
        # kill or ownership authority over an individual unknown PID.
        if runner["pid"] == os.getpid() and runner["pgid"] == os.getpgrp():
            os.killpg(runner["pgid"], signal.SIGCONT)
            stopped.clear()
        else:
            resume()
    def observe(pid):
        try:
            return identity(pid)
        except RuntimeError:
            if zombie(pid):
                return None
            raise
    def record_degraded():
        directory = os.path.dirname(status_path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=directory)
        try:
            with os.fdopen(descriptor, "w") as file:
                json.dump({"pid": runner["pid"], "startTime": runner["startTime"],
                           "sinceMs": degraded_since}, file)
            os.replace(temporary, status_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    def clear_degraded():
        try:
            os.unlink(status_path)
        except FileNotFoundError:
            pass
    def interrupt(*_):
        nonlocal interrupted
        interrupted = True
        resume_group()
    for sig in (signal.SIGTERM, signal.SIGINT):
        handlers[sig] = signal.signal(sig, interrupt)
    try:
        while child.poll() is None:
            if interrupted:
                resume_group()
                # Give pending group termination a chance to run. A signal
                # sent only to the runner must not disable CPU governance of
                # a server that kept running.
                interrupted = False
                time.sleep(0.1)
                continue
            now = time.monotonic()
            elapsed = now - at
            balance = min(cores * 0.1, balance + elapsed * cores)
            at = now
            live = {}
            proofs = {}
            charge = 0.0
            try:
                for pid in members(runner["pgid"]):
                    if pid == runner["pid"]:
                        continue
                    before = observe(pid)
                    if before is None:
                        continue
                    if before["pgid"] != runner["pgid"] or born_since(before["startTime"], runner["startTime"]) is not True:
                        raise RuntimeError("Server member ownership unavailable")
                    try:
                        used = cpu(pid)
                    except (FileNotFoundError, ProcessLookupError, RuntimeError):
                        if observe(pid) is None:
                            continue
                        raise
                    after = observe(pid)
                    if after is None:
                        continue
                    if after != before:
                        raise RuntimeError("Server member lifetime changed")
                    key = (pid, before["startTime"])
                    charge += 0 if uncertain else max(0, used - previous.get(key, 0))
                    live[key] = used
                    proofs[key] = before
                # Census/identity reads race process exit. Commit one complete
                # sample, so a failed later read cannot charge an earlier
                # member again against its old baseline on the next retry.
                # A census omission is not proof of exit either: retain that
                # lifetime's baseline until the exact identity proves it gone.
                retired = []
                for key in previous:
                    if key not in live:
                        try:
                            current = observe(key[0])
                        except RuntimeError:
                            # Historical uncertainty retains its baseline;
                            # only current census members affect this sample.
                            continue
                        if current is None or current["startTime"] != key[1]:
                            retired.append(key)
                balance -= charge
                if uncertain:
                    clear_degraded()
                    degraded_since = next_warning = None
                previous.update(live)
                for key in retired:
                    previous.pop(key, None)
                    stopped.pop(key, None)
                if balance >= 0:
                    resume_group()
                else:
                    for key, proof in proofs.items():
                        if signal_bound(proof, runner["pgid"], signal.SIGSTOP):
                            stopped[key] = proof
                uncertain = False
            except Exception as error:
                newly_degraded = not uncertain
                if not uncertain:
                    degraded_since = int(time.time() * 1000)
                    next_warning = now + 60
                uncertain = True
                # Unknown CPU cannot be bounded by stopping observable siblings:
                # the parent may need them to recover observation. Keep the lease
                # held, restore progress, and re-baseline the first good sample
                # rather than repaying invented machine-wide or historical debt.
                balance = 0.0
                resume_group()
                if newly_degraded:
                    warning("Server CPU observation unavailable; CPU enforcement degraded, server resumed: " + str(error))
                    try:
                        record_degraded()
                    except OSError:
                        warning("WARNING: Server CPU limit not enforced; status could not be recorded")
                if now >= next_warning:
                    minutes = max(1, int((time.time() * 1000 - degraded_since) / 60_000))
                    warning("WARNING: Server CPU limit not enforced for " + str(minutes) +
                            (" minute" if minutes == 1 else " minutes") +
                            "; observation remains unavailable, server resumed and permit held")
                    next_warning = now + 300
            time.sleep(0.1)
        return child.returncode
    finally:
        resume_group()
        try:
            clear_degraded()
        except OSError:
            warning("WARNING: Server CPU status could not be cleared")
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
