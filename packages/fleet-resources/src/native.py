"""Fleet resource OS facts, advisory locking and registered heavy command runner.

Only process identities and safe lease metadata reach disk. Command argv travels
over inherited private pipes, and is never included in errors or the journal.
"""
import ctypes
import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import time

# One single-threaded helper owns every descriptor. A bounded operation name
# identifies native failures without exposing paths, journal data or argv.
lock_stage = "startup"


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


def darwin_memory():
    """The compressor-aware free percentage reported by memory_pressure -Q."""
    if sys.platform != "darwin":
        raise RuntimeError("Darwin memory observation unavailable")
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    library.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                                    ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
    library.sysctlbyname.restype = ctypes.c_int
    percent = ctypes.c_uint32()
    total = ctypes.c_uint64()
    for name, value in ((b"kern.memorystatus_level", percent), (b"hw.memsize", total)):
        size = ctypes.c_size_t(ctypes.sizeof(value))
        if library.sysctlbyname(name, ctypes.byref(value), ctypes.byref(size), None, 0) != 0 or \
                size.value != ctypes.sizeof(value):
            raise RuntimeError("Darwin memory observation unavailable")
    if percent.value > 100 or total.value == 0:
        raise RuntimeError("Darwin memory observation invalid")
    # Stable HOST_VM_INFO64 rev1 prefix (SDK mach/vm_statistics.h). Reclaiming
    # anonymous/compressed pages needs more compression or swap; do not advertise
    # all of those pages as immediate headroom for another simulator boot.
    class VmStatistics(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint32) for name in ("free", "active", "inactive", "wired")] + [
            (name, ctypes.c_uint64) for name in ("zero", "reactivations", "pageins", "pageouts",
                "faults", "cow", "lookups", "hits", "purges")
        ] + [(name, ctypes.c_uint32) for name in ("purgeable", "speculative")] + [
            (name, ctypes.c_uint64) for name in ("decompressions", "compressions", "swapins", "swapouts")
        ] + [(name, ctypes.c_uint32) for name in ("compressor", "throttled", "external", "internal")] + [
            ("uncompressed", ctypes.c_uint64)]
    if ctypes.sizeof(VmStatistics) != 152 or VmStatistics.external.offset != 136:
        raise RuntimeError("Unsupported memory ABI")
    library.mach_host_self.restype = ctypes.c_uint32
    library.host_statistics64.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_void_p,
                                         ctypes.POINTER(ctypes.c_uint32)]
    info = VmStatistics()
    count = ctypes.c_uint32(38)
    host = library.mach_host_self()
    try:
        if library.host_statistics64(host, 4, ctypes.byref(info), ctypes.byref(count)) != 0 or count.value != 38:
            raise RuntimeError("Darwin page observation unavailable")
    finally:
        library.mach_task_self.restype = ctypes.c_uint32
        library.mach_port_deallocate(library.mach_task_self(), host)
    # Speculative pages are included in free_count and can also be file-backed.
    reclaimable_bytes = (max(0, info.free - info.speculative) + info.external) * os.sysconf("SC_PAGE_SIZE")
    available_bytes = min(total.value * percent.value // 100, reclaimable_bytes)
    return {"schemaVersion": 1, "availablePercent": percent.value, "totalMemoryBytes": total.value,
            "availableMemoryBytes": available_bytes}


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



def ancestry():
    """Fresh all-UID topology only; never birth, absence or signal authority."""
    rows = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,uid="], capture_output=True, timeout=2, check=True)
    if len(rows.stdout) > 1024 * 1024:
        raise RuntimeError("Process ancestry too large")
    census = [tuple(int(value) for value in row.split()) for row in rows.stdout.splitlines()]
    if len(census) > 10000 or any(len(row) != 3 for row in census):
        raise RuntimeError("Process ancestry unavailable")
    # Darwin ps prints nobody's uid_t 4294967294 as signed -2. Preserve
    # its exact unsigned identity; TypeScript still validates the bounded row.
    return [{"pid": pid, "ppid": ppid, "uid": uid + 2**32 if uid < 0 else uid}
            for pid, ppid, uid in census]


def observe_processes():
    raw = sys.stdin.read(16385)
    if len(raw) > 16384:
        raise RuntimeError("Process identity request too large")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {"pids"}:
        raise RuntimeError("Process identity request unavailable")
    return observe_pids(request["pids"])


def observe_pids(pids):
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


def simulator_referents():
    """This user's processes whose arguments name a simulator, with their ancestry.

    Needles (device UDIDs or names) arrive on stdin. Arguments are matched here
    and never returned: replies carry only PIDs, parent PIDs and executable
    basenames, so callers can map a holder to the pane that started it.
    """
    raw = sys.stdin.read(65537)
    if len(raw) > 65536:
        raise RuntimeError("Simulator referent request too large")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {"needles"}:
        raise RuntimeError("Simulator referent request unavailable")
    needles = request["needles"]
    if not isinstance(needles, list) or len(needles) > 256 or any(
        not isinstance(needle, str) or not 4 <= len(needle) <= 256 or "\0" in needle for needle in needles
    ):
        raise RuntimeError("Simulator referent request unavailable")
    if sys.platform != "darwin":
        return {"schemaVersion": 1, "processes": [], "matches": {}}

    def census(columns):
        rows = subprocess.run(["/bin/ps", "-axww", "-o", columns], capture_output=True, timeout=3, check=True)
        if len(rows.stdout) > 16 * 1024 * 1024:
            raise RuntimeError("Process snapshot too large")
        lines = rows.stdout.decode("utf-8", "replace").splitlines()
        if len(lines) > 20000:
            raise RuntimeError("Process snapshot too large")
        return lines

    table = {}
    for line in census("pid=,ppid=,uid=,comm="):
        fields = line.split(None, 3)
        if len(fields) < 3:
            continue
        executable = os.path.basename(fields[3].strip()) if len(fields) == 4 else ""
        table[int(fields[0])] = {"ppid": int(fields[1]), "uid": int(fields[2]),
                                 "executable": (executable or "unknown")[:64]}
    own = {os.getpid(), os.getppid()}
    matches = {needle: [] for needle in needles}
    for line in census("pid=,args="):
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        pid = int(fields[0])
        row = table.get(pid)
        if pid in own or row is None or row["uid"] != os.getuid() or row["executable"] == "ps":
            continue
        for needle in needles:
            if needle in fields[1] and len(matches[needle]) < 32:
                matches[needle].append(pid)
    processes = {}
    for pids in matches.values():
        for pid in pids:
            current, depth = pid, 0
            while current > 1 and current in table and current not in processes and depth < 64:
                processes[current] = {"pid": current, "ppid": table[current]["ppid"],
                                      "executable": table[current]["executable"]}
                current, depth = table[current]["ppid"], depth + 1
    return {"schemaVersion": 1, "processes": list(processes.values()),
            "matches": {needle: pids for needle, pids in matches.items() if pids}}



class ProcUsage(ctypes.Structure):
    # SDK sys/resource.h rusage_info_v0, CPU times are Mach absolute ticks.
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "user", "system", "idle_wakeups", "interrupt_wakeups", "pageins", "wired",
        "resident", "footprint", "start", "exit",
    )]


