#!/usr/bin/python3
"""Immutable Herdr pane shell. Controller socket and original bwrap child only."""
import importlib.util
import json
import os
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import time

BASE = "/eval/control/claude/launch"
BWRAP = "/opt/codex/bin/bwrap"
MAX = 65536


def row(pid):
    with open(f"/proc/{pid}/stat", encoding="ascii") as source:
        raw = source.read(4097)
    if len(raw) > 4096:
        raise ValueError("process row exceeds bound")
    fields = raw[raw.rfind(") ") + 2:].split()
    return {"pid": int(pid), "parent": int(fields[1]), "group": int(fields[2]),
            "session": int(fields[3]), "tty": int(fields[4]), "foreground": int(fields[5]), "startTicks": fields[19]}


def receive(stream):
    line = stream.readline(MAX + 1)
    if not line.endswith(b"\n") or len(line) > MAX:
        raise ValueError("controller frame unavailable")
    return json.loads(line)


def send(stream, value):
    raw = json.dumps(value, separators=(",", ":")).encode() + b"\n"
    if len(raw) > MAX:
        raise ValueError("controller frame exceeds bound")
    stream.write(raw)
    stream.flush()


def info_child(fd):
    deadline = time.monotonic() + 5
    data = b""
    while len(data) <= 4096:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise ValueError("held child identity timed out")
        chunk = os.read(fd, min(1024, 4097 - len(data)))
        if not chunk:
            break
        data += chunk
    value = json.loads(data)
    pid = value.get("child-pid")
    if type(pid) is not int or pid < 1 or len(data) > 4096:
        raise ValueError("held child identity unavailable")
    return pid


def load_capture():
    spec = importlib.util.spec_from_file_location("capture", "/usr/local/lib/lead-native-claude-capture.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def alive(pidfd):
    if select.select([pidfd], [], [], 0)[0]:
        raise ValueError("original native pidfd exited")


def require_pidfd():
    # Fail before spawning if this interpreter/kernel cannot hold and signal lifetimes.
    fd = os.pidfd_open(os.getpid(), 0)
    try:
        alive(fd)
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)


def await_containment_stop(stream):
    # bwrap treats block-fd EOF as release, and installs child pdeath after that
    # read. Never exit/close the gate when exact child termination is uncertain.
    try:
        send(stream, {"kind": "failed", "reason": "native-termination-unconfirmed"})
    except BaseException:
        pass
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, signal.SIG_IGN)
    while True:
        signal.pause()  # Only the controller's exact container SIGKILL settles this latch.


def terminate_owned(child, pidfd, descriptors, stream):
    if child is not None:
        try:
            if pidfd is None:
                raise ValueError("original native identity unavailable during teardown")
            if not select.select([pidfd], [], [], 0)[0]:
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            if not select.select([pidfd], [], [], 2)[0]:
                raise ValueError("original native termination unconfirmed")
            if child.poll() is None:
                child.kill()
            child.wait(timeout=2)
        except BaseException:
            await_containment_stop(stream)
            raise ValueError("containment latch unexpectedly returned")
    for fd in descriptors:
        os.close(fd)


def pin_child(pid, parent):
    # Linux pidfd pins the original lifetime across exec; no PID-only fallback.
    fd = os.pidfd_open(pid, 0)
    try:
        alive(fd)
        process = row(pid)
        if process["parent"] != parent:
            raise ValueError("held child parent changed")
        alive(fd)
        return fd, process
    except BaseException:
        os.close(fd)
        raise


def release_child(child, pid, initial, launcher, pidfd, gate):
    if child.poll() is not None or row(pid) != initial or row(child.pid) != launcher:
        raise ValueError("held child changed before release")
    alive(pidfd)
    os.write(gate, b"1")


def observe(capture, config, pid, initial, pidfd, root=None):
    alive(pidfd)
    if row(pid)["startTicks"] != initial["startTicks"]:
        raise ValueError("original native lifetime changed")
    actual = capture.verify_process(config, root, selected_pid=pid)
    if actual["startTicks"] != initial["startTicks"]:
        raise ValueError("original native lifetime changed")
    process = row(pid)
    if process["tty"] == 0 or process["group"] != process["foreground"]:
        raise ValueError("native process is not foreground")
    alive(pidfd)
    return {"root": actual, "process": process,
            "namespaces": {key: os.readlink(f"/proc/{pid}/ns/{key}") for key in ("pid", "mnt", "net")}}


