"""Bounded stdio client and read-only proof. No daemon or network endpoint."""

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import time


REQUEST_TIMEOUT = 12
MAX_OUTPUT = 512 * 1024


class TransportError(RuntimeError):
    def __init__(self, message, action_may_have_dispatched, *, startup_refusal=None):
        super().__init__(message + "; transport closed permanently. Inspect separately; never replay an uncertain action.")
        self.action_may_have_dispatched = action_may_have_dispatched
        self.retry_safe = False
        self.startup_refusal = startup_refusal


def validate_response(request, result):
    """Reject another operation's receipt and malformed fields before exposing it."""
    def identity(value):
        return (isinstance(value, dict) and type(value.get("pid")) is int
                and value["pid"] > 0 and all(isinstance(value.get(k), str) and value[k]
                                           for k in ("generation", "bundle")))

    valid = isinstance(result, dict) and type(result.get("success")) is bool
    if valid and not result["success"]:
        valid = (isinstance(result.get("code"), str) and bool(result["code"])
                 and type(result.get("retrySafe")) is bool
                 and ("actionDispatched" not in result or type(result["actionDispatched"]) is bool)
                 and not (result.get("actionDispatched") is True and result["retrySafe"]))
    elif valid:
        valid = (all(identity(result.get(k)) for k in ("target", "foregroundBefore", "foregroundAfter"))
                 and type(result.get("focusChangesDuringOperation")) is int
                 and result["focusChangesDuringOperation"] >= 0)
        op = request["op"]
        if op == "windows":
            windows = result.get("windows")
            valid = valid and isinstance(windows, list) and len(windows) <= 32 and all(
                isinstance(w, dict) and isinstance(w.get("id"), str) and w["id"]
                and w.get("role") in ("AXWindow", "AXMenu") and isinstance(w.get("title"), str)
                for w in windows)
        elif op == "observe":
            nodes = result.get("nodes")
            valid = (valid and isinstance(result.get("snapshot"), str) and bool(result["snapshot"])
                     and isinstance(result.get("window"), str) and result["window"] == request.get("window")
                     and type(result.get("visited")) is int and 0 <= result["visited"] <= 2000
                     and type(result.get("incomplete")) is bool and isinstance(nodes, list)
                     and len(nodes) <= result["visited"] and all(
                         isinstance(n, dict) and all(isinstance(n.get(k), str) for k in
                                                    ("id", "role", "title", "label", "identifier", "value"))
                         and isinstance(n.get("actions"), list) and all(isinstance(a, str) for a in n["actions"])
                         and type(n.get("enabled")) is bool and type(n.get("depth")) is int
                         for n in nodes))
        elif op == "menu":
            valid = (valid and result.get("actionDispatched") is True and result.get("retrySafe") is False
                     and result.get("action") == request.get("action")
                     and result.get("action") in ("AXShowMenu", "AXPress", "AXCancel")
                     and result.get("effect") == "unverified")
    if not valid:
        raise ValueError("Invalid response shape for " + request["op"])
    return result


