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


class Desktop:
    def __init__(self, binary, *, allow_menu_actions=False):
        args = [str(binary), "session"]
        if allow_menu_actions:
            args.append("--allow-menu-actions")
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ, "stdout")
        self.selector.register(self.process.stderr, selectors.EVENT_READ, "stderr")
        self.buffer = bytearray()
        self.errors = bytearray()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.selector.close()
        self.process.stdout.close()
        self.process.stderr.close()

    def request(self, request):
        payload = json.dumps(request, separators=(",", ":")).encode()
        if len(payload) > 16384:
            raise ValueError("Request exceeds 16384 bytes")
        self.process.stdin.write(payload + b"\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 12
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Desktop response timed out; a menu action may have run. Do not replay it.")
            for key, _ in self.selector.select(remaining):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    self.selector.unregister(key.fileobj)
                    if key.data == "stdout":
                        raise RuntimeError("Desktop exited before a response: " + self.errors.decode(errors="replace"))
                    continue
                output = self.buffer if key.data == "stdout" else self.errors
                output.extend(chunk)
                if len(output) > 512 * 1024 + 1:
                    raise RuntimeError("Desktop output exceeds its bound; inspect before retrying")
        line, _, rest = self.buffer.partition(b"\n")
        self.buffer = bytearray(rest)
        return json.loads(line)


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