def simulator_usage():
    """Read-only per-device kernel charges. Never exports argv or grants authority."""
    if sys.platform != "darwin":
        raise RuntimeError("Simulator usage requires Darwin")
    if ctypes.sizeof(ProcUsage) != 96 or ProcUsage.footprint.offset != 72:
        raise RuntimeError("Unsupported usage ABI")
    import re
    raw = subprocess.run(["/bin/ps", "-axww", "-o", "pid=,ppid=,uid=,rss=,comm="],
                         capture_output=True, timeout=2, check=True).stdout
    if len(raw) > 4 * 1024 * 1024:
        raise RuntimeError("Process snapshot too large")
    table = {}
    for line in raw.decode("utf-8", "replace").splitlines():
        fields = line.split(None, 4)
        if len(fields) != 5:
            raise RuntimeError("Process snapshot unavailable")
        pid, ppid, uid, rss = map(int, fields[:4])
        table[pid] = {"pid": pid, "ppid": ppid, "uid": uid,
                      "rssBytes": rss * 1024, "executable": os.path.basename(fields[4])[:128]}
    if len(table) > 10000:
        raise RuntimeError("Process snapshot too large")
    roots = {pid for pid, row in table.items()
             if row["uid"] == os.getuid() and row["executable"] == "launchd_sim"}
    devices = {}
    if roots:
        args = subprocess.run(["/bin/ps", "-ww", "-p", ",".join(map(str, roots)), "-o", "pid=,args="],
                              capture_output=True, timeout=2, check=True).stdout
        if len(args) > 1024 * 1024:
            raise RuntimeError("Simulator roots unavailable")
        for line in args.decode("utf-8", "replace").splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) != 2:
                continue
            match = re.search(r"/CoreSimulator/Devices/([A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12})/data/var/run/launchd_bootstrap\.plist(?:$|\s)", fields[1])
            pid = int(fields[0])
            if pid in roots and match:
                device = match.group(1).upper()
                if device in devices:
                    raise RuntimeError("Ambiguous simulator root")
                devices[device] = pid
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    library.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    library.proc_pid_rusage.restype = ctypes.c_int
    class Timebase(ctypes.Structure):
        _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]
    timebase = Timebase()
    system = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    if system.mach_timebase_info(ctypes.byref(timebase)) != 0 or not timebase.denom:
        raise RuntimeError("CPU timebase unavailable")
    result = []
    for device, root in devices.items():
        root_identity = identity(root)
        if root_identity is None:
            continue
        members = {root}
        for _ in range(64):
            expanded = members | {pid for pid, row in table.items() if row["ppid"] in members}
            if expanded == members:
                break
            members = expanded
        processes, unavailable = [], 0
        for pid in sorted(members):
            row = table[pid]
            try:
                before = identity(pid)
                usage = ProcUsage()
                if before is None:
                    continue
                if before["ppid"] != row["ppid"]:
                    raise RuntimeError("Process ancestry changed during observation")
                if library.proc_pid_rusage(pid, 0, ctypes.byref(usage)) != 0:
                    raise RuntimeError("Process usage unavailable")
                after = identity(pid)
                if after is None or before["startTime"] != after["startTime"]:
                    raise RuntimeError("Process changed during usage observation")
                processes.append({"pid": pid, "startTime": before["startTime"],
                                  "executable": row["executable"], "rssBytes": usage.resident,
                                  "footprintBytes": usage.footprint,
                                  "cpuTimeMs": (usage.user + usage.system) * timebase.numer / timebase.denom / 1000000})
            except Exception:
                unavailable += 1
        if identity(root) != root_identity:
            raise RuntimeError("Simulator root changed during observation")
        result.append({"deviceId": device, "rootPid": root, "processes": processes,
                       "unavailableProcesses": unavailable})
    return {"schemaVersion": 1, "sampledAtMs": int(time.time() * 1000), "devices": result}


