"""Run the real console on a PTY; JSON pipes carry input and output bytes."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 100, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)

def stop(*_):
    child.terminate()

signal.signal(signal.SIGTERM, stop)
pending = b""
try:
    while child.poll() is None:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            print(json.dumps({"data": base64.b64encode(data).decode()}), flush=True)
        if sys.stdin in ready:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                command = json.loads(line)
                if "input" in command:
                    os.write(master, command["input"].encode())
finally:
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    os.close(master)
