"""The server CPU reader's exit proof against real exiting processes (#364).

Forks children that exit, and reads each one's identity the way the
supervisor does until the kernel makes it a zombie. Every read libproc
refuses while kill(pid, 0) still reaches the child must be proven exited.
A live setuid-root `top`, equally unreadable to its owner, must not be.
"""
import importlib.util
import json
import os
import signal
import subprocess
import sys

source = sys.argv[1]
sys.path.insert(0, source)
import native  # noqa: E402

spec = importlib.util.spec_from_file_location("server_cpu", os.path.join(source, "server-cpu.py"))
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)
_, _, exiting = budget.cpu_reader()

unreadable = proven = 0
zombie = False


def reaped_soon(*_):
    global zombie
    zombie = True


# The kernel signals the parent once the child is a zombie, which the old reader already proved.
signal.signal(signal.SIGCHLD, reaped_soon)
for _ in range(int(sys.argv[2])):
    zombie = False
    child = os.fork()
    if child == 0:
        # Touched memory makes exit teardown take milliseconds, not microseconds.
        block = bytearray(32 << 20)
        os._exit(0)
    while not zombie:
        try:
            if native.identity(child) is None:
                break
            continue
        except RuntimeError:
            pass
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            break
        unreadable += 1
        proven += exiting(child)
    os.waitpid(child, 0)

top = subprocess.Popen(["/usr/bin/top", "-l", "0", "-s", "5", "-n", "0"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    try:
        native.identity(top.pid)
        live = "readable"
    except RuntimeError:
        live = "exiting" if exiting(top.pid) else "unknown"
finally:
    top.kill()
    top.wait()
print(json.dumps({"unreadable": unreadable, "proven": proven, "live": live}))
