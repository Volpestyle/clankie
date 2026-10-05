"""Read-only macOS native control fact, not a worker/tool authority token."""
import ctypes
import json
import os
import sys


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_uint32)
        for name in (
            "flags", "status", "xstatus", "pid", "ppid", "uid", "gid",
            "ruid", "rgid", "svuid", "svgid", "reserved",
        )
    ] + [
        ("comm", ctypes.c_char * 16),
        ("name", ctypes.c_char * 32),
    ] + [
        (name, ctypes.c_uint32)
        for name in ("nfiles", "pgid", "pjobc", "tty", "tpgid")
    ] + [
        ("nice", ctypes.c_int32),
        ("seconds", ctypes.c_uint64),
        ("microseconds", ctypes.c_uint64),
    ]


class VnodeInfoPath(ctypes.Structure):
    # Public SDK vnode_info is a 136-byte vinfo_stat and 16 bytes of type/fsid.
    # Its fields are opaque here; preserve their 8-byte alignment.
    _fields_ = [
        ("vnode", ctypes.c_uint64 * 19),
        ("path", ctypes.c_char * 1024),
    ]


class ProcVnodePathInfo(ctypes.Structure):
    _fields_ = [("cwd", VnodeInfoPath), ("root", VnodeInfoPath)]


def observe(pid):
    # Public SDK sys/proc_info.h PROC_PIDTBSDINFO. Reject unsupported ABIs.
    if sys.platform != "darwin" or pid <= 1 or pid > 2147483647:
        raise ValueError("Unsupported process")
    if ctypes.sizeof(ProcBsdInfo) != 136 or ctypes.alignment(ProcBsdInfo) != 8:
        raise ValueError("Unsupported proc_bsdinfo ABI")
    if ProcBsdInfo.seconds.offset != 120 or ProcBsdInfo.microseconds.offset != 128:
        raise ValueError("Unexpected process birth layout")
    if (ctypes.sizeof(ProcVnodePathInfo) != 2352
            or ctypes.alignment(ProcVnodePathInfo) != 8
            or VnodeInfoPath.path.offset != 152):
        raise ValueError("Unsupported proc_vnodepathinfo ABI")
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int
    library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    library.proc_pidpath.restype = ctypes.c_int
    info = ProcBsdInfo()
    if library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
        raise ValueError("Original process unavailable")
    if info.pid != pid or info.uid != os.getuid() or info.ruid != os.getuid():
        raise ValueError("Process owner mismatch")
    if info.seconds <= 0 or info.microseconds >= 1000000 or info.status == 5:
        raise ValueError("Invalid or exited process lifetime")
    path = ctypes.create_string_buffer(4096)
    count = library.proc_pidpath(pid, path, len(path))
    if count <= 0 or count >= len(path) or not path.value.startswith(b"/"):
        raise ValueError("Process executable unavailable")
    # Read only this PID's cwd through PROC_PIDVNODEPATHINFO. lsof initializes
    # mount/file metadata even with -p/-d cwd, which can block each admission.
    directories = ProcVnodePathInfo()
    if library.proc_pidinfo(pid, 9, 0, ctypes.byref(directories), ctypes.sizeof(directories)) != ctypes.sizeof(directories):
        raise ValueError("Process cwd unavailable")
    cwd = directories.cwd.path
    if not cwd.startswith(b"/") or len(cwd) >= 1024:
        raise ValueError("Process cwd unavailable")
    return {
        "pid": info.pid,
        "uid": info.uid,
        "birth": [str(info.seconds), str(info.microseconds)],
        "executable": path.value.decode("utf-8", errors="strict"),
        "cwd": cwd.decode("utf-8", errors="strict"),
    }


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Expected one PID")
        print(json.dumps(observe(int(sys.argv[1]))))
    except Exception:
        # No process names, argv, environment, or owner data in diagnostics.
        print("Native process observation unavailable", file=sys.stderr)
        sys.exit(1)
