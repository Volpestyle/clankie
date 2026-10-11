"""Private Linux containment primitive, not a capacity allocator (VUH-2091).

The host must persist its permit and this prepared birth before sending go.
This receipt journal never replaces the canonical Windows budget journal.
WSL dispatch remains disabled until Windows interop containment is proven.
"""
import ctypes
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import select
import signal
import sys
import time
import uuid

spec = importlib.util.spec_from_file_location("fleet_native", Path(__file__).with_name("native.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

LIMIT = 65536
PHASES = {"preparing", "prepared", "running", "cleanup", "held", "released"}


def emit(value, fd=1):
    raw = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    if len(raw) > LIMIT:
        raise RuntimeError("Containment reply too large")
    while raw:
        raw = raw[os.write(fd, raw):]


def valid_id(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def valid_identity(value, namespace=False):
    if not isinstance(value, dict):
        return False
    if type(value.get("pid")) is not int or value["pid"] <= 1:
        return False
    if type(value.get("uid")) is not int or value["uid"] < 0:
        return False
    birth = str(value.get("startTime", "")).split(":")
    if len(birth) != 2 or not valid_id(birth[0]) or not birth[1].isdigit():
        return False
    return not namespace or (value.get("namespacePid") == 1 and
                             type(value.get("namespaceInode")) is int and value["namespaceInode"] > 0)


def validate_record(record):
    if not isinstance(record, dict) or record.get("schemaVersion") != 1:
        raise RuntimeError("Containment journal unavailable")
    if not valid_id(record.get("id")) or not valid_id(record.get("permitId")):
        raise RuntimeError("Containment journal unavailable")
    if not re.fullmatch(r"[a-f0-9]{64}", str(record.get("token", ""))):
        raise RuntimeError("Containment journal unavailable")
    if record.get("phase") not in PHASES or not valid_identity(record.get("owner")):
        raise RuntimeError("Containment journal unavailable")
    if record.get("namespaceInit") is not None and not valid_identity(record["namespaceInit"], True):
        raise RuntimeError("Containment journal unavailable")
    return record


def recovery(record, observation):
    """Unknown never means empty. A reported empty flag is not proof itself."""
    validate_record(record)
    proof = record.get("namespaceInit")
    if not proof or not isinstance(observation, dict):
        return "held"
    if observation.get("status") == "exited":
        return "released"
    current = observation.get("identity")
    if observation.get("status") != "live" or not valid_identity(current):
        return "held"
    # A known different boot/birth proves the recorded init incarnation gone.
    # Never signal the reused PID. Same-birth ownership/namespace uncertainty holds.
    return "released" if current["startTime"] != proof["startTime"] else "held"


def secure_directory(path, create=True):
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError("Containment directory unavailable")
    stat = path.stat()
    if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        raise RuntimeError("Containment directory ownership unavailable")


class Journal:
    def __init__(self, root, job_id, create=False):
        if not valid_id(job_id):
            raise RuntimeError("Invalid containment id")
        root = Path(root)
        secure_directory(root, create=create)
        self.id = job_id
        self.path = root / job_id
        if create:
            self.path.mkdir(mode=0o700)  # An existing claim is never overwritten.
        secure_directory(self.path, create=False)
        self.fd = os.open(self.path / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        stat = os.fstat(self.fd)
        if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
            self.close()
            raise RuntimeError("Containment lock ownership unavailable")
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def read(self):
        fd = os.open(self.path / "state.json", os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd) as file:
            stat = os.fstat(file.fileno())
            if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
                raise RuntimeError("Containment journal ownership unavailable")
            raw = file.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise RuntimeError("Containment journal too large")
        record = validate_record(json.loads(raw))
        if record["id"] != self.id:
            raise RuntimeError("Containment journal binding unavailable")
        return record

    def write(self, record):
        validate_record(record)
        if record["id"] != self.id:
            raise RuntimeError("Containment journal binding unavailable")
        # Existing atomic temp/fsync/replace/directory-fsync implementation.
        native.write_state(str(self.path), record)


def libc_call(name, *args):
    library = ctypes.CDLL(None, use_errno=True)
    result = getattr(library, name)(*args)
    if result != 0:
        raise OSError(ctypes.get_errno(), name)


def dead(fd):
    return bool(select.select([fd], [], [], 0)[0])


def parent_death(parent_fd):
    libc_call("prctl", 1, signal.SIGKILL, 0, 0, 0)  # PR_SET_PDEATHSIG
    # A pidfd inherited before fork closes the race before prctl was installed,
    # including PID 1 whose parent is outside its visible PID namespace.
    if dead(parent_fd):
        os._exit(125)


def observe(pid):
    """One bounded native read; never scan /proc or wait for a stuck read."""
    reader, writer = os.pipe()
    owner_fd = os.pidfd_open(os.getpid())
    child = os.fork()
    if child == 0:
        os.close(reader)
        try:
            parent_death(owner_fd)
            os.close(owner_fd)
            # A stuck observer must never retain the journal lock or go pipe.
            os.closerange(3, writer)
            os.closerange(writer + 1, 1048576)
            value = native.identity(pid)
            if value is None:
                result = {"status": "exited"}
            else:
                with open("/proc/%s/status" % pid) as file:
                    lines = file.read(16384).splitlines()
                entry = next(line for line in lines if line.startswith("NSpid:"))
                value["namespacePid"] = int(entry.split()[-1])
                value["namespaceInode"] = os.stat("/proc/%s/ns/pid" % pid).st_ino
                result = {"status": "live", "identity": value}
            emit(result, writer)
        except BaseException:
            emit({"status": "unknown"}, writer)
        os._exit(0)
    os.close(writer)
    os.close(owner_fd)
    try:
        if not select.select([reader], [], [], 1)[0]:
            # Still our unreaped child, so the PID cannot have been reused.
            os.kill(child, signal.SIGKILL)
            return {"status": "unknown"}
        raw = os.read(reader, LIMIT)
        return json.loads(raw)
    except (OSError, ValueError):
        return {"status": "unknown"}
    finally:
        os.close(reader)
        os.waitpid(child, os.WNOHANG)  # A D-state observer must not block the host.


def read_frames(fd, pending):
    raw = os.read(fd, LIMIT)
    if not raw:
        return [], pending, True
    pending += raw
    if len(pending) > LIMIT:
        raise RuntimeError("Containment input too large")
    frames = []
    while b"\n" in pending:
        line, pending = pending.split(b"\n", 1)
        value = json.loads(line)
        if not isinstance(value, dict):
            raise RuntimeError("Containment input unavailable")
        frames.append(value)
    return frames, pending, False


def init_process(request, parent_fd, gate, replies):
    parent_death(parent_fd)
    if os.getpid() != 1:
        raise RuntimeError("Private PID namespace unavailable")
    libc_call("mount", b"proc", b"/proc", b"proc", 14, None)  # nosuid/nodev/noexec
    libc_call("prctl", 38, 1, 0, 0, 0)  # no_new_privs before any command
    emit({"ready": True, "namespacePid": os.getpid()}, replies)
    if os.read(gate, 1) != b"G":
        os._exit(130)
    command = os.fork()
    if command == 0:
        null = os.open("/dev/null", os.O_RDONLY)
        os.dup2(null, 0)
        os.dup2(2, 1)  # stdout is the private protocol, command output uses stderr.
        os.closerange(3, 1048576)
        try:
            os.execvpe(request["command"], [request["command"]] + request["args"], os.environ)
        except BaseException:
            os._exit(127)
    code = None
    until = None
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            os._exit(code if code is not None else 127)
        if pid == command:
            code = os.waitstatus_to_exitcode(status)
            code = code if code >= 0 else 128 - code
            emit({"commandExitCode": code}, replies)
            until = time.monotonic() + 10  # Same leftover grace as the Mac runner.
        if until is not None and time.monotonic() >= until:
            # Kernel namespace-init exit kills and drains every remaining member,
            # including double-forks, setsid and nested PID namespaces.
            os._exit(code)
        if pid == 0:
            time.sleep(0.02)


def setup(request, parent_fd, gate, replies, lock_fd):
    try:
        parent_death(parent_fd)
        os.close(lock_fd)  # Children must never retain the journal lock on crash.
        uid, gid = os.getuid(), os.getgid()
        libc_call("unshare", 0x10000000)  # CLONE_NEWUSER
        Path("/proc/self/setgroups").write_text("deny")
        Path("/proc/self/uid_map").write_text("0 %s 1" % uid)
        Path("/proc/self/gid_map").write_text("0 %s 1" % gid)
        parent_death(parent_fd)  # Credential changes may reset the death signal.
        libc_call("unshare", 0x20000 | 0x20000000)  # private mount + PID namespaces
        libc_call("mount", None, b"/", None, 16384 | 262144, None)  # recursive/private
        setup_fd = os.pidfd_open(os.getpid())
        init = os.fork()
        if init == 0:
            init_process(request, setup_fd, gate, replies)
        os.close(setup_fd)
        emit({"initPid": init}, replies)
        _, status = os.waitpid(init, 0)
        emit({"done": True, "exitCode": os.waitstatus_to_exitcode(status)}, replies)
    except BaseException as error:
        emit({"error": type(error).__name__, "errno": getattr(error, "errno", None)}, replies)
    os._exit(0)


def supported():
    if not sys.platform.startswith("linux") or not hasattr(os, "pidfd_open"):
        raise RuntimeError("Linux PID namespace runtime unavailable")
    if "microsoft" in os.uname().release.lower() or Path("/run/WSL").exists():
        raise RuntimeError("WSL Windows interop containment is not proven")


def run(root):
    supported()
    pending = b""
    frames = []
    deadline = time.monotonic() + 10
    while not frames:
        if time.monotonic() >= deadline or not select.select([0], [], [], 1)[0]:
            if time.monotonic() >= deadline:
                raise RuntimeError("Containment request unavailable")
            continue
        frames, pending, eof = read_frames(0, pending)
        if eof:
            raise RuntimeError("Containment request unavailable")
    request = frames.pop(0)
    if not valid_id(request.get("id")) or not valid_id(request.get("permitId")) or not re.fullmatch(r"[a-f0-9]{64}", str(request.get("token", ""))):
        raise RuntimeError("Containment claim unavailable")
    command, args = request.get("command"), request.get("args")
    if not isinstance(command, str) or not command or "\0" in command or not isinstance(args, list) or any(not isinstance(arg, str) or "\0" in arg for arg in args):
        raise RuntimeError("Containment command unavailable")
    owner = observe(os.getpid())
    if owner.get("status") != "live":
        raise RuntimeError("Containment owner unavailable")
    journal = Journal(root, request["id"], create=True)
    record = {"schemaVersion": 1, "id": request["id"], "permitId": request["permitId"],
              "token": request["token"], "owner": owner["identity"], "phase": "preparing"}
    journal.write(record)
    gate, go = os.pipe()
    replies, response = os.pipe()
    parent_fd = os.pidfd_open(os.getpid())
    stage = os.fork()
    if stage == 0:
        os.close(go)
        os.close(replies)
        setup(request, parent_fd, gate, response, journal.fd)
    os.close(parent_fd)
    os.close(gate)
    os.close(response)
    stage_fd = os.pidfd_open(stage)
    init_fd = None
    cancelled = False
    complete = False
    reply_pending = b""
    ready = False
    init_pid = None
    cancel_at = None
    def cancel(_sig=None, _frame=None):
        nonlocal cancelled
        cancelled = True
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        while not ready or init_pid is None:
            if cancelled or time.monotonic() >= deadline:
                raise RuntimeError("Containment setup unavailable")
            if not select.select([replies], [], [], 0.1)[0]:
                continue
            values, reply_pending, eof = read_frames(replies, reply_pending)
            if eof:
                raise RuntimeError("Containment setup unavailable")
            for value in values:
                if "error" in value or "done" in value:
                    raise RuntimeError("Containment setup unavailable")
                ready = ready or value.get("ready") is True
                init_pid = value.get("initPid", init_pid)
        candidate_fd = os.pidfd_open(init_pid)
        observation = observe(init_pid)
        proof = observation.get("identity")
        if observation.get("status") != "live" or not valid_identity(proof, True) or proof.get("ppid") != stage or proof["namespaceInode"] == owner["identity"]["namespaceInode"] or dead(candidate_fd):
            os.close(candidate_fd)
            raise RuntimeError("Containment init birth unavailable")
        init_fd = candidate_fd
        record.update(phase="prepared", namespaceInit=proof)
        journal.write(record)  # Durable proof before the host can send go.
        emit({"id": record["id"], "phase": "prepared", "namespaceInit": proof})
        while not complete:
            if cancelled and cancel_at is None:
                cancel_at = time.monotonic()
                record["phase"] = "cleanup"
                journal.write(record)
                try:
                    signal.pidfd_send_signal(init_fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass  # The pinned incarnation already exited.
            if cancel_at is not None and time.monotonic() - cancel_at >= 10:
                break  # An unkillable member keeps its durable receipt held.
            selected = select.select([0, replies], [], [], 0.1)[0]
            if 0 in selected:
                values, pending, eof = read_frames(0, pending)
                frames.extend(values)
                cancelled = cancelled or eof
            while frames:
                control = frames.pop(0)
                if control.get("id") != record["id"] or control.get("token") != record["token"]:
                    cancelled = True
                    continue
                if control.get("action") == "go" and record["phase"] == "prepared" and not cancelled:
                    record["phase"] = "running"
                    journal.write(record)
                    os.write(go, b"G")
                    emit({"id": record["id"], "phase": "running"})
                elif control.get("action") == "cancel":
                    cancelled = True
                else:
                    cancelled = True
            if replies in selected:
                values, reply_pending, eof = read_frames(replies, reply_pending)
                for value in values:
                    if "commandExitCode" in value:
                        record.update(phase="cleanup", exitCode=value["commandExitCode"])
                        journal.write(record)
                        emit({"id": record["id"], "phase": "cleanup"})
                    if value.get("done") is True:
                        complete = True
                if eof and not complete:
                    cancelled = True
            if dead(stage_fd) and not complete:
                cancelled = True
        # A protocol "done" frame alone is never emptiness authority. Require
        # kernel exit of the pinned init (or a fresh native birth observation).
        if dead(init_fd) or recovery(record, observe(init_pid)) == "released":
            record.update(phase="released", empty=True)
        else:
            record.update(phase="held", empty=False)
        journal.write(record)
        emit({"id": record["id"], "phase": record["phase"], "empty": record["empty"]})
        return 130 if cancelled else record.get("exitCode", 127)
    finally:
        # Failure, malformed control and shutdown use the owned setup handle;
        # its death signal kills init even if proof acquisition failed.
        if not dead(stage_fd):
            try:
                signal.pidfd_send_signal(stage_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for fd in (go, replies, stage_fd, init_fd):
            if fd is not None:
                os.close(fd)
        os.waitpid(stage, os.WNOHANG)
        journal.close()


def inspect(root, job_id):
    supported()
    try:
        journal = Journal(root, job_id)
    except BlockingIOError:
        return {"id": job_id, "phase": "held", "empty": False, "reason": "live-lock"}
    try:
        record = journal.read()
        status = recovery(record, observe(record["namespaceInit"]["pid"])) if record.get("namespaceInit") else "held"
        record.update(phase=status, empty=status == "released")
        journal.write(record)
        return {"id": job_id, "phase": status, "empty": status == "released"}
    finally:
        journal.close()


if __name__ == "__main__":
    try:
        root = sys.argv[2] if len(sys.argv) > 2 else str(Path(pwd.getpwuid(os.getuid()).pw_dir) / ".clankie/fleet-resources/linux-jobs")
        if sys.argv[1] == "run":
            sys.exit(run(root))
        elif sys.argv[1] == "inspect" and len(sys.argv) == 4:
            emit(inspect(root, sys.argv[3]))
        else:
            raise RuntimeError("Unknown containment operation")
    except Exception as error:
        # No argv, paths, tokens or journal contents in error output.
        emit({"phase": "held", "empty": False, "error": type(error).__name__})
        sys.exit(1)
