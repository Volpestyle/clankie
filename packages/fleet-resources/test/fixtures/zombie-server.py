"""A real stopped launcher with an unreaped exited child (Darwin regression)."""
import json
import os
import signal
import sys
import time


def publish(path, value):
    """The test polls this receipt; a rename never exposes a partial write."""
    with open(path + ".tmp", "w") as file:
        json.dump(value, file)
    os.replace(path + ".tmp", path)


time.sleep(0.3)  # Let the supervisor observe the live launcher's baseline.
child = os.fork()
if child == 0:
    os._exit(17)
time.sleep(0.05)
publish(sys.argv[1], {"parent": os.getpid(), "child": child})
os.kill(os.getpid(), signal.SIGSTOP)
_, status = os.waitpid(child, 0)
publish(sys.argv[1] + ".reaped", {"code": os.waitstatus_to_exitcode(status)})
sys.exit(os.waitstatus_to_exitcode(status))
