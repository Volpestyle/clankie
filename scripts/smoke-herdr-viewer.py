"""Give the packaged viewer a real terminal and detach without closing its fleet."""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, terminal = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
    os.execv(sys.argv[1], [sys.argv[1]])

output = bytearray()
detached = False
reaped = False
try:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if select.select([terminal], [], [], 0.1)[0]:
            try:
                chunk = os.read(terminal, 65536)
            except OSError:
                chunk = b""
            output.extend(chunk)
            if not detached and b"viewer-proof" in output:
                os.write(terminal, bytes([2, 113]))  # Ctrl+B, Q.
                detached = True
        ended, result = os.waitpid(pid, os.WNOHANG)
        if ended:
            reaped = True
            assert detached, "viewer exited before showing the chosen workspace"
            assert os.waitstatus_to_exitcode(result) == 0, "viewer failed to detach cleanly"
            print("Native viewer displayed the chosen fleet and detached")
            break
    else:
        raise AssertionError("viewer did not render and detach within 30 seconds")
except BaseException:
    sys.stderr.buffer.write(output[-4000:])
    raise
finally:
    if not reaped:
        # pty.fork gives this viewer its own session; only this test's process group is closed.
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(terminal)
