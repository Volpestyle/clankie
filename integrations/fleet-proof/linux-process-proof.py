#!/usr/bin/python3 -I
"""Read-only Linux kernel facts. A claim never supplies process authority."""
import contextlib
import ctypes
import errno
import fcntl
import json
import os
import re
import select
import socket
import stat
import struct
import sys
import time

MAX_PIDS = 16384
MAX_FDS = 1 << 22
MAX_BYTES = 1 << 20
MAX_LINE = 4096
MAX_OUTPUT = 65536
MAX_CHAIN = 64
MAX_ROUNDS = 1024
MAX_DENIALS = 3
PREFIX = "Native process proof diagnostic: "
NOTE = "Native process proof note: "
# systemd hosts (Ubuntu among them) mount binfmt_misc on demand at this one
# path: an autofs trigger with the binfmt_misc filesystem stacked on it. Neither
# filesystem can hold a PID directory, FD table or namespace handle, and this
# helper reads nothing under /proc/sys/fs, so they shadow nothing it proves.
KERNEL_PROC_MOUNTS = {("/proc/sys/fs/binfmt_misc", "autofs"), ("/proc/sys/fs/binfmt_misc", "binfmt_misc")}
# The user's own service manager (#648). Its FD table is unreadable to the same
# uid, so the census would refuse every request on a host with a systemd user
# session. It may be passed over only once PID 1 itself, over the system bus,
# attests that it is user@U.service's running main process (ADR 0348 amendment).
NS_GET_NSTYPE = 0xb703
CLONE_NEWCGROUP, CLONE_NEWUSER = 0x02000000, 0x10000000
PROC_CGROUP_INIT_INO, PROC_USER_INIT_INO = 0xEFFFFFFB, 0xEFFFFFFD
SYSTEM_BUS = "/run/dbus/system_bus_socket"
MAX_BUS_MESSAGE = 65536
MAX_BUS_SIGNALS = 64
VENDOR_UNIT_DIRECTORIES = ("/usr/lib/systemd/system/", "/lib/systemd/system/")
# The fixed diagnostic codes naming why a denied table was not the attested manager.
MANAGER_CODES = frozenset(("cgroup_namespace", "user_namespace", "cgroup_layout", "multiple_candidates",
                           "bus_unavailable", "bus_not_root", "owner_not_pid1", "unit_not_running",
                           "main_pid_mismatch", "notify_access", "unit_modified", "changed", "deadline"))


class Refusal(Exception):
    def __init__(self, stage, reason, error=0, denied=None):
        self.stage, self.reason, self.error = stage, reason, error
        # Diagnostics only: the same-user process whose FD table was denied.
        self.denied = denied
        # Diagnostics only: why that process was not the attested service manager.
        self.manager = None


class Unattested(Exception):
    """The denied process is not proven to be the user's service manager; a fixed code says why."""

    def __init__(self, code, name=""):
        super().__init__(code)
        self.code = code
        # The D-Bus error name of a `bus_error`; never shown, only mapped to a fixed code.
        self.name = name


