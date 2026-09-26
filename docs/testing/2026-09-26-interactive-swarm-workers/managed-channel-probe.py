#!/usr/bin/env python3
"""Owner-run consent probe. Never writes managed policy or invokes sudo."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
PLUGIN = "swarm-probe@swarm-channel-consent-probe"
POLICY = Path("/Library/Application Support/ClaudeCode/managed-settings.json")


def run(args, root):
    subprocess.run(args, cwd=root, check=True)


def prepare(root, repo):
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    marketplace = root / "marketplace"
    plugin = marketplace / "probe"
    (marketplace / ".claude-plugin").mkdir(parents=True)
    (plugin / ".claude-plugin").mkdir(parents=True)
    (marketplace / ".claude-plugin/marketplace.json").write_text(json.dumps({
        "name": "swarm-channel-consent-probe",
        "owner": {"name": "Local transport probe"},
        "plugins": [{"name": "swarm-probe", "source": "./probe", "version": "0.0.2"}],
    }))
    (plugin / ".claude-plugin/plugin.json").write_text(json.dumps({
        "name": "swarm-probe", "version": "0.0.2",
        "description": "Local managed-channel consent probe; no operator credentials",
    }))
    shutil.copyfile(HERE / "channel-consent-server.mjs.txt", plugin / "server.mjs")
    (plugin / ".mcp.json").write_text(json.dumps({"mcpServers": {"swarm_probe": {
        "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server.mjs", str(root),
                                   str(repo / "apps/tui/package.json")],
    }}}))
    (root / "probe.json").write_text(json.dumps({"plugin": PLUGIN, "repo": str(repo)}))
    run(["claude", "plugin", "marketplace", "add", str(marketplace), "--scope", "local"], root)
    run(["claude", "plugin", "install", PLUGIN, "--scope", "local", "--json"], root)
    print("Prepared fixture. Managed policy is unchanged. Follow managed-consent.md.")


def launch(root):
    # Read-only sanity check, not proof this source wins over MDM/remote policy.
    if not POLICY.is_file():
        raise SystemExit("Managed policy is absent. James must review/apply it; this script will not.")
    policy = json.loads(POLICY.read_text())
    pair = {"marketplace": "swarm-channel-consent-probe", "plugin": "swarm-probe"}
    allowed = policy.get("allowedChannelPlugins", [])
    if policy.get("channelsEnabled") is not True or not (pair in allowed or PLUGIN in allowed):
        raise SystemExit("Owner's managed file must explicitly allow this probe first.")
    # Replace inherited user servers, including the operator seat, for this launch.
    # Actual plugin loading must remain enabled; strict-mcp-config suppresses it.
    if "CLAUDE_CONFIG_DIR" in os.environ:
        raise SystemExit("Run with the normal Claude config directory for this measured probe.")
    config = json.loads((Path.home() / ".claude.json").read_text())
    overrides = {name: {"command": "/usr/bin/false"} for name in config.get("mcpServers", {})}
    mcp = root / "blocked-inherited-mcp.json"
    mcp.write_text(json.dumps({"mcpServers": overrides}))
    settings = {"enabledPlugins": {PLUGIN: True}}
    argv = ["claude", "--setting-sources", "local", "--settings", json.dumps(settings),
            "--mcp-config", str(mcp), "--tools", "", "--allowedTools",
            "mcp__plugin_swarm-probe_swarm_probe__ack", "--permission-mode", "dontAsk",
            "--model", "sonnet", "--effort", "low", "--name", "Managed channel consent probe",
            "--session-id", str(uuid.uuid4()), "--system-prompt",
            "On each channel event call ack with the exact message_id and content, then stop.",
            "--channels", "plugin:" + PLUGIN]
    # A previous clean exit may leave the socket pathname. Never unlink a live one.
    sock = root / "probe.sock"
    if sock.exists():
        with socket.socket(socket.AF_UNIX) as connection:
            try:
                connection.connect(str(sock))
            except ConnectionRefusedError:
                sock.unlink()
            else:
                raise SystemExit("Probe server is still running; do not launch a duplicate.")
    os.chdir(root)
    for key in ("CLANKIE_OPERATOR_TOKEN", "CLANKIE_CAPTAIN_TOKEN", "CLANKIE_WORKER_TOKEN",
                "SWARM_SESSION_CAPABILITY"):
        os.environ.pop(key, None)
    os.execvp(argv[0], argv)


def emit(root):
    message_id = "managed-" + uuid.uuid4().hex
    started = time.monotonic()
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(str(root / "probe.sock"))
        connection.sendall((json.dumps({"message_id": message_id, "content": message_id}) + "\n").encode())
        print("Transport:", connection.recv(100).decode().strip(), flush=True)
    while time.monotonic() - started < 20:
        events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
        if any(e.get("type") == "ack" and e.get("message_id") == message_id for e in events):
            result = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      "message_id": message_id, "roundTrip": True,
                      "observedMs": round((time.monotonic() - started) * 1000)}
            with (root / "roundtrips.jsonl").open("a") as handle:
                handle.write(json.dumps(result) + "\n")
            print(json.dumps(result))
            return
        time.sleep(0.1)
    raise SystemExit("NO ACK within 20 seconds. Capture startup/status; do not enable unattended TUI.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "launch", "emit", "cleanup"])
    parser.add_argument("--dir", type=Path, required=True, help="new private fixture directory")
    parser.add_argument("--repo", type=Path, default=HERE.parents[2])
    args = parser.parse_args()
    root = args.dir.expanduser().resolve()
    if args.action == "prepare":
        prepare(root, args.repo.expanduser().resolve())
        return
    if json.loads((root / "probe.json").read_text()).get("plugin") != PLUGIN:
        raise SystemExit("Not this probe's fixture directory")
    if args.action == "launch":
        launch(root)
    elif args.action == "emit":
        emit(root)
    else:
        run(["claude", "plugin", "uninstall", PLUGIN, "--scope", "local", "--json"], root)
        run(["claude", "plugin", "marketplace", "remove", "swarm-channel-consent-probe",
             "--scope", "local"], root)
        print("Local plugin removed; evidence and managed policy left untouched.")


if __name__ == "__main__":
    main()
