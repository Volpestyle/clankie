"""Real installed Codex listener and birth, no accounts or provider turns."""
import glob
import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import time

helper = sys.argv[1]
binaries = glob.glob("/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*/bin/codex")
assert len(binaries) == 1, binaries

version = subprocess.run([binaries[0], "--version"], capture_output=True, text=True, check=True, timeout=2).stdout.strip()
assert "0.160.1" in version, version
with tempfile.TemporaryDirectory(prefix="clankie-codex-proof-") as directory:
    path = str(Path(directory) / "server λ.sock")
    endpoint = "unix://" + path
    env = {**os.environ, "CODEX_HOME": str(Path(directory) / "home")}
    Path(env["CODEX_HOME"]).mkdir()
    server = subprocess.Popen([binaries[0], "app-server", "--listen", endpoint],
                              env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        until = time.monotonic() + 10
        while True:
            assert server.poll() is None, server.communicate(timeout=2)
            assert time.monotonic() < until, "Actual Codex listener did not start"
            with socket.socket(socket.AF_UNIX) as ready:
                try:
                    ready.connect(path)
                    break
                except (FileNotFoundError, ConnectionRefusedError):
                    time.sleep(.02)
        canonical = str(Path(path).resolve(strict=True))
        def observe(pid, selected_endpoint=endpoint, selected_path=canonical):
            return subprocess.run([helper, "--codex-server", str(pid), selected_endpoint.encode().hex(),
                                   selected_path.encode().hex(), "--diagnostics"], capture_output=True, text=True, timeout=2)
        result = observe(server.pid)
        assert result.returncode == 0, result.stderr
        proof = json.loads(result.stdout)
        assert proof["process"]["pid"] == server.pid
        assert proof["process"]["uid"] == os.getuid()
        assert proof["process"]["kernelIdentity"]
        birth = subprocess.run([helper, "--birth", str(server.pid)], capture_output=True, text=True, timeout=2)
        assert birth.returncode == 0, birth.stderr
        assert json.loads(birth.stdout)["process"] == proof["process"]
        for refused in [observe(os.getpid()), observe(server.pid, endpoint + "x"), observe(server.pid, selected_path=canonical + "x")]:
            assert refused.returncode == 1, refused.stderr
            assert refused.stdout == ""
        # Force exit of the owned server so the stale-birth assertion is deterministic.
        server.kill()
        server.wait(timeout=3)
        exited = observe(server.pid)
        assert exited.returncode == 1 and exited.stdout == "", exited.stderr
        print(json.dumps({"platform": sys.platform, "kernel": os.uname().release, "uid": os.getuid(),
                          "nativeCodex": version, "birthAndListener": "passed", "wrongPid": "refused",
                          "wrongEndpoint": "refused", "wrongCanonicalPath": "refused", "exited": "refused",
                          "census": proof["census"]}))
    finally:
        if server.poll() is None:
            server.kill()
            server.wait(timeout=3)
        for pipe in [server.stdin, server.stdout, server.stderr]:
            pipe.close()