# A command's leftovers get this long to exit on their own once it has exited (VUH-2027).
LEFTOVER_GRACE_SECONDS = 10
LEFTOVER_TERM_SECONDS = 5


def group_members(pgid):
    """Live members of one process group with executable names only, never arguments."""
    observer = subprocess.Popen(["/bin/ps", "-axo", "pid=,pgid=,stat=,comm="], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        output, _ = observer.communicate(timeout=2)
    except subprocess.TimeoutExpired:
        observer.kill()
        observer.communicate()
        raise RuntimeError("Process group snapshot unavailable")
    if observer.returncode != 0 or len(output) > 4 * 1024 * 1024:
        raise RuntimeError("Process group snapshot unavailable")
    members = []
    for row in output.splitlines():
        fields = row.split(None, 3)
        if len(fields) < 3:
            raise RuntimeError("Process group snapshot unavailable")
        pid, group, status = int(fields[0]), int(fields[1]), fields[2]
        # The observer is born inside the caller's group; it is not a member.
        if group != pgid or pid == observer.pid or status.startswith(b"Z"):
            continue
        name = os.path.basename(os.fsdecode(fields[3])) if len(fields) == 4 else ""
        members.append({"pid": pid, "name": name[:128]})
    return members


def born_since(start, runner_start):
    """Whether a member started no earlier than the lease's runner; None when unprovable."""
    try:
        if ":" in start or ":" in runner_start:
            boot, ticks = start.split(":")
            runner_boot, runner_ticks = runner_start.split(":")
            return boot == runner_boot and int(ticks) >= int(runner_ticks)
        return float(start) >= float(runner_start)
    except (ValueError, AttributeError):
        return None


def bound_members(pgid, runner, keep):
    """Group members proven to be this lease's: same user, still in its group, born since its runner.

    Group IDs cannot be reused while a member lives, but a PID can be after it exits, so every
    member is bound by its own birth; anything unprovable is unknown and stays held."""
    proven, unknown = [], []
    for member in group_members(pgid):
        if member["pid"] in (keep, os.getpid()):
            continue
        try:
            proof = identity(member["pid"])
        except RuntimeError:
            unknown.append(member)
            continue
        if proof is None:
            continue
        if proof["pgid"] != pgid or born_since(proof["startTime"], runner["startTime"]) is not True:
            unknown.append(member)
            continue
        proven.append({**member, "startTime": proof["startTime"]})
    return proven, unknown


def still_bound(member, pgid):
    try:
        proof = identity(member["pid"])
    except RuntimeError:
        return None
    return proof is not None and proof["startTime"] == member["startTime"] and proof["pgid"] == pgid


def signal_bound(member, pgid, sig):
    """Signal one exact process lifetime, re-proven immediately before; never a group sweep."""
    if still_bound(member, pgid) is not True:
        return False
    try:
        os.kill(member["pid"], sig)
        return True
    except ProcessLookupError:
        return False


def stop_leftovers(directory, lease, pgid, keep):
    """TERM, then KILL, a lease's proven leftovers after its command exited, and record each outcome.

    `lease["runner"]` is the runner identity that owns `pgid`; `keep` is the live runner itself."""
    runner = lease.get("runner")
    if not runner or runner.get("pgid") != pgid or not runner.get("startTime"):
        raise RuntimeError("Leftover owner unavailable")
    proven, unknown = bound_members(pgid, runner, keep)
    outcomes = {member["pid"]: "exited" for member in proven}
    for member in proven:
        if not signal_bound(member, pgid, signal.SIGTERM):
            outcomes[member["pid"]] = "exited"
    deadline = time.time() + LEFTOVER_TERM_SECONDS
    alive = proven
    while alive and time.time() < deadline:
        time.sleep(0.2)
        alive = [member for member in alive if still_bound(member, pgid) is not False]
    for member in alive:
        outcomes[member["pid"]] = "killed" if signal_bound(member, pgid, signal.SIGKILL) else "unknown"
    deadline = time.time() + 2
    while alive and time.time() < deadline:
        time.sleep(0.1)
        alive = [member for member in alive if still_bound(member, pgid) is not False]
    for member in alive:
        outcomes[member["pid"]] = "survived"
    stopped = [{"pid": member["pid"], "name": member["name"], "startTime": member["startTime"],
                "signal": "KILL" if outcomes[member["pid"]] in ("killed", "survived") else "TERM",
                "outcome": outcomes[member["pid"]]} for member in proven]
    held = [{"pid": member["pid"], "name": member["name"], "outcome": "unknown_held"} for member in unknown]
    if stopped or held:
        record_leftovers(directory, lease, pgid, stopped + held)
    return stopped + held


def leftover_marker(directory, lease_id):
    if not lease_id or "/" in lease_id or lease_id.startswith("."):
        raise RuntimeError("Leftover marker unavailable")
    return os.path.join(directory, "leftovers", lease_id + ".json")


def mark_leftovers(directory, lease_id, exited_at):
    """Beside the journal, not in it: older strict journal readers must keep parsing it."""
    path = leftover_marker(directory, lease_id)
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w") as file:
        json.dump({"commandExitedAtMs": exited_at}, file)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def record_leftovers(directory, lease, pgid, members):
    """Append what was stopped or held; names and start times only, never arguments or tokens."""
    entry = {
        "atMs": int(time.time() * 1000),
        "leaseId": lease["id"],
        "executable": lease.get("executable"),
        "pgid": pgid,
        "runnerPid": lease["runner"]["pid"],
        "members": members[:64],
        "memberCount": len(members),
    }
    for key in ("seatId", "holderId", "commandExitedAtMs"):
        if lease.get(key) is not None:
            entry[key] = lease[key]
    path = os.path.join(directory, "leftovers.jsonl")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, (json.dumps(entry, separators=(",", ":")) + "\n").encode())
    finally:
        os.close(fd)


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