def serve():
    pane = os.environ.get("HERDR_PANE_ID", "")
    if not re.fullmatch(r"w[A-Za-z0-9]+:p[A-Za-z0-9]+", pane):
        raise ValueError("pane address unavailable")
    shell = row(os.getpid())
    if shell["tty"] == 0 or shell["group"] != shell["foreground"]:
        raise ValueError("native pane terminal unavailable")
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(f"{BASE}/{pane}.sock")
    os.chmod(f"{BASE}/{pane}.sock", 0o600)
    listener.listen(1)
    listener.settimeout(30)
    child = None
    pidfd = None
    stream = None
    descriptors = []
    try:
        connection, _ = listener.accept()
        with connection:
            connection.settimeout(10)
            stream = connection.makefile("rwb", buffering=0)
            send(stream, {"kind": "shell", "shell": shell})
            config = receive(stream)
            if config.get("op") != "launch" or config.get("selection", {}).get("paneId") != pane:
                raise ValueError("controller allocation mismatch")
            selection = config["selection"]
            if selection["argv"][0] != "/opt/claude/bin/claude" or selection["cwd"] != "/eval/tasks/lead":
                raise ValueError("unallocated executable/workspace")
            require_pidfd()
            info_read, info_write = os.pipe()
            gate_read, gate_write = os.pipe()
            descriptors = [info_read, info_write, gate_read, gate_write]
            child = subprocess.Popen([BWRAP, *config["sandbox"], "--info-fd", str(info_write),
                                      "--block-fd", str(gate_read), "--", *selection["argv"]],
                                     cwd=selection["cwd"], env=config["environment"],
                                     pass_fds=(info_write, gate_read), close_fds=True)
            os.close(info_write)
            os.close(gate_read)
            descriptors = [info_read, gate_write]
            native_pid = info_child(info_read)
            if child.poll() is not None:
                raise ValueError("owned launcher exited")
            pidfd, initial = pin_child(native_pid, child.pid)
            descriptors.append(pidfd)
            launcher = row(child.pid)
            if initial["parent"] != child.pid or launcher["parent"] != shell["pid"]:
                raise ValueError("original native child ancestry unavailable")
            send(stream, {"kind": "held", "shell": shell, "launcher": launcher, "process": initial})
            if receive(stream) != {"op": "release"}:
                raise ValueError("controller release unavailable")
            release_child(child, native_pid, initial, launcher, pidfd, gate_write)
            os.close(gate_write)
            descriptors = [info_read, pidfd]
            capture = load_capture()
            deadline = time.monotonic() + 5
            observation = None
            while child.poll() is None and time.monotonic() < deadline:
                try:
                    observation = observe(capture, selection, native_pid, initial, pidfd)
                    break
                except (ValueError, FileNotFoundError):
                    time.sleep(0.02)
            if observation is None:
                raise ValueError("exact native exec unavailable")
            send(stream, {"kind": "running", **observation})
            while True:
                if receive(stream) != {"op": "observe"} or child.poll() is not None or row(shell["pid"]) != shell:
                    raise ValueError("controller/native lifetime lost")
                observation = observe(capture, selection, native_pid, initial, pidfd, observation["root"])
                send(stream, {"kind": "running", **observation})
    finally:
        listener.close()
        terminate_owned(child, pidfd, descriptors, stream)


def client(pane):
    if not re.fullmatch(r"w[A-Za-z0-9]+:p[A-Za-z0-9]+", pane):
        raise ValueError("invalid pane address")
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(10)
    connection.connect(f"{BASE}/{pane}.sock")
    pid, uid, gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    send(sys.stdout.buffer, {"kind": "peer", "pid": pid, "uid": uid, "gid": gid})
    # Bounded line relay. Peer credentials originate here, never in launcher JSON.
    stream = connection.makefile("rwb", buffering=0)
    send(sys.stdout.buffer, receive(stream))
    while True:
        if not select.select([sys.stdin.buffer], [], [], 10)[0]:
            raise ValueError("controller heartbeat lost")
        send(stream, receive(sys.stdin.buffer))
        send(sys.stdout.buffer, receive(stream))


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "inspect":
            send(sys.stdout.buffer, row(int(sys.argv[2])))
        elif len(sys.argv) == 3 and sys.argv[1] == "client":
            client(sys.argv[2])
        elif len(sys.argv) == 1:
            serve()
        else:
            raise ValueError("unsupported controller operation")
    except BaseException:
        sys.stderr.write("Native Claude launch lifetime lost; controller must stop containment.\n")
        sys.exit(1)
