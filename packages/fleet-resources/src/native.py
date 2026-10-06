"""Fleet resource OS facts, advisory locking and registered heavy command runner.

Only process identities and safe lease metadata reach disk. Command argv travels
over inherited private pipes, and is never included in errors or the journal.
"""
import ctypes
import fcntl
import json
import os
import signal
import subprocess
import sys
import time


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid",
        "ruid", "rgid", "svuid", "svgid", "reserved",
    )] + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tty", "tpgid")
    ] + [("nice", ctypes.c_int32), ("seconds", ctypes.c_uint64), ("microseconds", ctypes.c_uint64)]


def identity(pid, census=False):
    if pid <= 1:
        return None
    try:
        if sys.platform == "darwin":
            if ctypes.sizeof(ProcBsdInfo) != 136 or ProcBsdInfo.seconds.offset != 120:
                raise RuntimeError("Unsupported process ABI")
            library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
            library.proc_pidinfo.restype = ctypes.c_int
            info = ProcBsdInfo()
            if library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), 136) != 136:
                # A denied or incomplete observation is not an exit receipt.
                # The kernel must independently prove that this PID is absent.
                os.kill(pid, 0)
                raise RuntimeError("Process identity unavailable")
            if info.uid != os.getuid() or info.ruid != os.getuid():
                if census:
                    return None
                raise RuntimeError("Process ownership unavailable")
            if info.status == 5:
                return None
            birth = str(info.seconds) + "." + str(info.microseconds).zfill(6)
            legacy = time.strftime("%a %b %e %H:%M:%S %Y", time.localtime(info.seconds))
            return {"pid": pid, "startTime": birth, "legacyStartTime": legacy,
                    "pgid": info.pgid, "ppid": info.ppid, "uid": info.uid}
        if sys.platform.startswith("linux"):
            path = "/proc/" + str(pid)
            if os.stat(path).st_uid != os.getuid():
                if census:
                    return None
                raise RuntimeError("Process ownership unavailable")
            with open(path + "/stat") as file:
                raw = file.read(8192)
            fields = raw[raw.rfind(")") + 2:].split()
            if fields[0] == "Z":
                return None
            with open("/proc/sys/kernel/random/boot_id") as file:
                boot = file.read(80).strip()
            return {"pid": pid, "startTime": boot + ":" + fields[19],
                    "pgid": int(fields[2]), "ppid": int(fields[1]), "uid": os.getuid()}
        raise RuntimeError("Unsupported platform")
    except ProcessLookupError:
        return None
    except FileNotFoundError:
        # A missing global probe dependency (for example boot_id) must not
        # make a still-live recorded process appear to have exited.
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return None
        raise RuntimeError("Process identity unavailable")


def snapshot():
    if sys.platform == "darwin":
        rows = subprocess.run(["/bin/ps", "-axo", "pid=,uid="], capture_output=True, timeout=2, check=True)
        if len(rows.stdout) > 1024 * 1024:
            raise RuntimeError("Process snapshot too large")
        census = [tuple(int(value) for value in row.split()) for row in rows.stdout.splitlines()]
        if len(census) > 10000 or any(len(row) != 2 for row in census):
            raise RuntimeError("Process snapshot unavailable")
        pids = [pid for pid, uid in census if uid == os.getuid()]
    elif sys.platform.startswith("linux"):
        pids = []
        census = os.listdir("/proc")
        if sum(row.isdigit() for row in census) > 10000:
            raise RuntimeError("Process snapshot too large")
        for row in census:
            if not row.isdigit():
                continue
            try:
                if os.stat("/proc/" + row).st_uid == os.getuid():
                    pids.append(int(row))
            except FileNotFoundError:
                # Census enumeration may race an unrelated process's exit.
                continue
    else:
        raise RuntimeError("Unsupported platform")
    if len(pids) > 10000:
        raise RuntimeError("Process snapshot too large")
    # A proved different UID is irrelevant to this user's census. Exact recorded
    # PID probes above still reject ownership uncertainty instead of proving exit.
    return [value for value in (identity(pid, census=True) for pid in pids) if value is not None]


def observe_processes():
    raw = sys.stdin.read(16385)
    if len(raw) > 16384:
        raise RuntimeError("Process identity request too large")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {"pids"}:
        raise RuntimeError("Process identity request unavailable")
    pids = request["pids"]
    if not isinstance(pids, list) or len(pids) > 640 or any(
        type(pid) is not int or pid < 2 or pid > 2147483647 for pid in pids
    ) or len(set(pids)) != len(pids):
        raise RuntimeError("Process identity request unavailable")
    observations = []
    for pid in pids:
        try:
            current = identity(pid)
            row = {"pid": pid, "status": "live" if current is not None else "exited"}
            if current is not None:
                row["identity"] = current
        except Exception:
            # One denied native read cannot supply absence evidence or poison
            # independent exact observations of other journal processes.
            row = {"pid": pid, "status": "unknown"}
        observations.append(row)
    return {"schemaVersion": 1, "observations": observations}


