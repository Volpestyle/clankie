"""Bounded manual fixture command; no provider, coding harness, or simulator."""
import json
import os
import resource
import subprocess
import sys
import time

journal, seat_id, duration, helper = sys.argv[1:]
identity = json.loads(subprocess.check_output(
    [sys.executable, "-I", helper, "identity", str(os.getpid())], timeout=3))
memory = bytearray(16 * 1024 * 1024)
for index in range(0, len(memory), 4096):
    memory[index] = 1

def record(stage):
    row = {
        "stage": stage, "seatId": seat_id, "pid": os.getpid(),
        "startTime": identity["startTime"], "at": time.time_ns() // 1_000_000,
        "allocationMb": len(memory) // (1024 * 1024),
        "maxRssMb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss /
        (1024 * 1024 if sys.platform == "darwin" else 1024),
    }
    descriptor = os.open(journal, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(descriptor, (json.dumps(row) + "\n").encode())
    finally:
        os.close(descriptor)

record("start")
time.sleep(float(duration))
record("end")