class SystemBus:
    """The system bus at its fixed path, spoken by a bounded, call-and-reply D-Bus client.

    The broker is authenticated by its kernel peer credentials (uid 0, which is real
    root once the initial user namespace is proven). Calls go one at a time on this one
    connection; every reply must answer exactly the call just sent, from the expected
    sender, with the expected signature. Any error, reconnect or surprise ends the
    exemption: nothing is retried, and no other bus, address or tool is consulted.
    """

    def __init__(self, proof):
        self.proof = proof
        self.serial = 0
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC)
        proof.resources.callback(self.sock.close)
        try:
            self.timeout()
            self.sock.connect(SYSTEM_BUS)
            _, uid, _ = struct.unpack("=iII", self.sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                                                   struct.calcsize("=iII")))
        except OSError as error:
            raise Unattested("bus_unavailable") from error
        if uid != 0:
            # A broker that created its socket after dropping to its own user
            # (not socket-activated by PID 1) is refused too: safe, never trusted.
            raise Unattested("bus_not_root")
        self.authenticate()
        self.name = self.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                              "Hello", "", [], "s")
        if not re.fullmatch(r":[0-9]+\.[0-9]+", self.name):
            raise Unattested("bus_unavailable")

    def timeout(self):
        self.proof.bound()
        self.sock.settimeout(max(0.001, self.proof.deadline - time.monotonic()))

    def recv(self, count):
        data = bytearray()
        while len(data) < count:
            self.timeout()
            try:
                chunk = self.sock.recv(count - len(data))
            except OSError as error:
                raise Unattested("bus_unavailable") from error
            if not chunk:
                raise Unattested("bus_unavailable")
            data.extend(chunk)
        return bytes(data)

    def send(self, data):
        self.timeout()
        try:
            self.sock.sendall(data)
        except OSError as error:
            raise Unattested("bus_unavailable") from error

    def authenticate(self):
        # SASL EXTERNAL: the broker checks our kernel uid; we claim only that number.
        self.send(b"\0AUTH EXTERNAL " + str(os.getuid()).encode().hex().encode() + b"\r\n")
        line = bytearray()
        while not line.endswith(b"\r\n"):
            if len(line) > 256:
                raise Unattested("bus_unavailable")
            line.extend(self.recv(1))
        if not re.fullmatch(rb"OK [0-9a-f]{32}\r\n", bytes(line)):
            raise Unattested("bus_unavailable")
        self.send(b"BEGIN\r\n")

    @staticmethod
    def pad(data, size):
        data.extend(b"\0" * (-len(data) % size))

    @classmethod
    def string(cls, data, text, code="s"):
        raw = text.encode("utf-8")
        if code == "g":
            data.append(len(raw))
        else:
            cls.pad(data, 4)
            data.extend(struct.pack("<I", len(raw)))
        data.extend(raw + b"\0")

    def call(self, destination, path, interface, member, signature, args, reply, decode=None):
        self.serial += 1
        body = bytearray()
        for value in args:
            self.string(body, value)
        message = bytearray(b"l\x01\x00\x01" + struct.pack("<II", len(body), self.serial) + b"\0\0\0\0")
        fields = [(1, "o", path), (2, "s", interface), (3, "s", member), (6, "s", destination)]
        if signature:
            fields.append((8, "g", signature))
        for code, kind, value in fields:
            self.pad(message, 8)
            message.append(code)
            self.string(message, kind, "g")
            self.string(message, value, kind)
        struct.pack_into("<I", message, 12, len(message) - 16)
        self.pad(message, 8)
        self.send(bytes(message + body))
        for _ in range(MAX_BUS_SIGNALS):
            kind, headers, payload = self.receive()
            if kind == 4:
                continue  # A signal (NameAcquired) answers nothing; it is never read.
            if kind not in (2, 3) or headers.get(5) != self.serial:
                raise Unattested("bus_unavailable")
            # Only the exact destination answers: the broker for its own calls, the
            # pinned unique owner for systemd's. A well-known name is never a sender.
            if headers.get(7) != destination:
                raise Unattested("bus_unavailable")
            if kind == 3:
                raise Unattested("bus_error", str(headers.get(4, ""))[:128])
            if headers.get(8, "") != reply:
                raise Unattested("bus_unavailable")
            value, end = self.value(payload, 0, decode or reply)
            if end != len(payload):
                raise Unattested("bus_unavailable")
            return value
        raise Unattested("bus_unavailable")

    def receive(self):
        fixed = self.recv(16)
        if fixed[0:1] != b"l" or fixed[3] != 1:
            raise Unattested("bus_unavailable")
        length, serial, size = struct.unpack_from("<III", fixed, 4)
        start = 16 + size + (-(16 + size) % 8)
        if serial == 0 or size > 4096 or start + length > MAX_BUS_MESSAGE:
            raise Unattested("bus_unavailable")
        message = fixed + self.recv(start - 16 + length)
        headers = {}
        offset = 16
        while offset < 16 + size:
            offset += -offset % 8
            code = message[offset]
            kind, offset = self.value(message, offset + 1, "g")
            if code in headers or kind not in ("s", "o", "g", "u"):
                raise Unattested("bus_unavailable")
            headers[code], offset = self.value(message, offset, kind)
        if offset != 16 + size:
            raise Unattested("bus_unavailable")
        return fixed[1], headers, message[start:]

    def value(self, data, offset, signature):
        """Decode one complete value of a fixed, small set of types; anything else refuses."""
        def need(count):
            if offset + count > len(data):
                raise Unattested("bus_unavailable")
        if signature in ("s", "o"):
            offset += -offset % 4
            need(4)
            (size,) = struct.unpack_from("<I", data, offset)
            need(4 + size + 1)
            raw = data[offset + 4:offset + 4 + size]
            if data[offset + 4 + size] != 0 or b"\0" in raw:
                raise Unattested("bus_unavailable")
            return raw.decode("utf-8", "strict"), offset + 5 + size
        if signature == "g":
            need(1)
            size = data[offset]
            need(1 + size + 1)
            raw = data[offset + 1:offset + 1 + size]
            if data[offset + 1 + size] != 0 or not re.fullmatch(rb"[a-z()]*", raw):
                raise Unattested("bus_unavailable")
            return raw.decode("ascii"), offset + 2 + size
        if signature in ("u", "b"):
            offset += -offset % 4
            need(4)
            (number,) = struct.unpack_from("<I", data, offset)
            if signature == "b" and number > 1:
                raise Unattested("bus_unavailable")
            return (bool(number) if signature == "b" else number), offset + 4
        if signature == "as":
            offset += -offset % 4
            need(4)
            (size,) = struct.unpack_from("<I", data, offset)
            offset += 4
            end = offset + size
            if end > len(data):
                raise Unattested("bus_unavailable")
            items = []
            while offset < end:
                if len(items) >= 256:
                    raise Unattested("bus_unavailable")
                item, offset = self.value(data, offset, "s")
                items.append(item)
            if offset != end:
                raise Unattested("bus_unavailable")
            return items, offset
        if signature.startswith("v:"):
            kind, offset = self.value(data, offset, "g")
            if kind != signature[2:]:
                raise Unattested("bus_unavailable")
            return self.value(data, offset, kind)
        raise Unattested("bus_unavailable")


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
        # Diagnostics only: the service manager the census passed over (#648).
        self.manager = None

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
        # The filesystem type follows the "-" that ends the optional fields.
        nested = [(re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), row[4]),
                   row[row.index("-", 6) + 1] if "-" in row[6:-3] else None)
                  for row in rows if len(row) >= 10]
        require(mounts == self.proc_mounts and
                all(not path.startswith("/proc/") or (path, kind) in KERNEL_PROC_MOUNTS
                    for path, kind in nested),
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

    def listing(self):
        # Each /proc entry with its directory inode. A live process keeps its
        # cached /proc/PID dentry, and a reused PID gets a new inode, so a
        # (PID, inode) pair names one process instance across listings.
        self.bound()
        with os.scandir(self.root) as table:
            found = {int(entry.name): entry.inode() for entry in table
                     if re.fullmatch(r"[1-9][0-9]*", entry.name)}
        self.bound()
        require(len(found) <= MAX_PIDS, "census", "process_census_changed")
        return found

    def census(self, inode):
        # Reads build up across /proc listings (#440): each listing reads only
        # the process instances not yet read, and the census settles on the
        # first listing in which every live instance has been read. A birth or
        # PID reuse is one more process to read, never a skipped one; a process
        # whose read churned is read again. Discarding the whole census is left
        # for churn in a process the socket was seen in, or an owner that left.
        # No owner, partial FD table or new PID survives an attempt; the
        # deadline still binds.
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

    def exited(self, pid, handle=None, wait=0):
        # Confirmed exit only: the pidfd proves whole-group exit, or the kernel
        # has no such PID at all. Anything else is not an exit.
        if handle is not None:
            if wait:
                poll = select.poll()
                poll.register(handle, select.POLLIN)
                self.bound()
                poll.poll(max(1, int(min(wait, self.deadline - time.monotonic()) * 1000)))
            return not live(handle)
        try:
            handle = self.pidfd(pid)
        except ProcessLookupError:
            return True
        try:
            return not live(handle)
        finally:
            os.close(handle)

    def exiting(self, thread):
        # PF_EXITING in a thread's kernel flags: it has entered do_exit and
        # never returns to user space. A hint to wait, never itself an exit.
        stat = self.read(thread, "stat", 65536)
        fields = stat[stat.rfind(b")") + 2:].split()
        return len(fields) > 6 and bool(int(fields[6]) & 0x4)

    def pidfd(self, pid):
        try:
            return os.pidfd_open(pid, 0)
        except OSError as error:
            # EINVAL: the PID now names a thread of another process, so the
            # listed process is gone (/proc/TID opens though it is never listed).
            if error.errno == errno.EINVAL:
                raise ProcessLookupError(errno.ESRCH, "listed process exited") from error
            raise

    def complete_census(self, inode):
        owners = {}
        seen = set()
        read = {}
        denials = {}
        # Instances shaped like the user's service manager, and the one whose every FD
        # table stayed denied: passed over only if PID 1 attests it at settlement.
        shaped = {}
        deferred = {}
        # Listed instances whose read did not complete. Each must be read, or
        # leave with a confirmed exit, before the census settles: absence from
        # a later listing alone proves nothing.
        unresolved = {}
        for _ in range(MAX_ROUNDS):
            listed = self.listing()
            # An owner that left, or whose PID now names another process,
            # discards the attempt: its socket may have moved with it.
            require(all(listed.get(pid) == read[pid] for pid in owners),
                    "census", "process_census_changed")
            for pid, instance in list(unresolved.items()):
                if listed.get(pid) == instance:
                    continue  # Still listed: read it again below.
                # A PID is reused only once its old process is reaped, so a new
                # instance (read below) also ends the old one.
                require(pid in listed or self.exited(pid), "census", "process_census_changed")
                del unresolved[pid]
            pending = [pid for pid in sorted(listed) if read.get(pid) != listed[pid]]
            if not pending:
                require(not unresolved, "census", "process_census_changed")
                if deferred:
                    self.pass_manager(deferred, shaped, listed)
                require(len(owners) == 1, "socket_owner", "multiple_owners" if owners else "owner_not_found")
                return next(iter(owners.values()))
            for pid in pending:
                self.bound()
                unresolved[pid] = listed[pid]
                try:
                    read[pid] = self.scan(pid, inode, seen, owners, shaped)
                    del unresolved[pid]
                except (FileNotFoundError, ProcessLookupError):
                    if pid in seen:
                        raise
                    if self.exited(pid):
                        # Gone, never seen holding the socket: what it held closed
                        # with it. A reused PID lists a new inode and is read.
                        read[pid] = listed[pid]
                        del unresolved[pid]
                except Refusal as error:
                    # A thread list that moved, or an identity that changed under
                    # the read (an orphan's new parent), is read again next
                    # listing, unless the socket was already seen in this process.
                    # So is a same-user table denied mid-exit or mid-exec, until
                    # it stays unreadable for MAX_DENIALS reads.
                    if pid in seen:
                        raise
                    if error.reason == "fd_list_unavailable" and error.error == errno.EACCES:
                        # Counted per instance: a reused PID starts afresh.
                        key = (pid, listed[pid])
                        denials[key] = denials.get(key, 0) + 1
                        if denials[key] >= MAX_DENIALS:
                            if shaped.get(pid) != listed[pid]:
                                raise
                            # Possibly the user's own service manager (#648): read on,
                            # and decide only once the whole census has been seen.
                            deferred[pid] = (listed[pid], error)
                            read[pid] = listed[pid]
                            del unresolved[pid]
                    elif error.reason not in ("process_census_changed", "process_changed"):
                        raise
        raise Refusal("census", "attempts_exhausted")

    def pass_manager(self, deferred, shaped, listed):
        """Pass over the one denied table only when it is PID 1's attested user manager."""
        pid, (instance, refusal) = next(iter(deferred.items()))
        try:
            if len(deferred) != 1 or set(shaped) != {pid} or listed.get(pid) != instance:
                raise Unattested("multiple_candidates")
            self.attest_manager(pid)
        except Unattested as error:
            refusal.manager = error.code if error.code in MANAGER_CODES else "bus_unavailable"
            raise refusal from None
        self.manager = {"pid": pid, "exempted": True}

    def scan(self, pid, inode, seen, owners, shaped):
        """Read one process's every thread FD table; return the inode of the instance read."""
        # Even a zombie leader can retain live threads with private FD
        # tables. Skip only a process whose pidfd proves whole-group exit.
        directory = os.open(str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                            os.O_NOFOLLOW, dir_fd=self.root)
        try:
            before = self.identity(directory, pid)
            instance = os.fstat(directory).st_ino
            # Every instance shaped like the user's service manager is counted, readable
            # or not: a second one makes the one exemption ambiguous, so it refuses.
            if self.manager_shaped(directory, before[0], before[2]):
                shaped[pid] = instance
            else:
                shaped.pop(pid, None)
            handle = self.pidfd(pid)
            try:
                if not live(handle):
                    return instance
                require(before == self.identity(directory, pid), "process", "process_changed")
                task = os.open("task", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                               os.O_NOFOLLOW, dir_fd=directory)
                try:
                    tids = self.entries(task, MAX_PIDS)
                    if not tids and pid not in seen and self.exited(pid, handle, wait=0.02):
                        return instance  # A dying process lists no threads (#440).
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
                            # and any observed shared ownership refuse. An exiting
                            # process's table turns unreadable once its memory is
                            # released, before its pidfd shows the group's exit;
                            # a thread already in do_exit (PF_EXITING) gets a short
                            # wait for that exit. Only a confirmed exit it never
                            # showed the socket in is skipped (#440).
                            if not found and pid not in seen and (
                                    self.exited(pid, handle) or
                                    (self.exiting(thread) and self.exited(pid, handle, wait=0.02))):
                                return instance
                            if (found or self.uid in before[2][:2] or
                                    self.uid in original[2][:2] or
                                    original != self.identity(thread, tid)):
                                raise Refusal("fd_list", "fd_list_unavailable", 13,
                                              self.denied(directory, pid, original[2]))
                        finally:
                            os.close(thread)
                    require(tids == self.entries(task, MAX_PIDS), "census", "process_census_changed")
                finally:
                    os.close(task)
                if not found and self.exited(pid, handle):
                    # It exited after its table showed no socket (#440).
                    return instance
                require(live(handle) and before == self.identity(directory, pid),
                        "process", "process_changed")
                if found:
                    owners[pid] = before[0]
                return instance
            finally:
                os.close(handle)
        finally:
            os.close(directory)

    def manager_shaped(self, directory, identity, uids):
        """Whether a process looks like the user's service manager. Shape is never proof."""
        if identity["ppid"] != 1 or any(uid != self.uid for uid in uids):
            return False
        expected = f"0::/user.slice/user-{self.uid}.slice/user@{self.uid}.service/init.scope\n"
        return self.read(directory, "cgroup", 4096) == expected.encode()

    def initial_namespaces(self):
        """The cgroup and user namespaces are the kernel's initial ones, proven through nsfs."""
        for name, kind, inode, code in (("cgroup", CLONE_NEWCGROUP, PROC_CGROUP_INIT_INO, "cgroup_namespace"),
                                        ("user", CLONE_NEWUSER, PROC_USER_INIT_INO, "user_namespace")):
            try:
                fd = os.open(f"self/ns/{name}", os.O_RDONLY | os.O_CLOEXEC, dir_fd=self.root)
            except OSError as error:
                raise Unattested(code) from error
            try:
                if fcntl.ioctl(fd, NS_GET_NSTYPE) != kind or os.fstat(fd).st_ino != inode:
                    raise Unattested(code)
            except OSError as error:
                raise Unattested(code) from error
            finally:
                os.close(fd)
        rows = self.read(self.root, "self/cgroup", 4096).decode("utf-8", "strict").splitlines()
        if len(rows) != 1 or not rows[0].startswith("0::/"):
            raise Unattested("cgroup_layout")

    def every_thread_denied(self, directory):
        """Every thread's FD table refuses this uid, as the census met it: at the listing
        (a non-dumpable process) or at the links (one holding capabilities this uid lacks,
        like newer systemd's CAP_WAKE_ALARM). One readable table is not this case."""
        task = os.open("task", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=directory)
        try:
            tids = self.entries(task, MAX_PIDS)
            for tid in tids:
                thread = os.open(str(tid), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                                 dir_fd=task)
                try:
                    fds = os.open("fd", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                                  dir_fd=thread)
                    try:
                        for name in os.listdir(fds)[:MAX_FDS]:
                            try:
                                os.readlink(name, dir_fd=fds)
                            except FileNotFoundError:
                                continue  # closed since the listing: says nothing either way
                    finally:
                        os.close(fds)
                    return False
                except PermissionError:
                    continue
                finally:
                    os.close(thread)
            return bool(tids) and tids == self.entries(task, MAX_PIDS)
        finally:
            os.close(task)

    @staticmethod
    def vendor_unit_file(path):
        """A unit file the distribution ships: root's, in its unit directory, writable only by root."""
        if not path.startswith(VENDOR_UNIT_DIRECTORIES) or "/." in path or "//" in path:
            return False
        real = os.path.realpath(path)
        if not real.startswith(VENDOR_UNIT_DIRECTORIES):
            return False
        current = "/"
        for part in ["", *real.strip("/").split("/")]:
            current = os.path.join(current, part) if part else current
            try:
                info = os.lstat(current)
            except OSError:
                return False
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                return False
        return stat.S_ISREG(info.st_mode)

    def systemd_owner(self, bus):
        """The unique bus name owning org.freedesktop.systemd1, proven by the broker to be PID 1."""
        try:
            owner = bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                             "GetNameOwner", "s", ["org.freedesktop.systemd1"], "s")
            if not re.fullmatch(r":[0-9]+\.[0-9]+", owner):
                raise Unattested("owner_not_pid1")
            pid = bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                           "GetConnectionUnixProcessID", "s", [owner], "u")
        except Unattested as error:
            raise Unattested("owner_not_pid1" if error.code == "bus_error" else error.code) from error
        if pid != 1:
            raise Unattested("owner_not_pid1")
        return owner

    def unit_state(self, bus, owner):
        """user@U.service as PID 1 reports it, every call addressed to PID 1's own unique name."""
        try:
            path = bus.call(owner, "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
                            "GetUnit", "s", [f"user@{self.uid}.service"], "o")
        except Unattested as error:
            raise Unattested("unit_not_running" if error.code == "bus_error" else error.code) from error
        if not path.startswith("/org/freedesktop/systemd1/unit/"):
            raise Unattested("bus_unavailable")

        def get(interface, name, kind):
            return bus.call(owner, path, "org.freedesktop.DBus.Properties", "Get", "ss",
                            [f"org.freedesktop.systemd1.{interface}", name], "v", "v:" + kind)

        try:
            return (path, get("Unit", "ActiveState", "s"), get("Unit", "SubState", "s"),
                    get("Service", "MainPID", "u"), get("Service", "NotifyAccess", "s"),
                    tuple(get("Unit", "DropInPaths", "as")), get("Unit", "NeedDaemonReload", "b"),
                    get("Unit", "FragmentPath", "s"))
        except Unattested as error:
            raise Unattested("bus_unavailable" if error.code == "bus_error" else error.code) from error

    def unit_runs(self, state, pid):
        _, active, sub, main, notify, drop_ins, reload, fragment = state
        if (active, sub) != ("active", "running"):
            raise Unattested("unit_not_running")
        if main != pid:
            raise Unattested("main_pid_mismatch")
        # Under NotifyAccess=all or exec another process in the unit could name itself
        # main with MAINPID=; "main" (the vendor default) and "none" cannot.
        if notify not in ("main", "none"):
            raise Unattested("notify_access")
        # The vendor definition, which may carry the distribution's own drop-ins (Debian 13
        # ships user@.service.d/10-login-barrier.conf); a drop-in anywhere else is a change.
        if reload or not all(map(self.vendor_unit_file, [fragment, *drop_ins])):
            raise Unattested("unit_modified")

    def attest_manager(self, pid):
        """PID 1 attests, before and after this process is pinned and read again, that it is
        user@U.service's running main process. Nothing is cached; any doubt raises a code."""
        try:
            self.initial_namespaces()
            bus = SystemBus(self)
            owner = self.systemd_owner(bus)
            first = self.unit_state(bus, owner)
            self.unit_runs(first, pid)
            directory = self.keep(os.open(str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC |
                                          os.O_NOFOLLOW, dir_fd=self.root))
            identity, state, uids = self.identity(directory, pid)
            handle = self.keep(self.pidfd(pid))
            if (state != b"live" or not live(handle) or not self.manager_shaped(directory, identity, uids) or
                    not self.every_thread_denied(directory)):
                raise Unattested("changed")
            if self.systemd_owner(bus) != owner or self.unit_state(bus, owner) != first:
                raise Unattested("changed")
            if not live(handle) or self.identity(directory, pid) != (identity, state, uids):
                raise Unattested("changed")
        except Refusal as error:
            raise Unattested("deadline" if error.reason == "budget_exhausted" else "changed") from error
        except (OSError, ValueError, UnicodeError) as error:
            raise Unattested("changed") from error

    def denied(self, directory, pid, uids):
        """Name a denied table's process for diagnostics; never consulted by the proof."""
        try:
            comm = self.read(directory, "comm", 64).rstrip(b"\n").decode("utf-8", "replace")
        except (OSError, Refusal):
            comm = ""
        return {"pid": pid, "comm": comm[:16], "uids": list(uids)}

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
            if diagnostics and proof.manager:
                # A note, not a diagnostic: the body's diagnostic schema is for refusals.
                exempted = NOTE + json.dumps({"schemaVersion": 1, "serviceManager": "exempted",
                                              "pid": proof.manager["pid"]}, separators=(",", ":")) + "\n"
                return result, retries() + exempted
        return result, retries()
    except Exception as error:
        refusal = error if isinstance(error, Refusal) else Refusal("process", "process_unavailable", getattr(error, "errno", 0) or 0)
        detail = {"schemaVersion": 1, "stage": refusal.stage, "reason": refusal.reason,
                  "errno": max(0, refusal.error), "attempt": proof.census_attempts, "retry": False,
                  **({"deniedProcess": refusal.denied} if refusal.denied else {}),
                  **({"serviceManager": refusal.manager} if refusal.manager else {})}
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