def group_occupied(pgid):
    """Count occupancy only, across all UIDs; this is never signal authority."""
    observer = subprocess.Popen(["/bin/ps", "-axo", "pid=,pgid=,stat="], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        output, _ = observer.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        observer.kill()
        observer.communicate()
        raise RuntimeError("Process group snapshot unavailable")
    if observer.returncode != 0:
        raise RuntimeError("Process group snapshot unavailable")
    if len(output) > 1024 * 1024:
        raise RuntimeError("Process group snapshot too large")
    census = [row.split() for row in output.splitlines()]
    if len(census) > 10000 or any(len(row) != 3 for row in census):
        raise RuntimeError("Process group snapshot unavailable")
    # The observer is born inside the runner's group and appears in its own
    # census. Its exact receipt is not a surviving command member.
    return any(int(pid) not in (pgid, observer.pid) and int(group) == pgid and not status.startswith(b"Z")
               for pid, group, status in census)


def lock(directory):
    os.makedirs(directory, mode=0o700, exist_ok=True)
    file = open(os.path.join(directory, "state.lock"), "a+")
    os.chmod(file.name, 0o600)
    fcntl.flock(file, fcntl.LOCK_EX)
    return file


def read_state(directory):
    try:
        with open(os.path.join(directory, "state.json")) as file:
            raw = file.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise RuntimeError("Resource journal too large")
        return json.loads(raw)
    except FileNotFoundError:
        return None


def write_state(directory, state):
    import tempfile
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump(state, file, separators=(",", ":"))
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, os.path.join(directory, "state.json"))
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def locked_pipe(directory):
    with lock(directory):
        print(json.dumps(read_state(directory)), flush=True)
        line = sys.stdin.readline(1024 * 1024 + 1)
        if line:
            request = json.loads(line)
            if "write" in request:
                write_state(directory, request["write"])
        print("done", flush=True)


def heavy_runner(directory, lease_id, token):
    control = os.fdopen(3, "r")
    replies = os.fdopen(4, "w")
    request = json.loads(control.readline(1024 * 1024))
    mine = identity(os.getpid())
    if mine is None or mine["pgid"] != os.getpid():
        raise RuntimeError("Heavy runner group unavailable")
    with lock(directory):
        state = read_state(directory)
        lease = next((row for row in state["leases"] if row["id"] == lease_id and row["token"] == token), None)
        if lease is None or lease["kind"] != "heavy" or lease["state"] != "starting":
            raise RuntimeError("Heavy admission unavailable")
        owner = identity(lease["claimOwner"]["pid"])
        if owner is None or owner["startTime"] != lease["claimOwner"]["startTime"]:
            raise RuntimeError("Heavy claim owner exited")
        lease["state"] = "running"
        lease["runner"] = mine
        write_state(directory, state)
    replies.write(json.dumps(mine) + "\n")
    replies.flush()
    child = None
    try:
        if control.readline(64).strip() != "go":
            return 130
        # The runner survives a terminated wrapper, keeping its group lease.
        # Group signals reach the real command; the runner waits for survivors.
        signal.signal(signal.SIGINT, lambda *_: None)
        signal.signal(signal.SIGTERM, lambda *_: None)
        environment = os.environ.copy()
        environment["CLANKIE_RESOURCE_LEASE"] = json.dumps({"id": lease_id, "token": token})
        child = subprocess.Popen([request["command"], *request["args"]], env=environment)
        code = child.wait()
        while group_occupied(mine["pgid"]):
            time.sleep(0.5)
        return code if code >= 0 else 128 - code
    finally:
        # No command is submitted twice. Cleanup only follows no launch or a
        # terminal command with no living members of the owned group.
        if child is None or not group_occupied(mine["pgid"]):
            with lock(directory):
                state = read_state(directory)
                state["leases"] = [row for row in state["leases"] if not (row["id"] == lease_id and row["token"] == token)]
                write_state(directory, state)


if __name__ == "__main__":
    try:
        mode = sys.argv[1]
        if mode == "identity":
            print(json.dumps(identity(int(sys.argv[2]))))
        elif mode == "available":
            if len(sys.argv) != 2 or identity(os.getpid()) is None:
                raise RuntimeError("Native observer unavailable")
            print("true")
        elif mode == "snapshot":
            print(json.dumps(snapshot()))
        elif mode == "observe":
            if len(sys.argv) != 2:
                raise RuntimeError("Process identity request unavailable")
            print(json.dumps(observe_processes(), separators=(",", ":")))
        elif mode == "lock":
            locked_pipe(sys.argv[2])
        elif mode == "run":
            sys.exit(heavy_runner(sys.argv[2], sys.argv[3], sys.argv[4]))
        else:
            raise RuntimeError("Unknown native operation")
    except Exception:
        print("Fleet resource native boundary unavailable", file=sys.stderr)
        sys.exit(1)
