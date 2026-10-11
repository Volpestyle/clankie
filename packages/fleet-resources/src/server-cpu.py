"""Sampled CPU budget for a server's owned process group, never a duration kill.

Loaded only by the registered runner. No forks for observations, no argv in
diagnostics. Short bursts can exceed the budget between 100 ms samples. Reaped
child time is charged too; a child already sampled may be charged again when
its parent reaps it, conservatively slowing rapid fork/reap workloads.
"""
import ctypes
import os
import signal
import sys
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
        return members, cpu
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
        return members, cpu
    raise RuntimeError("Server CPU governance requires Darwin or Linux")


def wait(child, runner, cores, identity, born_since, signal_bound, reader):
    if not 0 < cores <= 64:
        raise RuntimeError("Invalid server CPU budget")
    members, cpu = reader
    previous = {}
    stopped = {}
    balance = 0.0
    maximum_cores = max(cores, os.cpu_count() or 1)
    at = time.monotonic()
    interrupted = False
    uncertain = False
    handlers = {}
    def resume():
        for key, proof in list(stopped.items()):
            if signal_bound(proof, runner["pgid"], signal.SIGCONT):
                stopped.pop(key, None)
    def interrupt(*_):
        nonlocal interrupted
        interrupted = True
        resume()
    for sig in (signal.SIGTERM, signal.SIGINT):
        handlers[sig] = signal.signal(sig, interrupt)
    try:
        while child.poll() is None:
            if interrupted:
                resume()
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
                    before = identity(pid)
                    if before is None:
                        continue
                    if before["pgid"] != runner["pgid"] or born_since(before["startTime"], runner["startTime"]) is not True:
                        raise RuntimeError("Server member ownership unavailable")
                    try:
                        used = cpu(pid)
                    except (FileNotFoundError, ProcessLookupError, RuntimeError):
                        if identity(pid) is None:
                            continue
                        raise
                    after = identity(pid)
                    if after is None:
                        continue
                    if after != before:
                        raise RuntimeError("Server member lifetime changed")
                    key = (pid, before["startTime"])
                    charge += max(0, used - previous.get(key, 0))
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
                            current = identity(key[0])
                        except RuntimeError:
                            # Historical uncertainty retains its baseline;
                            # only current census members affect this sample.
                            continue
                        if current is None or current["startTime"] != key[1]:
                            retired.append(key)
                balance -= charge
                previous.update(live)
                for key in retired:
                    previous.pop(key, None)
                    stopped.pop(key, None)
                if balance >= 0:
                    resume()
                else:
                    for key, proof in proofs.items():
                        if signal_bound(proof, runner["pgid"], signal.SIGSTOP):
                            stopped[key] = proof
                uncertain = False
            except Exception as error:
                if not uncertain:
                    print("Server CPU observation unavailable: " + str(error), file=sys.stderr, flush=True)
                    balance -= maximum_cores * elapsed
                uncertain = True
                # An unreaped Darwin zombie can be unobservable. Keeping its
                # parent stopped forever prevents the very reap that restores
                # observation. Budget a short resume window at the maximum
                # possible machine CPU rate, then pause proved members while
                # repaying that debt. Unknown CPU is never treated as zero.
                if balance >= 0:
                    balance -= maximum_cores * 0.1
                    resume()
                else:
                    for key in previous.keys() | proofs.keys():
                        proof = {"pid": key[0], "startTime": key[1]}
                        if signal_bound(proof, runner["pgid"], signal.SIGSTOP):
                            stopped[key] = proof
            time.sleep(0.1)
        return child.returncode
    finally:
        resume()
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