def operator_seats():
    """Discovery only: live local launcher lifetimes, never argv or environment.

    A second census detects a changing launch set. Unknown command lines hold
    enforcement; this is never permission to signal or adopt a process.
    """
    def executable(pid):
        if sys.platform.startswith("linux"):
            return os.readlink("/proc/%s/exe" % pid)
        if sys.platform == "darwin":
            library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
            library.proc_pidpath.restype = ctypes.c_int
            path = ctypes.create_string_buffer(4096)
            if library.proc_pidpath(pid, path, len(path)) <= 0:
                raise RuntimeError("Operator executable unavailable")
            return path.value.decode("utf-8", "strict")
        raise RuntimeError("Unsupported operator census platform")

    def arguments(pid):
        # ps renders a lossy space-joined command line. It cannot distinguish
        # an entry point from a quoted argument, or enumerate paths with spaces.
        if sys.platform.startswith("linux"):
            with open("/proc/%s/cmdline" % pid, "rb") as file:
                raw = file.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise RuntimeError("Operator arguments too large")
            return os.readlink("/proc/%s/exe" % pid).removesuffix(" (deleted)"), [word.decode("utf-8", "strict") for word in raw.rstrip(b"\0").split(b"\0")]
        if sys.platform == "darwin":
            library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            library.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
                                       ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
            library.sysctl.restype = ctypes.c_int
            mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
            size = ctypes.c_size_t(1024 * 1024)
            buffer = ctypes.create_string_buffer(size.value)
            if library.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
                raise RuntimeError("Operator arguments unavailable")
            raw = buffer.raw[:size.value]
            count = ctypes.c_int.from_buffer_copy(raw[:4]).value
            if not 1 <= count <= 4096:
                raise RuntimeError("Operator argument count unavailable")
            end = raw.index(b"\0", 4)
            image = raw[4:end].decode("utf-8", "strict")
            if not os.path.isabs(image):
                raise RuntimeError("Operator executable arguments unavailable")
            start = end + 1
            while start < len(raw) and raw[start] == 0:
                start += 1
            words = raw[start:].split(b"\0")
            if len(words) < count:
                raise RuntimeError("Operator arguments incomplete")
            return image, [word.decode("utf-8", "strict") for word in words[:count]]
        raise RuntimeError("Unsupported operator census platform")

    def census():
        selection = ["-axww"]
        if os.environ.get("NODE_ENV") == "test" and os.environ.get("CLANKIE_SCRATCH") == "1":
            path = os.path.realpath(os.environ["CLANKIE_TEST_OPERATOR_PID_FILE"])
            root = os.path.realpath(os.environ["HOME"])
            if os.path.commonpath([root, path]) != root:
                raise RuntimeError("Scratch operator census is not confined")
            with open(path) as file:
                selected = json.load(file)
            if not isinstance(selected, list) or any(type(pid) is not int or pid < 2 for pid in selected):
                raise RuntimeError("Scratch operator census is invalid")
            if not selected:
                return {}, {}, {}
            selection = ["-ww", "-p", ",".join(str(pid) for pid in selected)]
        rows = subprocess.run(["/bin/ps", *selection, "-o", "pid=,ppid=,uid=,comm="],
                              capture_output=True, timeout=3, check=True)
        if len(rows.stdout) > 16 * 1024 * 1024:
            raise RuntimeError("Operator launcher census too large")
        found, parents, sessions = {}, {}, {}
        for line in rows.stdout.decode("utf-8", "strict").splitlines():
            fields = line.split(None, 3)
            if len(fields) != 4 or int(fields[2]) != os.getuid():
                continue
            pid = int(fields[0])
            parents[pid] = int(fields[1])
            try:
                words = None
                try:
                    image = executable(pid)
                except Exception:
                    # A package manager may unlink/replace a running binary.
                    # Darwin's KERN_PROCARGS2 retains its original exec path
                    # even when proc_pidpath returns ENOENT. Both are kernel
                    # observations; ps's lossy comm/args is never authority.
                    image, words = arguments(pid)
                name = os.path.basename(image.removesuffix(" (deleted)"))
                if name not in ("node", "nodejs", "clankie", "claude", "codex", "opencode", "grok", "prime", "bun"):
                    continue
                if words is None:
                    _, words = arguments(pid)
            except Exception:
                if identity(pid) is None:
                    continue
                raise
            for flag in ("--session-id", "--resume"):
                if flag in words and len(words) > words.index(flag) + 1:
                    value = words[words.index(flag) + 1]
                    if re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", value):
                        sessions[int(fields[0])] = value.lower()
            # Only a native executable or Node entry point, never shell text
            # mentioning a launcher, is a candidate.
            at = 0
            if name in ("node", "nodejs", "bun"):
                candidates = [index for index, word in enumerate(words[:-1])
                              if os.path.basename(word) in ("clankie", "clankie.ts") and
                              words[index + 1].rstrip("0123456789") in ("claude", "codex", "opencode", "grok", "prime")]
                if len(candidates) > 1:
                    raise RuntimeError("Operator entry point is ambiguous")
                if not candidates:
                    continue
                at = candidates[0]
            if at >= len(words) or os.path.basename(words[at]) not in ("clankie", "clankie.ts"):
                continue
            command = words[at + 1] if len(words) > at + 1 else ""
            base = command.rstrip("0123456789")
            if base not in ("claude", "codex", "opencode", "grok", "prime"):
                continue
            conversation = None
            if "--conversation" in words[at + 2:]:
                index = words.index("--conversation", at + 2)
                if len(words) > index + 1:
                    conversation = words[index + 1]
            found[int(fields[0])] = {"command": command, "conversationId": conversation}
        # A launcher can die while its native session remains alive. Keep that
        # lifetime visible to the service's exact transcript-owner lookup; a
        # missing launcher must never turn a live operator into an empty census.
        launchers = set(found)
        for pid in sessions:
            parent, seen = pid, set()
            while parent in parents and parent not in seen and parent not in launchers:
                seen.add(parent)
                parent = parents[parent]
            if parent not in launchers:
                found[pid] = {"command": "native session without launcher", "conversationId": None,
                              "nativeSessionOnly": True}
        return found, parents, sessions
    before, parents, sessions = census()
    result = []
    for pid, launch in before.items():
        current = identity(pid)
        if current is None:
            raise RuntimeError("Operator launcher census changed")
        descendants = {pid}
        for _ in range(64):
            following = descendants | {child for child, parent in parents.items() if parent in descendants}
            if following == descendants:
                break
            descendants = following
        else:
            raise RuntimeError("Operator child ancestry too deep")
        processes = []
        for child in descendants:
            observed = identity(child)
            if observed is None:
                raise RuntimeError("Operator launcher child census changed")
            processes.append({"pid": child, "startTime": observed["startTime"]})
        native_sessions = {session for child, session in sessions.items() if child in descendants}
        result.append({**launch, "pid": pid, "startTime": current["startTime"], "processes": processes,
                       "sessionId": next(iter(native_sessions)) if len(native_sessions) == 1 else None})
    after, after_parents, after_sessions = census()
    if before != after or any(parents.get(row["pid"]) != after_parents.get(row["pid"]) or
                              sessions.get(row["pid"]) != after_sessions.get(row["pid"])
                              for seat in result for row in seat["processes"]):
        raise RuntimeError("Operator launcher census changed")
    return {"schemaVersion": 1, "seats": result}