class Desktop:
    def __init__(self, binary, *, allow_menu_actions=False):
        args = [str(binary), "session"]
        if allow_menu_actions:
            args.append("--allow-menu-actions")
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, bufsize=0)
        self.selector = selectors.DefaultSelector()
        for stream, name in ((self.process.stdout, "stdout"), (self.process.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, name)
        os.set_blocking(self.process.stdin.fileno(), False)
        self.closed = False
        self.failure = None
        self.action_may_have_dispatched = False
        self.error_bytes = 0
        self.started = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self, *, failed=False):
        if self.closed:
            return
        self.closed = True
        self.selector.close()
        self.process.stdin.close()
        if failed and self.process.poll() is None:
            self.process.kill()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()
        self.process.stderr.close()

    def request(self, request):
        if self.failure is not None:
            raise self.failure
        if self.closed:
            raise TransportError("Desktop is closed", self.action_may_have_dispatched)
        deadline = time.monotonic() + REQUEST_TIMEOUT
        if not isinstance(request, dict) or request.get("op") not in ("windows", "observe", "menu"):
            raise ValueError("Expected windows, observe, or menu request")
        payload = json.dumps(request, separators=(",", ":")).encode()
        if len(payload) > 16384:
            raise ValueError("Request exceeds 16384 bytes")
        payload += b"\n"
        written = 0
        output = bytearray()
        errors = bytearray()
        startup_refusal = None
        try:
            # Drain a first startup refusal within the ordinary bounds, without writing.
            startup = any(key.data == "stdout" for key, _ in self.selector.select(0))
            if startup and self.started:
                raise RuntimeError("Unexpected output or EOF before request")
            if not startup:
                self.selector.register(self.process.stdin, selectors.EVENT_WRITE, "stdin")
                self.started = True
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Desktop request timed out during write or read")
                for key, _ in self.selector.select(remaining):
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Desktop request timed out during write or read")
                    try:
                        if key.data == "stdin":
                            written += os.write(key.fileobj.fileno(), payload[written:])
                            if written == len(payload):
                                self.selector.unregister(key.fileobj)
                            continue
                        chunk = os.read(key.fileobj.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        self.selector.unregister(key.fileobj)
                        if key.data == "stdout":
                            raise RuntimeError("Desktop EOF before response: " + errors.decode(errors="replace"))
                        continue
                    if key.data == "stderr":
                        self.error_bytes += len(chunk)
                        errors.extend(chunk)
                        if self.error_bytes > MAX_OUTPUT:
                            raise RuntimeError("Desktop stderr exceeds its bound")
                        continue
                    output.extend(chunk)
                    if len(output) > MAX_OUTPUT + 1:
                        raise RuntimeError("Desktop response exceeds its bound")
                    if b"\n" in output:
                        line, _, rest = output.partition(b"\n")
                        if rest or (not startup and written != len(payload)):
                            raise RuntimeError("Unexpected desktop response framing")
                        result = validate_response(request, json.loads(line))
                        if startup:
                            if result["success"]:
                                raise RuntimeError("Unsolicited success before request")
                            startup_refusal = result
                            raise RuntimeError("Desktop startup refusal: " + json.dumps(result, ensure_ascii=False, separators=(",", ":")))
                        if time.monotonic() >= deadline:
                            raise TimeoutError("Desktop request timed out during response validation")
                        if request["op"] == "menu":
                            self.action_may_have_dispatched |= result.get("actionDispatched", not result["retrySafe"])
                        return result
        except Exception as error:
            self.action_may_have_dispatched |= request["op"] == "menu" and written > 0
            self.failure = TransportError(str(error), self.action_may_have_dispatched,
                                          startup_refusal=startup_refusal)
            self.close(failed=True)
            raise self.failure from error


def require_success(result):
    if result.get("success") is not True:
        raise RuntimeError(json.dumps(result))
    return result


def read_proof(binary):
    """Two observations through the real public stdio interface, with no action opt-in."""
    with Desktop(binary) as desktop:
        inventory = require_success(desktop.request({"op": "windows"}))
        windows = inventory["windows"]
        if len(windows) != 1 or windows[0]["role"] != "AXWindow":
            raise RuntimeError("Read proof requires exactly one native Spotify window; inspect inventory explicitly")
        request = {"op": "observe", "window": windows[0]["id"], "maxNodes": 2000,
                   "roles": ["AXRow", "AXPopUpButton", "AXButton", "AXMenu"]}
        receipts = []
        for _ in range(2):
            result = require_success(desktop.request(request))
            nodes = result.pop("nodes")
            semantic = [{k: v for k, v in node.items() if k != "id"} for node in nodes]
            result["semanticSHA256"] = hashlib.sha256(json.dumps(semantic, sort_keys=True).encode()).hexdigest()
            result["roles"] = dict(collections.Counter(node["role"] for node in nodes))
            result["songMenuControls"] = sum(node["role"] == "AXPopUpButton" and node["label"].startswith("More options for ") for node in nodes)
            result["transportLabels"] = [node["label"] or node["title"] for node in nodes
                                          if node["role"] == "AXButton" and (node["label"] or node["title"]) in ["Play", "Pause"]]
            receipts.append(result)
        preserved = all(r["foregroundBefore"] == inventory["foregroundBefore"] == r["foregroundAfter"]
                        and r["focusChangesDuringOperation"] == 0 and r["target"] == inventory["target"] for r in receipts)
        return {"success": preserved and all(r["roles"].get("AXRow", 0) > 0 and r["songMenuControls"] > 0 for r in receipts),
                "claim": "background read only; menu interaction and service execution require separate proof",
                "actionDispatches": 0, "foregroundPreserved": preserved,
                "observedSemanticsStable": receipts[0]["semanticSHA256"] == receipts[1]["semanticSHA256"],
                "transportLabelsStable": receipts[0]["transportLabels"] == receipts[1]["transportLabels"],
                "snapshotsExpiredAtProcessExit": True, "observations": receipts}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", nargs="?", default=str(Path(__file__).parent / ".build/release/clankie-desktop"))
    args = parser.parse_args()
    receipt = read_proof(args.binary)
    print(json.dumps(receipt, indent=2))
    raise SystemExit(0 if receipt["success"] else 1)
