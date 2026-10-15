#!/usr/bin/python3 -I
"""Read-only Linux kernel facts. A claim never supplies process authority."""
import contextlib
import ctypes
import fcntl
import json
import os
import re
import select
import socket
import struct
import sys
import time

MAX_PIDS = 16384
MAX_FDS = 1 << 22
MAX_BYTES = 1 << 20
MAX_LINE = 4096
MAX_OUTPUT = 65536
MAX_CHAIN = 64
PREFIX = "Native process proof diagnostic: "


class Refusal(Exception):
    def __init__(self, stage, reason, error=0):
        self.stage, self.reason, self.error = stage, reason, error


def require(value, stage, reason):
    if not value:
        raise Refusal(stage, reason)


def decimal(text, maximum):
    require(bool(re.fullmatch(r"[0-9]+", text)), "arguments", "invalid_arguments")
    value = int(text)
    require(value <= maximum, "arguments", "invalid_arguments")
    return value


def live(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return not poll.poll(0)


class Proof:
    def __init__(self):
        self.deadline = time.monotonic() + 0.6
        self.uid = os.getuid()
        self.resources = contextlib.ExitStack()
        self.census_attempts = 0
        self.census_refusals = []

    def prepare(self):
        require(sys.platform == "linux" and hasattr(os, "pidfd_open"), "startup", "process_unavailable")
        self.root = self.keep(os.open("/proc", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC))
        # fstatfs authenticates the root before any purported kernel text is
        # read. Linux 64-bit statfs is <=256 bytes on the supported architectures.
        require(sys.maxsize == (1 << 63) - 1, "startup", "process_unavailable")
        libc = ctypes.CDLL(None, use_errno=True)
        libc.fstatfs.argtypes = [ctypes.c_int, ctypes.c_void_p]
        libc.fstatfs.restype = ctypes.c_int
        filesystem = ctypes.create_string_buffer(256)
        require(libc.fstatfs(self.root, filesystem) == 0 and
                ctypes.c_long.from_buffer(filesystem).value == 0x9fa0,
                "census", "process_census_unavailable")
        # A partial PID namespace cannot prove unique socket ownership: another
        # namespace can retain an FD invisible here. Require the actual kernel
        # initial namespace, not NS_GET_PARENT's ambiguous EPERM response.
        self.proc_mounts = self.read(self.root, "self/mountinfo")
        self.namespace()
        # A filtered census cannot establish unique ownership. Never guess from
        # the visible subset. Only unfiltered, unshadowed host procfs is supported.
        mounts = self.read(self.root, "self/mounts").decode("utf-8", "strict").splitlines()
        proc = [row.split() for row in mounts if len(row.split()) >= 4 and row.split()[1] == "/proc"]
        require(len(proc) == 1 and proc[0][2] == "proc", "census", "process_census_changed")
        require(all(not opt.startswith("hidepid=") or opt == "hidepid=0"
                    for opt in proc[0][3].split(",")), "census", "process_unavailable")
        self.boot = self.read(self.root, "sys/kernel/random/boot_id").decode("ascii").strip()
        require(bool(re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", self.boot)),
                "process", "process_unavailable")
        boot = [row.split()[1] for row in self.read(self.root, "stat").decode("ascii").splitlines()
                if row.startswith("btime ")]
        require(len(boot) == 1, "process", "process_unavailable")
        self.seconds = decimal(boot[0], (1 << 63) - 1)
        self.hz = os.sysconf("SC_CLK_TCK")
        require(0 < self.hz <= 1000000, "process", "process_unavailable")
        self.pins = {}

    def namespace(self):
        require(os.readlink("self", dir_fd=self.root) == str(os.getpid()),
                "census", "unsupported_pid_namespace")
        fd = os.open("self/ns/pid", os.O_RDONLY | os.O_CLOEXEC, dir_fd=self.root)
        try:
            # Kernel v5.3+ PROC_PID_INIT_INO; NS_GET_NSTYPE verifies nsfs
            # rather than trusting a user-authored symlink or inode number.
            require(fcntl.ioctl(fd, 0xb703) == 0x20000000 and
                    os.fstat(fd).st_ino == 0xEFFFFFFC,
                    "census", "unsupported_pid_namespace")
        finally:
            os.close(fd)
        mounts = self.read(self.root, "self/mountinfo")
        rows = [row.split() for row in mounts.decode("ascii", "strict").splitlines()]
        # Refuse nested bind mounts that could substitute an initial namespace
        # handle or hide a process/FD table. Decode mountinfo's kernel escapes.
        paths = [re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), row[4])
                 for row in rows if len(row) >= 10]
        require(mounts == self.proc_mounts and not any(path.startswith("/proc/") for path in paths),
                "census", "process_census_unavailable")

    def __enter__(self):
        try:
            self.prepare()
            return self
        except BaseException:
            self.resources.close()
            raise

    def __exit__(self, *_):
        self.resources.close()

    def keep(self, fd):
        self.resources.callback(os.close, fd)
        return fd

    def bound(self):
        require(time.monotonic() < self.deadline, "completion", "budget_exhausted")

    def read(self, directory, name, limit=MAX_BYTES):
        self.bound()
        fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=directory)
        try:
            data = bytearray()
            while len(data) <= limit:
                self.bound()
                chunk = os.read(fd, min(65536, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            require(len(data) <= limit, "process", "process_unavailable")
            return bytes(data)
        finally:
            os.close(fd)

    def entries(self, directory, maximum):
        self.bound()
        names = os.listdir(directory)
        self.bound()
        values = sorted(int(name) for name in names if re.fullmatch(r"[1-9][0-9]*", name))
        require(len(values) <= maximum, "census", "process_census_changed")
        return values

    def identity(self, directory, pid):
        stat = self.read(directory, "stat", 65536)
        end = stat.rfind(b")")
        require(end > 0 and stat[:stat.index(b"(")].strip() == str(pid).encode(),
                "process", "process_unavailable")
        fields = stat[end + 2:].split()
        require(len(fields) >= 20, "process", "process_unavailable")
        ticks = int(fields[19])
        ppid = int(fields[1])
        require(ticks >= 0 and 0 <= ppid <= 2147483647, "process", "process_unavailable")
        rows = self.read(directory, "status", 65536).decode("utf-8", "strict").splitlines()
        owners = [row.split()[1:] for row in rows if row.startswith("Uid:")]
        require(len(owners) == 1 and len(owners[0]) == 4, "process", "process_unavailable")
        uids = tuple(int(uid) for uid in owners[0])
        return {"pid": pid, "ppid": ppid, "uid": uids[1],
                "birth": [str(self.seconds + ticks // self.hz), str(ticks % self.hz * 1000000 // self.hz)],
                "kernelIdentity": f"{self.boot}:{os.fstat(directory).st_ino}:{ticks}"}, (
                    fields[0] if fields[0] in (b"Z", b"X", b"x") else b"live"), uids

    def pin(self, pid):
        self.bound()
        if pid not in self.pins:
            require(1 <= pid <= 2147483647, "process", "process_unavailable")
            directory = self.keep(os.open(str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                                          os.O_NOFOLLOW, dir_fd=self.root))
            before = self.identity(directory, pid)
            handle = self.keep(os.pidfd_open(pid, 0))
            after = self.identity(directory, pid)
            require(before == after and live(handle), "process", "process_changed")
            self.pins[pid] = (directory, handle, before)
        directory, handle, original = self.pins[pid]
        require(live(handle) and self.identity(directory, pid) == original, "process", "process_changed")
        return directory, original

    def tcp(self, client, server):
        self.bound()
        # Linux uapi inet_diag_req_v2 + inet_diag_sockid, with no requested
        # cookie so the kernel returns the connection's actual lifetime cookie.
        request = struct.pack("=BBBBI", socket.AF_INET, socket.IPPROTO_TCP, 0, 0, 2)
        request += struct.pack("!HH", client, server)
        address = socket.inet_aton("127.0.0.1") + bytes(12)
        request += address + address + struct.pack("=III", 0, 0xffffffff, 0xffffffff)
        with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW | socket.SOCK_CLOEXEC, 4) as net:
            net.settimeout(max(0.001, self.deadline - time.monotonic()))
            net.bind((0, 0))
            net.sendto(struct.pack("=IHHII", 16 + len(request), 20, 1, 1, 0) + request, (0, 0))
            data, _, flags, sender = net.recvmsg(65536)
            require(sender[0] == 0 and not flags & socket.MSG_TRUNC, "fd_socket", "socket_unavailable")
        self.bound()
        require(len(data) >= 16, "fd_socket", "socket_unavailable")
        length, kind, _, sequence, _ = struct.unpack_from("=IHHII", data)
        require(sequence == 1 and kind == 20 and 88 <= length <= len(data),
                "fd_socket", "socket_unavailable")
        reply = data[16:length]
        require(reply[0] == socket.AF_INET and reply[1] == 1 and reply[4:40] == request[8:44],
                "fd_socket", "socket_unavailable")
        cookie = struct.unpack_from("=II", reply, 44)
        uid, inode = struct.unpack_from("=II", reply, 64)
        require(uid == self.uid and inode > 0 and cookie not in ((0, 0), (0xffffffff, 0xffffffff)),
                "socket_owner", "socket_identity_invalid")
        return inode, cookie

    def census(self, inode):
        # Churn discards the entire census. No owner, partial FD table or PID
        # omission survives an attempt; the original request deadline still binds.
        while True:
            self.bound()
            require(self.census_attempts < 16, "census", "attempts_exhausted")
            self.census_attempts += 1
            try:
                return self.complete_census(inode)
            except (FileNotFoundError, ProcessLookupError) as error:
                reason, number = "process_census_changed", error.errno
            except Refusal as error:
                if error.reason != "process_census_changed":
                    raise
                reason, number = error.reason, error.error
            self.census_refusals.append({"attempt": self.census_attempts,
                                        "reason": reason, "errno": number})

    def complete_census(self, inode):
        owners = {}
        seen = set()
        pids = self.entries(self.root, MAX_PIDS)
        for pid in pids:
            self.bound()
            # Even a zombie leader can retain live threads with private FD
            # tables. Skip only a process whose pidfd proves whole-group exit.
            directory = os.open(str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                                os.O_NOFOLLOW, dir_fd=self.root)
            try:
                before = self.identity(directory, pid)
                handle = os.pidfd_open(pid, 0)
                try:
                    if not live(handle):
                        continue
                    require(before == self.identity(directory, pid), "process", "process_changed")
                    task = os.open("task", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                                   os.O_NOFOLLOW, dir_fd=directory)
                    try:
                        tids = self.entries(task, MAX_PIDS)
                        require(bool(tids), "fd_list", "fd_list_unavailable")
                        found = False
                        for tid in tids:
                            thread = os.open(str(tid), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                                             os.O_NOFOLLOW, dir_fd=task)
                            try:
                                original = self.identity(thread, tid)
                                fds = os.open("fd", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                                              os.O_NOFOLLOW, dir_fd=thread)
                                try:
                                    # Keep the iterator open during reads: our
                                    # own census descriptor must not disappear
                                    # between listing and readlink. Include FD 0.
                                    with os.scandir(fds) as table:
                                        count = 0
                                        for entry in table:
                                            self.bound()
                                            require(bool(re.fullmatch(r"0|[1-9][0-9]*", entry.name)),
                                                    "fd_list", "fd_record_invalid")
                                            count += 1
                                            require(count <= MAX_FDS, "fd_list", "fd_list_bounds")
                                            target = os.readlink(entry.name, dir_fd=fds)
                                            if target == f"socket:[{inode}]":
                                                # Sharing is terminal as soon as
                                                # observed, even if a later entry
                                                # would otherwise trigger churn.
                                                require(not seen or pid in seen, "socket_owner", "multiple_owners")
                                                seen.add(pid)
                                                found = True
                                finally:
                                    os.close(fds)
                                require(original == self.identity(thread, tid), "process", "process_changed")
                            except PermissionError:
                                # Darwin also scans every readable foreign table.
                                # Only an unreadable, freshly confirmed foreign
                                # identity may be ignored. Same-user uncertainty
                                # and any observed shared ownership refuse.
                                if (found or self.uid in before[2][:2] or
                                        self.uid in original[2][:2] or
                                        original != self.identity(thread, tid)):
                                    raise Refusal("fd_list", "fd_list_unavailable", 13)
                            finally:
                                os.close(thread)
                        require(tids == self.entries(task, MAX_PIDS), "census", "process_census_changed")
                    finally:
                        os.close(task)
                    require(live(handle) and before == self.identity(directory, pid),
                            "process", "process_changed")
                    if found:
                        owners[pid] = before[0]
                finally:
                    os.close(handle)
            finally:
                os.close(directory)
        require(pids == self.entries(self.root, MAX_PIDS), "census", "process_census_changed")
        require(len(owners) == 1, "socket_owner", "multiple_owners" if owners else "owner_not_found")
        return next(iter(owners.values()))

    def ancestry(self, owner):
        chain = []
        current = owner["pid"]
        while current > 1:
            require(len(chain) < MAX_CHAIN and current not in [row["pid"] for row in chain],
                    "ancestry", "ancestry_cycle")
            _, (identity, state, _) = self.pin(current)
            require(state not in (b"Z", b"X", b"x"), "ancestry", "ancestor_exited")
            chain.append({key: identity[key] for key in ("pid", "ppid", "birth", "kernelIdentity")})
            current = identity["ppid"]
        require(bool(chain), "ancestry", "ancestry_unavailable")
        return chain

    def socket_proof(self, args):
        require(len(args) in (2, 6, 7), "arguments", "invalid_arguments")
        client, server = [decimal(value, 65535) for value in args[:2]]
        require(client > 0 and server > 0, "arguments", "invalid_arguments")
        target = self.tcp(client, server)
        owner = self.census(target[0])
        directory, (pinned, state, uids) = self.pin(owner["pid"])
        require(owner == pinned and state not in (b"Z", b"X", b"x") and all(uid == self.uid for uid in uids),
                "owner_pin", "process_changed")
        socket_id = f"{target[0]}:{target[1][0]}:{target[1][1]}"
        owner = {key: owner[key] for key in ("pid", "uid", "birth", "kernelIdentity")}
        owner["socket"] = socket_id
        if len(args) >= 6:
            require([str(owner["pid"]), *owner["birth"], socket_id] == args[2:6],
                    "owner_pin", "process_changed")
            # Linux fences include the boot and proc directory identity too.
            require(len(args) == 7 and args[6] == owner["kernelIdentity"], "owner_pin", "process_changed")
        chain = self.ancestry(owner)
        require(self.census(target[0]) == pinned, "socket_owner", "process_changed")
        require(self.ancestry(owner) == chain, "ancestry", "ancestry_changed")
        require(self.tcp(client, server) == target, "final_socket", "socket_mismatch")
        self.pin(owner["pid"])
        self.bound()
        return {"schemaVersion": 1, "owner": owner, "ancestors": chain}

    def record(self, pid):
        directory, (identity, state, uids) = self.pin(pid)
        require(state not in (b"Z", b"X", b"x") and all(uid == self.uid for uid in uids),
                "process", "process_unavailable")
        executable = os.readlink("exe", dir_fd=directory)
        require(executable.startswith("/") and not executable.endswith(" (deleted)") and
                len(executable.encode("utf-8")) <= 4096, "executable", "executable_unavailable")
        arguments = self.read(directory, "cmdline")
        require(not arguments or arguments.endswith(b"\0"), "argv", "argv_unavailable")
        argv = arguments[:-1].split(b"\0") if arguments else []
        require(all(len(value) <= 4096 for value in argv[:2]), "argv", "argv_unavailable")
        self.pin(pid)
        return {**identity, "executable": executable,
                "argv": [value.decode("utf-8", "strict") for value in argv[:2]]}, argv

    def processes(self, args):
        claude = args[0] == "--claude-processes"
        require(len(args) == (4 if claude else 3), "arguments", "invalid_arguments")
        pids = [decimal(value, 2147483647) for value in args[1:]]
        require(all(pid > 1 for pid in pids) and len(set(pids)) == len(pids), "arguments", "invalid_arguments")
        records = [self.record(pid) for pid in pids]
        if claude:
            require(records[1][1][2:3] == [b"claude"] and records[1][0]["ppid"] == pids[0] and
                    records[2][0]["ppid"] == pids[1], "process", "process_changed")
            require(os.getpgid(pids[1]) == pids[1] and os.getpgid(pids[2]) == pids[1],
                    "process", "process_changed")
        require([self.record(pid) for pid in pids] == records, "process", "process_changed")
        self.bound()
        return {"schemaVersion": 1, "processes": [record[0] for record in records]}

    def birth(self, args):
        require(len(args) == 2, "arguments", "invalid_arguments")
        pid = decimal(args[1], 2147483647)
        require(pid > 1, "arguments", "invalid_arguments")
        _, (identity, state, uids) = self.pin(pid)
        require(state not in (b"Z", b"X", b"x") and all(uid == self.uid for uid in uids),
                "process", "process_unavailable")
        self.pin(pid)
        return {"schemaVersion": 1, "process": {key: identity[key] for key in
                ("pid", "uid", "birth", "kernelIdentity")}}

    def cwd(self, args):
        require(len(args) == 2, "arguments", "invalid_arguments")
        pid = decimal(args[1], 2147483647)
        require(pid > 1, "arguments", "invalid_arguments")
        directory, (identity, state, uids) = self.pin(pid)
        require(state not in (b"Z", b"X", b"x") and all(uid == self.uid for uid in uids),
                "process", "process_unavailable")
        before = os.readlink("cwd", dir_fd=directory)
        require(before.startswith("/") and len(before.encode("utf-8", "strict")) <= 4096,
                "process", "process_unavailable")
        require(os.readlink("cwd", dir_fd=directory) == before, "process", "process_changed")
        self.pin(pid)
        self.bound()
        return {"schemaVersion": 1, "process": {key: identity[key] for key in
                ("pid", "uid", "birth", "kernelIdentity")}, "cwd": before}

    def unix_listener(self, path):
        # unix_diag_req / unix_diag_msg, UAPI linux/unix_diag.h. Request
        # kernel names and lifetime cookies, never a caller's filesystem inode.
        request = struct.pack("=BBHIIIII", socket.AF_UNIX, 0, 0, 1 << 10, 0, 1,
                              0xffffffff, 0xffffffff)
        found = []
        count = 0
        with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW | socket.SOCK_CLOEXEC, 4) as net:
            net.bind((0, 0))
            net.sendto(struct.pack("=IHHII", 16 + len(request), 20, 0x301, 2, 0) + request, (0, 0))
            done = False
            while not done:
                self.bound()
                net.settimeout(max(0.001, self.deadline - time.monotonic()))
                data, _, flags, sender = net.recvmsg(65536)
                require(sender[0] == 0 and not flags & socket.MSG_TRUNC,
                        "fd_socket", "socket_unavailable")
                offset = 0
                while offset < len(data):
                    require(len(data) - offset >= 16, "fd_socket", "socket_unavailable")
                    length, kind, flags, sequence, _ = struct.unpack_from("=IHHII", data, offset)
                    require(sequence == 2 and not flags & 0x10 and 16 <= length <= len(data) - offset,
                            "fd_socket", "socket_unavailable")
                    message = data[offset + 16:offset + length]
                    offset += (length + 3) & ~3
                    if kind == 3:
                        require(not message or (len(message) >= 4 and struct.unpack_from("=i", message)[0] == 0),
                                "fd_socket", "socket_unavailable")
                        done = True
                        continue
                    require(kind == 20 and len(message) >= 16, "fd_socket", "socket_unavailable")
                    family, kind, state, _, inode, cookie0, cookie1 = struct.unpack_from("=BBBBIII", message)
                    count += 1
                    require(count <= MAX_FDS, "fd_list", "fd_list_bounds")
                    attrs = 16
                    name = None
                    while attrs < len(message):
                        require(len(message) - attrs >= 4, "fd_socket", "socket_unavailable")
                        size, attribute = struct.unpack_from("=HH", message, attrs)
                        require(4 <= size <= len(message) - attrs, "fd_socket", "socket_unavailable")
                        if attribute == 0:  # UAPI UNIX_DIAG_NAME starts at zero.
                            require(name is None, "fd_socket", "socket_unavailable")
                            name = message[attrs + 4:attrs + size]
                        attrs += (size + 3) & ~3
                    if family == socket.AF_UNIX and kind == socket.SOCK_STREAM and state == 10 and name == path + b"\0":
                        require(inode > 0 and (cookie0, cookie1) not in ((0, 0), (0xffffffff, 0xffffffff)),
                                "socket_owner", "socket_identity_invalid")
                        found.append((inode, (cookie0, cookie1)))
        require(len(found) == 1, "socket_owner", "multiple_owners" if found else "owner_not_found")
        return found[0]

    def codex_server(self, args):
        require(len(args) == 4, "arguments", "invalid_arguments")
        pid = decimal(args[1], 2147483647)
        require(pid > 1 and all(bool(re.fullmatch(r"(?:[0-9a-f]{2})+", text)) for text in args[2:]),
                "arguments", "invalid_arguments")
        endpoint, path = [bytes.fromhex(text) for text in args[2:]]
        require(endpoint.startswith(b"unix:///") and path.startswith(b"/") and
                0 < len(path) <= 107 and len(endpoint) <= 114 and
                all(byte >= 32 and byte != 127 for byte in endpoint + path),
                "arguments", "invalid_arguments")
        endpoint.decode("utf-8", "strict")
        path.decode("utf-8", "strict")
        original = self.record(pid)
        require(os.path.basename(original[0]["executable"]) == "codex" and
                original[1][-3:] == [b"app-server", b"--listen", endpoint], "argv", "argv_invalid")
        target = self.unix_listener(path)
        owner = self.census(target[0])
        require(owner["pid"] == pid and owner["kernelIdentity"] == original[0]["kernelIdentity"],
                "owner_pin", "owner_mismatch")
        require(self.record(pid) == original and self.unix_listener(path) == target and
                self.census(target[0]) == owner, "final_socket", "socket_mismatch")
        return self.birth(["--birth", str(pid)])


def execute(args):
    diagnostics = args[-1:] == ["--diagnostics"]
    if diagnostics:
        args = args[:-1]
    proof = Proof()
    def retries():
        return "".join(PREFIX + json.dumps({"schemaVersion": 1, "stage": "census",
                       **refusal, "retry": True}, separators=(",", ":")) + "\n"
                       for refusal in proof.census_refusals) if diagnostics else ""
    try:
        with proof:
            if args[:1] in (["--processes"], ["--claude-processes"]):
                result = proof.processes(args)
            elif args[:1] == ["--birth"]:
                result = proof.birth(args)
            elif args[:1] == ["--cwd"]:
                result = proof.cwd(args)
            elif args[:1] == ["--codex-server"]:
                result = proof.codex_server(args)
            else:
                result = proof.socket_proof(args)
            proof.namespace()  # Recheck the procfs boundary before releasing facts.
            if proof.census_attempts:
                result["census"] = {"attempts": proof.census_attempts, "refusals": proof.census_refusals}
        return result, retries()
    except Exception as error:
        refusal = error if isinstance(error, Refusal) else Refusal("process", "process_unavailable", getattr(error, "errno", 0) or 0)
        detail = {"schemaVersion": 1, "stage": refusal.stage, "reason": refusal.reason,
                  "errno": max(0, refusal.error), "attempt": proof.census_attempts, "retry": False}
        explanation = ("Linux native worker proof requires the initial PID namespace; containers are unsupported"
                       if refusal.reason == "unsupported_pid_namespace" else "Native process proof unavailable")
        return None, retries() + (PREFIX + json.dumps(detail, separators=(",", ":")) + "\n" if diagnostics else "") + explanation + "\n"


def main():
    if sys.argv[1:] != ["--serve"]:
        result, error = execute(sys.argv[1:])
        if result is None:
            sys.stderr.write(error)
            return 1
        if error:
            sys.stderr.write(error)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    previous = 0
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE)
        if not line:
            return 0
        if (not line.endswith(b"\n") or len(line) >= MAX_LINE or
                any(byte < 32 or byte > 126 for byte in line[:-1])):
            return 1
        tokens = line[:-1].decode("ascii").split(" ")
        if len(tokens) < 2 or len(tokens) > 10 or any(not token for token in tokens):
            return 1
        try:
            request_id = decimal(tokens[0], 9007199254740991)
        except Refusal:
            return 1
        if request_id <= previous:
            return 1
        previous = request_id
        result, error = execute(tokens[1:])
        reply = json.dumps({"id": request_id, "ok": result is not None, "result": result, "stderr": error}, separators=(",", ":"))
        if len(reply.encode("utf-8")) > MAX_OUTPUT:
            return 1
        print(reply, flush=True)


if __name__ == "__main__":
    sys.exit(main())