def harness_processes():
    """Same-user harness census. Arguments stay here; only remote endpoints escape.

    Endpoint equality protects a reattached client even outside Herdr. A failed
    complete argument census refuses retirement, rather than implying no client.
    """
    rows = subprocess.run(["/bin/ps", "-axww", "-o", "pid=,uid=,comm="],
                          capture_output=True, timeout=3, check=True)
    args = subprocess.run(["/bin/ps", "-axww", "-o", "pid=,args="],
                          capture_output=True, timeout=3, check=True)
    if max(len(rows.stdout), len(args.stdout)) > 16 * 1024 * 1024:
        raise RuntimeError("Harness census too large")
    arguments = {}
    for line in args.stdout.decode("utf-8", "replace").splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2:
            arguments[int(fields[0])] = fields[1].split()
    processes = []
    for line in rows.stdout.decode("utf-8", "replace").splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) != 3 or int(fields[1]) != os.getuid():
            continue
        executable = fields[2]
        name = os.path.basename(executable)
        if name not in ("codex", "claude", "codex-code-mode-host"):
            continue
        pid = int(fields[0])
        current = identity(pid)
        if current is None:
            continue
        executable_verified = False
        if sys.platform == "darwin":
            library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
            library.proc_pidpath.restype = ctypes.c_int
            path = ctypes.create_string_buffer(4096)
            if library.proc_pidpath(pid, path, len(path)) <= 0:
                # A disappearing member is irrelevant; a denied live read is
                # not an empty complete census.
                if identity(pid) is None:
                    continue
            else:
                executable = path.value.decode("utf-8", "strict")
                executable_verified = True
        elif sys.platform.startswith("linux"):
            try:
                executable = os.readlink("/proc/%s/exe" % pid)
                executable_verified = True
            except OSError:
                pass
        argv = arguments.get(pid)
        if argv is None:
            raise RuntimeError("Harness arguments unavailable")
        endpoints = [value for value in argv if value.startswith("unix:///")]
        processes.append({**current, "executable": executable, "cwd": None,
                          "executableVerified": executable_verified,
                          "kind": "helper" if name == "codex-code-mode-host" else name,
                          "server": "app-server" in argv,
                          "endpoint": endpoints[0] if len(endpoints) == 1 else None})
    if len(processes) > 1024:
        raise RuntimeError("Harness census too large")
    if processes and sys.platform == "darwin":
        result = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-p",
                                 ",".join(str(row["pid"]) for row in processes), "-d", "cwd", "-Fpn"],
                                capture_output=True, timeout=5)
        # Missing cwd is an honest diagnostic gap, never retirement authority.
        if len(result.stdout) > 4 * 1024 * 1024:
            raise RuntimeError("Harness cwd census too large")
        current_pid = None
        paths = {}
        for line in result.stdout.decode("utf-8", "replace").splitlines():
            if line.startswith("p"):
                current_pid = int(line[1:])
            elif line.startswith("n"):
                paths[current_pid] = line[1:]
        for row in processes:
            row["cwd"] = paths.get(row["pid"])
    elif sys.platform.startswith("linux"):
        for row in processes:
            try:
                row["cwd"] = os.readlink("/proc/%s/cwd" % row["pid"])
            except OSError:
                pass
    return {"schemaVersion": 1, "processes": processes}


