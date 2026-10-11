"""A real stopped launcher with an unreaped exited child (Darwin regression)."""
import json
import os
import signal
import sys
import time

time.sleep(0.3)  # Let the supervisor observe the live launcher's baseline.
child = os.fork()
if child == 0:
    os._exit(17)
time.sleep(0.05)
with open(sys.argv[1], "w") as file:
    json.dump({"parent": os.getpid(), "child": child}, file)
os.kill(os.getpid(), signal.SIGSTOP)
_, status = os.waitpid(child, 0)
with open(sys.argv[1] + ".reaped", "w") as file:
    json.dump({"code": os.waitstatus_to_exitcode(status)}, file)
sys.exit(os.waitstatus_to_exitcode(status))
