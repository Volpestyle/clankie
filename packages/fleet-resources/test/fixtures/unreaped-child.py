"""Keep an exited grandchild in a real server group until normal shutdown."""
import json
import os
import signal
import sys
import time

child = os.fork()
if child == 0:
    os._exit(0)
time.sleep(0.05)
with open(sys.argv[1], "w") as file:
    json.dump({"parent": os.getpid(), "zombie": child}, file)

def stop(*_):
    os.waitpid(child, 0)
    sys.exit(0)

signal.signal(signal.SIGTERM, stop)
while True:
    time.sleep(0.1)