def terminate_harness():
    """TERM one exact registered server lifetime, never a PID/group sweep.

    The caller supplies proven closed-pane provenance. Re-observe native birth,
    executable and all harness clients here immediately before the signal. Old
    second-resolution receipts are deliberately insufficient for this effect.
    """
    request = json.loads(sys.stdin.read(16385))
    if not isinstance(request, dict) or set(request) != {"pid", "startTime", "endpoint", "executable"}:
        raise RuntimeError("Harness termination request unavailable")
    pid = request["pid"]
    if type(pid) is not int or pid <= 1 or pid == os.getppid():
        raise RuntimeError("Harness termination PID unavailable")
    rows = harness_processes()["processes"]
    row = next((row for row in rows if row["pid"] == pid), None)
    if row is None:
        return {"outcome": "exited"}
    if row["kind"] != "codex" or not row["executableVerified"] or not row["server"] or not request["endpoint"] or \
            any(row[key] != request[key] for key in request) or \
            any(other["pid"] != pid and other["endpoint"] == request["endpoint"] for other in rows):
        return {"outcome": "refused"}
    current = identity(pid)
    if current is None:
        return {"outcome": "exited"}
    if current["startTime"] != request["startTime"]:
        return {"outcome": "refused"}
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return {"outcome": "exited"}
    # Signal delivery is not exit evidence. Never escalate to KILL or repeat an
    # uncertain signal; report a survivor for inspection instead.
    for _ in range(40):
        current = identity(pid)
        if current is None or current["startTime"] != request["startTime"]:
            return {"outcome": "retired"}
        time.sleep(0.05)
    return {"outcome": "exit_unconfirmed"}


