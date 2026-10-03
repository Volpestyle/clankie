"""Controller capture helper. No execution on import; JSON data never grants authority."""
import base64
import hashlib
import json
import os
import re
import select
import socket
import stat
import struct
import sys
import time

MAX_FILE = 16 * 1024 * 1024
MAX_BATCH = 32 * 1024 * 1024
MAX_HOOK = 65536
MAX_CHILDREN = 32
EXECUTABLE = "/opt/claude/bin/claude"
CONFIG = "/eval/control/claude/config"
SOCKET = "/eval/control/claude/collector/hooks.sock"
EVENTS = {"SessionStart", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop", "StopFailure", "SessionEnd"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def bounded_file(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise ValueError("process evidence exceeds bound")
        return data
    finally:
        os.close(fd)


def process_row(pid, proc="/proc"):
    prefix = f"{proc}/{pid}"
    raw = bounded_file(prefix + "/stat", 4096).decode("ascii")
    fields = raw[raw.rfind(") ") + 2:].split()
    if len(fields) < 20:
        raise ValueError("process lifetime unavailable")
    return {"pid": int(pid), "parent": int(fields[1]), "tty": int(fields[4]), "startTicks": fields[19]}


def verify_process(config, expected=None, proc="/proc"):
    rows = []
    pids = [str(expected["pid"])] if expected else [p for p in os.listdir(proc) if p.isdecimal()]
    if len(pids) > 512:
        raise ValueError("process inventory exceeds bound")
    for pid in pids:
        prefix = f"{proc}/{pid}"
        try:
            row = process_row(pid, proc)
            env = bounded_file(prefix + "/environ", 65536).split(b"\0")
            if f"HERDR_PANE_ID={config['paneId']}".encode() not in env or f"CLAUDE_CONFIG_DIR={CONFIG}".encode() not in env:
                continue
            args = bounded_file(prefix + "/cmdline", 65536).decode("utf8").rstrip("\0").split("\0")
            if args != config["argv"] or os.readlink(prefix + "/exe") != EXECUTABLE or os.readlink(prefix + "/cwd") != config["cwd"] or row["tty"] == 0:
                continue
            # Hash the process's actual open executable, not a replacement at its pathname.
            fd = os.open(prefix + "/exe", os.O_RDONLY)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 512 * 1024 * 1024:
                    raise ValueError("unbounded native executable")
                fingerprint = {"exeDevice": str(info.st_dev), "exeInode": str(info.st_ino), "exeBytes": info.st_size, "exeCtimeNs": str(info.st_ctime_ns)}
                if expected and any(expected.get(key) != value for key, value in fingerprint.items()):
                    raise ValueError("native executable lifetime changed")
                if not expected:
                    digest = hashlib.sha256()
                    while True:
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break
                        digest.update(chunk)
                    if digest.hexdigest() != config["executableSha256"]:
                        continue
                after = os.fstat(fd)
                if (after.st_size, after.st_ctime_ns) != (info.st_size, info.st_ctime_ns):
                    raise ValueError("native executable changed while hashing")
            finally:
                os.close(fd)
            if row != process_row(pid, proc):
                raise ValueError("native process lifetime changed")
            binding = {"pid": row["pid"], "startTicks": row["startTicks"], "tty": row["tty"], "executableSha256": config["executableSha256"], **fingerprint}
            if expected and binding != expected:
                raise ValueError("native process binding changed")
            rows.append(binding)
        except (FileNotFoundError, ProcessLookupError):
            continue
    if len(rows) != 1:
        raise ValueError("exact interactive Claude process unavailable")
    return rows[0]


def peer_binding(connection, root, proc="/proc"):
    pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
    if uid != os.getuid():
        raise ValueError("hook peer uid mismatch")
    peer = process_row(pid, proc)
    current = peer
    chain = [peer]
    seen = set()
    while current["pid"] != root["pid"]:
        if current["pid"] in seen or len(seen) >= 32 or current["parent"] < 1:
            raise ValueError("hook peer outside selected process ancestry")
        seen.add(current["pid"])
        current = process_row(current["parent"], proc)
        chain.append(current)
    if current["startTicks"] != root["startTicks"]:
        raise ValueError("hook root lifetime changed")
    if any(row != process_row(row["pid"], proc) for row in chain):
        raise ValueError("hook ancestry lifetime changed")
    return {"pid": pid, "startTicks": peer["startTicks"]}


def open_directory(path):
    if not path.startswith("/") or os.path.normpath(path) != path:
        raise ValueError("canonical capture directory required")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.split("/")[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_snapshot(directory, name):
    if not re.fullmatch(r"[A-Za-z0-9_-]+\.jsonl", name):
        raise ValueError("invalid transcript name")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.getuid() or before.st_size > MAX_FILE:
            raise ValueError("invalid transcript file")
        def read_prefix():
            os.lseek(fd, 0, os.SEEK_SET)
            parts, left = [], before.st_size
            while left:
                chunk = os.read(fd, min(65536, left))
                if not chunk:
                    raise ValueError("transcript truncated during read")
                parts.append(chunk)
                left -= len(chunk)
            return b"".join(parts)
        data = read_prefix()
        # Concurrent append is permitted, but changing captured prefix is not.
        if read_prefix() != data:
            raise ValueError("transcript prefix changed during read")
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (after.st_dev, after.st_ino, after.st_nlink) != (before.st_dev, before.st_ino, 1) or after.st_size < before.st_size or (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino) or not stat.S_ISREG(named.st_mode):
            raise ValueError("transcript handle/path changed")
        return {"bytes": len(data), "sha256": sha(data), "device": before.st_dev, "inode": before.st_ino, "data": base64.b64encode(data).decode("ascii")}
    finally:
        os.close(fd)


def snapshots(config):
    project = CONFIG + "/projects/" + re.sub(r"[^A-Za-z0-9]", "-", config["cwd"])
    result, total = [], 0
    try:
        parent = open_directory(project)
    except FileNotFoundError:
        return [], ["root-transcript-not-yet-present"]
    try:
        try:
            root = read_snapshot(parent, config["sessionId"] + ".jsonl")
            result.append({"agentId": None, **root})
            total += root["bytes"]
        except FileNotFoundError:
            return [], ["root-transcript-not-yet-present"]
        try:
            # Walk beneath the already opened project handle, never a hook-supplied path.
            session = os.open(config["sessionId"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:
            return result, []
        try:
            try:
                children = os.open("subagents", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=session)
            except FileNotFoundError:
                return result, []
            try:
                names = os.listdir(children)
                if len(names) > MAX_CHILDREN:
                    raise ValueError("subagent inventory exceeds bound")
                for name in sorted(names):
                    match = re.fullmatch(r"agent-([A-Za-z0-9_-]{1,128})\.jsonl", name)
                    if not match:
                        raise ValueError("unknown subagent transcript entry")
                    item = read_snapshot(children, name)
                    total += item["bytes"]
                    if total > MAX_BATCH:
                        raise ValueError("capture batch exceeds bound")
                    result.append({"agentId": match[1], **item})
            finally:
                try:
                    named = os.stat("subagents", dir_fd=session, follow_symlinks=False)
                    opened = os.fstat(children)
                    if not stat.S_ISDIR(named.st_mode) or (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
                        raise ValueError("subagent directory changed")
                finally:
                    os.close(children)
        finally:
            try:
                named = os.stat(config["sessionId"], dir_fd=parent, follow_symlinks=False)
                opened = os.fstat(session)
                if not stat.S_ISDIR(named.st_mode) or (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
                    raise ValueError("session directory changed")
            finally:
                os.close(session)
    finally:
        try:
            reopened = open_directory(project)
            try:
                before, after = os.fstat(parent), os.fstat(reopened)
                if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                    raise ValueError("project directory changed")
            finally:
                os.close(reopened)
        finally:
            os.close(parent)
    return result, []


def emit(frame):
    sys.stdout.write(json.dumps(frame, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def acknowledged(frame):
    emit(frame)
    if not select.select([sys.stdin], [], [], 5)[0]:
        raise ValueError("controller capture acknowledgement timed out")
    line = sys.stdin.readline(256)
    if line != '{"ack":true}\n':
        raise ValueError("controller capture acknowledgement lost")


def serve(config):
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(SOCKET)  # Existing sockets are refused, never removed/reused.
    os.chmod(SOCKET, 0o600)
    listener.listen(8)
    listener.settimeout(0.25)
    root = None
    sequence = 0
    last_heartbeat = time.monotonic()
    acknowledged({"kind": "ready"})
    try:
        while True:
            if root:
                root = verify_process(config, root)
            if time.monotonic() - last_heartbeat >= 1:
                acknowledged({"kind": "heartbeat", "root": root})
                last_heartbeat = time.monotonic()
            if select.select([sys.stdin], [], [], 0)[0]:
                # Controller EOF or unsolicited input is a loss, not permission to continue.
                raise ValueError("controller capture pipe closed")
            try:
                connection, _address = listener.accept()
            except socket.timeout:
                continue
            with connection:
                connection.settimeout(2)
                root = verify_process(config, root)
                peer = peer_binding(connection, root)
                raw = bytearray()
                while True:
                    chunk = connection.recv(min(4096, MAX_HOOK + 1 - len(raw)))
                    if not chunk:
                        break
                    raw.extend(chunk)
                    if len(raw) > MAX_HOOK:
                        raise ValueError("hook input exceeds bound")
                event = json.loads(raw)
                if not isinstance(event, dict) or event.get("hook_event_name") not in EVENTS or event.get("session_id") != config["sessionId"]:
                    raise ValueError("unsupported or mismatched native hook")
                if peer_binding(connection, root) != peer:
                    raise ValueError("hook peer lifetime changed")
                root = verify_process(config, root)
                sequence += 1
                acknowledged({"kind": "hook", "sequence": sequence, "root": root, "peer": peer, "data": base64.b64encode(raw).decode("ascii"), "bytes": len(raw), "sha256": sha(raw)})
                files, gaps = snapshots(config)
                root = verify_process(config, root)
                for item in files:
                    root = verify_process(config, root)
                    acknowledged({"kind": "snapshot", "sequence": sequence, "root": root, **item})
                acknowledged({"kind": "batch-end", "sequence": sequence, "root": root, "gaps": gaps})
                connection.sendall(b"ok\n")
    finally:
        listener.close()


def main():
    if len(sys.argv) != 2:
        raise ValueError("exact capture configuration required")
    config = json.loads(sys.argv[1])
    if set(config) != {"paneId", "cwd", "sessionId", "argv", "executableSha256"} or not re.fullmatch(r"w[A-Za-z0-9]+:p[A-Za-z0-9]+", config["paneId"]) or config["cwd"] != "/eval/tasks/lead" or not re.fullmatch(r"[a-f0-9-]{36}", config["sessionId"]) or not re.fullmatch(r"[a-f0-9]{64}", config["executableSha256"]):
        raise ValueError("invalid selected capture identity")
    argv = config["argv"]
    if not isinstance(argv, list) or not argv or argv[0] != EXECUTABLE or any(not isinstance(arg, str) for arg in argv) or any(re.match(r"^-p|^--(?:print|bg|background|input-format|output-format|sdk-url)(?:=|$)|^--settings=", arg) for arg in argv) or argv.count("--session-id") != 1 or argv[argv.index("--session-id") + 1] != config["sessionId"]:
        raise ValueError("exact interactive session argv required")
    serve(config)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Error bodies never echo a hook, credential, transcript or path.
        sys.stderr.write("Native Claude capture lost; controller must stop the owned container.\n")
        sys.exit(1)
