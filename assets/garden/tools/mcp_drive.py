#!/usr/bin/env python3
"""Drive pixel-mcp over stdio JSON-RPC (MCP protocol).

Usage:
  mcp_drive.py list                 -> dump tool names + schemas
  mcp_drive.py run <program.json>   -> execute a JSON list of {tool, args} calls
"""
import json, os, subprocess, sys

BIN = os.path.expanduser(os.environ.get("PIXEL_MCP_BIN", "~/dev/pixel-mcp/bin/pixel-mcp"))


class Client:
    def __init__(self):
        self.p = subprocess.Popen(
            [BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.next_id = 1

    def rpc(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            msg["id"] = self.next_id
            self.next_id += 1
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        if notify:
            return None
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("server closed stdout")
            resp = json.loads(line)
            if resp.get("id") == msg["id"]:
                if "error" in resp:
                    raise RuntimeError(f"{method} error: {resp['error']}")
                return resp["result"]

    def start(self):
        self.rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "clankie-driver", "version": "0.1"}})
        self.rpc("notifications/initialized", notify=True)

    def call(self, tool, args):
        res = self.rpc("tools/call", {"name": tool, "arguments": args})
        texts = [c.get("text", "") for c in res.get("content", [])]
        return ("ERROR: " if res.get("isError") else "") + " | ".join(t for t in texts if t)

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def main():
    c = Client()
    c.start()
    try:
        if sys.argv[1] == "list":
            tools = c.rpc("tools/list")["tools"]
            for t in tools:
                print(f"== {t['name']}")
                print(json.dumps(t.get("inputSchema", {}), indent=1))
        elif sys.argv[1] == "run":
            prog = json.load(open(sys.argv[2]))
            vars = {}
            for i, step in enumerate(prog):
                args = {k: (vars[v[1:]] if isinstance(v, str) and v.startswith("$") else v)
                        for k, v in step.get("args", {}).items()}
                out = c.call(step["tool"], args)
                if "capture" in step:
                    vars[step["capture"]] = json.loads(out)["file_path"]
                trunc = out if len(out) < 300 else out[:300] + "..."
                print(f"[{i}] {step['tool']}: {trunc}")
                if out.startswith("ERROR"):
                    sys.exit(1)
    finally:
        c.close()


if __name__ == "__main__":
    main()
