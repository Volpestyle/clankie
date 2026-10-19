"""Keep an exited grandchild in a real server group until normal shutdown."""
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


child = os.fork()
if child == 0:
    os._exit(0)
time.sleep(0.05)
publish(sys.argv[1], {"parent": os.getpid(), "zombie": child})

def stop(*_):
    os.waitpid(child, 0)
    sys.exit(0)

signal.signal(signal.SIGTERM, stop)
while True:
    time.sleep(0.1)