def lock(directory):
    global lock_stage
    lock_stage = "directory-create"
    os.makedirs(directory, mode=0o700, exist_ok=True)
    lock_stage = "lock-open"
    file = open(os.path.join(directory, "state.lock"), "a+")
    lock_stage = "lock-mode"
    os.chmod(file.name, 0o600)
    lock_stage = "lock-acquire"
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
    global lock_stage
    import tempfile
    lock_stage = "journal-create"
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=directory)
    try:
        lock_stage = "journal-mode"
        os.fchmod(fd, 0o600)
        lock_stage = "journal-write"
        with os.fdopen(fd, "w") as file:
            json.dump(state, file, separators=(",", ":"))
            file.write("\n")
            file.flush()
            lock_stage = "journal-sync"
            os.fsync(file.fileno())
            lock_stage = "journal-close"
        lock_stage = "journal-replace"
        os.replace(temporary, os.path.join(directory, "state.json"))
        lock_stage = "directory-open"
        fd = os.open(directory, os.O_RDONLY)
        try:
            lock_stage = "directory-sync"
            os.fsync(fd)
        finally:
            previous_stage = lock_stage
            lock_stage = "directory-close"
            os.close(fd)
            lock_stage = previous_stage
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def locked_pipe(directory):
    global lock_stage
    with lock(directory):
        lock_stage = "journal-read"
        print(json.dumps(read_state(directory)), flush=True)
        lock_stage = "request-read"
        line = sys.stdin.readline(1024 * 1024 + 1)
        if line:
            request = json.loads(line)
            if "write" in request:
                write_state(directory, request["write"])
        lock_stage = "reply-write"
        print("done", flush=True)
        lock_stage = "lock-close"


