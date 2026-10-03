#!/usr/bin/python3 -I
"""Immutable verifier trampoline; invokes only the candidate in a fresh bwrap boundary.

CLI is exactly: candidate-python /app/filter.py <owned regular /tmp input>.
This module does nothing on import. Tests inject a fake runner; no sandbox/eval is run.
Bubblewrap ABI is pinned through Codex 008bbd vendor/bubblewrap/bubblewrap.c.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile

MAX_BYTES = 16 * 1024 * 1024
BWRAP = "/opt/lead/bwrap"
MANIFEST = "/opt/lead/html-runtime.json"


def owned_fd(path, writable=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("Noncanonical verifier input")
    fd = os.open(path, (os.O_RDWR if writable else os.O_RDONLY) | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > MAX_BYTES:
        os.close(fd)
        raise ValueError("Unowned, linked or oversized verifier input")
    return fd


def read_fd(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    chunks = []
    size = 0
    while True:
        chunk = os.read(fd, min(65536, MAX_BYTES + 1 - size))
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_BYTES:
            raise ValueError("Oversized candidate output")


def command(input_path, private_directory, runtime, candidate="/app/filter.py"):
    """Preserve the original argv filename while hiding every other verifier path."""
    if set(runtime) != {"python", "pythonSha256", "bwrapSha256", "mounts"}:
        raise ValueError("Invalid immutable HTML runtime manifest")
    if not runtime["python"].startswith("/usr/"):
        raise ValueError("Interpreter must be in the immutable runtime")
    args = [BWRAP, "--unshare-all", "--disable-userns", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL"]
    allowed = {"/usr", "/bin", "/lib", "/lib64", "/etc/ld.so.cache"}
    seen = set()
    for mount in runtime["mounts"]:
        path = mount["path"]
        if path not in allowed or path in seen:
            raise ValueError("Unapproved candidate runtime mount")
        seen.add(path)
        if set(mount) == {"path", "link"}:
            if path not in {"/bin", "/lib", "/lib64"} or mount["link"] not in {"usr/bin", "usr/lib", "usr/lib64"}:
                raise ValueError("Unsafe runtime symlink")
            args.extend(["--symlink", mount["link"], path])
        elif set(mount) == {"path"}:
            args.extend(["--ro-bind", path, path])
        else:
            raise ValueError("Invalid runtime mount")
    if "/usr" not in seen:
        raise ValueError("Python runtime missing")
    args.extend(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/work",
                 "--ro-bind", candidate, "/app/filter.py", "--bind", private_directory, str(Path(input_path).parent),
                 "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", "/work",
                 "--setenv", "PYTHONNOUSERSITE", "1", "--chdir", "/work", "--",
                 runtime["python"], "-I", "/app/filter.py", input_path])
    return args


def run_filter(input_path, runtime, runner=subprocess.run, candidate="/app/filter.py", temporary_root="/tmp"):
    path = Path(input_path)
    if not path.is_absolute() or not str(path).startswith(temporary_root + "/"):
        raise ValueError("Candidate input must be a verifier-generated temporary file")
    fd = owned_fd(path, writable=True)
    try:
        initial = read_fd(fd)
        with tempfile.TemporaryDirectory(prefix="lead-filter-", dir=temporary_root) as directory:
            child_path = Path(directory) / path.name
            child_path.write_bytes(initial)
            os.chmod(child_path, 0o600)
            result = runner(command(str(path), directory, runtime, candidate), env={}, check=False)
            if type(result.returncode) is not int:
                raise ValueError("Candidate termination is uncertain")
            # PID namespace teardown completes before bwrap exits. Never follow a
            # candidate-created link while reading the output in the trusted parent.
            output_fd = owned_fd(child_path)
            try:
                output = read_fd(output_fd)
            finally:
                os.close(output_fd)
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
            offset = 0
            while offset < len(output):
                offset += os.write(fd, output[offset:])
            return result.returncode
    finally:
        os.close(fd)


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "/app/filter.py":
        raise ValueError("Only the pinned grader's candidate Python invocation is supported")
    runtime = json.loads(Path(MANIFEST).read_text())
    for path, expected in [(BWRAP, runtime["bwrapSha256"]), (runtime["python"], runtime["pythonSha256"])]:
        if hashlib.sha256(Path(path).read_bytes()).hexdigest() != expected:
            raise ValueError("Immutable candidate execution runtime changed")
    code = run_filter(sys.argv[2], runtime)
    if code < 0:
        signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    sys.exit(code)


if __name__ == "__main__":
    main()
