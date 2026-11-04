"""Keep a live member this user cannot observe in a real server group (#364).

`top` is setuid root on macOS, so libproc refuses its identity to the owner
while kill(pid, 0) still reaches it and the kernel shows no exit.
"""
import json
import os
import signal
import subprocess
import sys

top = subprocess.Popen(["/usr/bin/top", "-l", "0", "-s", "5", "-n", "0"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop(*_):
    top.kill()
    top.wait()
    sys.exit(0)


signal.signal(signal.SIGTERM, stop)
with open(sys.argv[1] + ".tmp", "w") as file:
    json.dump({"parent": os.getpid(), "unreadable": top.pid}, file)
os.replace(sys.argv[1] + ".tmp", sys.argv[1])
signal.pause()