def serve():
    """One long-lived observer per governor process (VUH-2082).

    Each request is one JSON line {"id", "op", ...}; each reply is one line with
    the same id and either "result" or a bounded "error" (an exception type,
    never paths or arguments). Exact semantics match the one-shot modes; this
    only removes a Python start per observation."""
    while True:
        line = sys.stdin.readline(65537)
        if not line:
            return
        reply = {"id": None}
        try:
            if len(line) > 65536:
                raise RuntimeError("Request too large")
            request = json.loads(line)
            if not isinstance(request, dict) or type(request.get("id")) is not int:
                raise RuntimeError("Request unavailable")
            reply["id"] = request["id"]
            op = request.get("op")
            if op == "identity":
                pid = request.get("pid")
                if type(pid) is not int:
                    raise RuntimeError("Process identity request unavailable")
                reply["result"] = identity(pid)
            elif op == "observe":
                reply["result"] = observe_pids(request.get("pids"))
            elif op == "group-occupied":
                pgid = request.get("pgid")
                if type(pgid) is not int or pgid < 2:
                    raise RuntimeError("Process group request unavailable")
                reply["result"] = group_occupied(pgid)
            elif op == "memory":
                reply["result"] = darwin_memory()
            elif op == "ancestry":
                reply["result"] = ancestry()
            elif op == "snapshot":
                reply["result"] = snapshot()
            elif op == "available":
                reply["result"] = identity(os.getpid()) is not None
            else:
                raise RuntimeError("Unknown native operation")
        except Exception as error:
            reply.pop("result", None)
            reply["error"] = type(error).__name__
        sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def lock_serve(directory):
    """One long-lived lock helper per registry journal (VUH-2082).

    Repeats the one-shot transaction for each {"op":"begin"} line: lock, print
    the journal, read one request line, optionally write, print done, unlock.
    Any fault exits with the same bounded stage diagnostic as `lock`; the
    caller starts a fresh helper. End of input releases any lock it holds."""
    global lock_stage
    while True:
        lock_stage = "begin-read"
        line = sys.stdin.readline(1024)
        if not line:
            return
        if json.loads(line) != {"op": "begin"}:
            raise RuntimeError("Lock request unavailable")
        with lock(directory):
            lock_stage = "journal-read"
            print(json.dumps(read_state(directory)), flush=True)
            lock_stage = "request-read"
            line = sys.stdin.readline(1024 * 1024 + 1)
            if not line:
                return
            request = json.loads(line)
            if "write" in request:
                write_state(directory, request["write"])
            lock_stage = "reply-write"
            print("done", flush=True)
            lock_stage = "lock-close"


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
        budget = None
        if "serverCpuCores" in request:
            import importlib.util
            spec = importlib.util.spec_from_file_location("server_cpu", os.path.join(os.path.dirname(__file__), "server-cpu.py"))
            budget = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(budget)
            reader = budget.cpu_reader()
        child = subprocess.Popen([request["command"], *request["args"]], env=environment,
                                 cwd=request.get("cwd"),
                                 stdin=subprocess.PIPE if "input" in request else None)
        if "input" in request:
            child.stdin.write(request["input"].encode("utf-8"))
            child.stdin.close()
        if budget is not None:
            code = budget.wait(child, mine, request["serverCpuCores"], identity, born_since, signal_bound, reader,
                               os.path.join(directory, "cpu", os.path.basename(lease_id) + ".json"))
        else:
            code = child.wait()
        if group_occupied(mine["pgid"]):
            # The command exited; whatever remains in its group is a leftover. Show it,
            # give it a short grace to exit, then stop it so the slot frees (VUH-2027).
            exited_at = int(time.time() * 1000)
            with lock(directory):
                state = read_state(directory)
                lease = next((row for row in state["leases"] if row["id"] == lease_id and row["token"] == token), None)
            mark_leftovers(directory, lease_id, exited_at)
            deadline = time.time() + LEFTOVER_GRACE_SECONDS
            while group_occupied(mine["pgid"]) and time.time() < deadline:
                time.sleep(0.5)
            if group_occupied(mine["pgid"]):
                stop_leftovers(directory, {**(lease or {}), "id": lease_id, "runner": mine,
                                           "commandExitedAtMs": exited_at}, mine["pgid"], mine["pid"])
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
            try:
                os.unlink(leftover_marker(directory, lease_id))
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    try:
        mode = sys.argv[1]
        if mode == "identity":
            print(json.dumps(identity(int(sys.argv[2]))))
        elif mode == "available":
            if len(sys.argv) != 2 or identity(os.getpid()) is None:
                raise RuntimeError("Native observer unavailable")
            print("true")
        elif mode == "memory":
            if len(sys.argv) != 2:
                raise RuntimeError("Memory observation request unavailable")
            print(json.dumps(darwin_memory(), separators=(",", ":")))
        elif mode == "snapshot":
            print(json.dumps(snapshot()))
        elif mode == "operator-seats":
            if len(sys.argv) != 2:
                raise RuntimeError("Operator launcher census request unavailable")
            print(json.dumps(operator_seats(), separators=(",", ":")))
        elif mode == "harness-processes":
            if len(sys.argv) != 2:
                raise RuntimeError("Harness census request unavailable")
            print(json.dumps(harness_processes(), separators=(",", ":")))
        elif mode == "terminate-harness":
            if len(sys.argv) != 2:
                raise RuntimeError("Harness termination request unavailable")
            print(json.dumps(terminate_harness(), separators=(",", ":")))
        elif mode == "observe":
            if len(sys.argv) != 2:
                raise RuntimeError("Process identity request unavailable")
            print(json.dumps(observe_processes(), separators=(",", ":")))
        elif mode == "simulator-referents":
            if len(sys.argv) != 2:
                raise RuntimeError("Simulator referent request unavailable")
            print(json.dumps(simulator_referents(), separators=(",", ":")))
        elif mode == "simulator-usage":
            if len(sys.argv) != 2:
                raise RuntimeError("Simulator usage request unavailable")
            print(json.dumps(simulator_usage(), separators=(",", ":")))
        elif mode == "group-occupied":
            if len(sys.argv) != 3 or int(sys.argv[2]) < 2:
                raise RuntimeError("Process group request unavailable")
            print(json.dumps(group_occupied(int(sys.argv[2]))))
        elif mode == "stop-leftovers":
            # The governor's reaper for a lease whose runner died with leftovers in its group.
            if len(sys.argv) != 4:
                raise RuntimeError("Leftover request unavailable")
            lease = json.loads(sys.stdin.readline(1024 * 1024))
            print(json.dumps(stop_leftovers(sys.argv[2], lease, int(sys.argv[3]), os.getpid()), separators=(",", ":")))
        elif mode == "lock":
            locked_pipe(sys.argv[2])
        elif mode == "lock-serve":
            if len(sys.argv) != 3:
                raise RuntimeError("Lock request unavailable")
            lock_serve(sys.argv[2])
        elif mode == "serve":
            if len(sys.argv) != 2:
                raise RuntimeError("Native observer unavailable")
            serve()
        elif mode == "run":
            sys.exit(heavy_runner(sys.argv[2], sys.argv[3], sys.argv[4]))
        else:
            raise RuntimeError("Unknown native operation")
    except Exception as error:
        if len(sys.argv) > 1 and sys.argv[1] in ("lock", "lock-serve"):
            # Report cause, never journal data, paths or command arguments.
            detail = type(error).__name__
            if isinstance(error, OSError) and error.errno is not None:
                detail += " (errno %s)" % error.errno
            print("Fleet resource lock helper failed: " + detail + " at " + lock_stage, file=sys.stderr)
        else:
            print("Fleet resource native boundary unavailable", file=sys.stderr)
        sys.exit(1)
