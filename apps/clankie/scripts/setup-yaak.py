#!/usr/bin/env python3
"""Import Clankie's OpenAPI workspace into Yaak with local Keychain credentials."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

WORKSPACE_NAME = "Clankie"
KEYCHAIN = "bot.clankie.credentials"
OPENAPI = Path(__file__).resolve().parent.parent / "openapi.yaml"
YAAK_DATA_DIR = os.environ.get("YAAK_DATA_DIR")


def yaak(*args: str) -> str:
    command = ["yaak"]
    if YAAK_DATA_DIR:
        command.extend(("--data-dir", YAAK_DATA_DIR))
    result = subprocess.run([*command, *args], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def workspace_ids() -> set[str]:
    matches = set()
    for line in yaak("workspace", "list").splitlines():
        workspace_id, separator, name = line.partition(" - ")
        if separator and name == WORKSPACE_NAME:
            matches.add(workspace_id)
    return matches


def cred_template(account: str) -> str:
    return f"${{[ keychain(service='{KEYCHAIN}', account='{account}') ]}}"


def token_template(cred_var: str) -> str:
    return f"${{[ json.jsonpath(input='${{[ {cred_var} ]}}', query='$.key') ]}}"


def local_variables() -> list[dict[str, object]]:
    variables: list[dict[str, object]] = [
        {"name": "baseUrl", "value": "http://127.0.0.1:4310", "enabled": True}
    ]
    for name, account in (
        ("operator", "clankie_operator"),
        ("captain", "clankie_captain"),
        ("discordText", "clankie_discord_bridge"),
        ("discordVoice", "clankie_discord_voice_bridge"),
    ):
        cred_var = f"{name}Cred"
        variables.extend(
            (
                {"name": cred_var, "value": cred_template(account), "enabled": True},
                {"name": f"{name}Token", "value": token_template(cred_var), "enabled": True},
            )
        )
    variables.extend(
        (
            {"name": "bearerToken", "value": "${[ operatorToken ]}", "enabled": True},
            {"name": "deviceToken", "value": "", "enabled": True},
            {"name": "guildId", "value": "123456789012345678", "enabled": True},
            {"name": "userId", "value": "123456789012345680", "enabled": True},
            {"name": "channelId", "value": "123456789012345679", "enabled": True},
            {"name": "conversationId", "value": "global-default", "enabled": True},
            {"name": "sessionId", "value": "", "enabled": True},
            {"name": "deviceId", "value": "", "enabled": True},
        )
    )
    return variables


def main() -> int:
    if shutil.which("yaak") is None:
        print(
            "yaak CLI is not on PATH. Install with: npm install -g --allow-scripts=@yaakapp/cli @yaakapp/cli",
            file=sys.stderr,
        )
        return 1
    if not OPENAPI.is_file():
        print(f"OpenAPI catalog not found: {OPENAPI}", file=sys.stderr)
        return 1

    existing_ids = workspace_ids()
    print(yaak("import", str(OPENAPI)))
    imported_ids = workspace_ids() - existing_ids
    if len(imported_ids) != 1:
        raise RuntimeError(f"expected one imported {WORKSPACE_NAME} workspace, found {sorted(imported_ids)}")
    workspace_id = imported_ids.pop()

    environment = yaak(
        "environment",
        "create",
        "--json",
        json.dumps(
            {
                "workspaceId": workspace_id,
                "name": "Local",
                "color": "#5B8DEF",
                "public": True,
                "variables": local_variables(),
            }
        ),
    )
    for old_id in sorted(existing_ids):
        print(f"replacing existing workspace {old_id}")
        yaak("workspace", "delete", old_id, "--yes")

    print()
    print(f"Yaak workspace: {WORKSPACE_NAME} ({workspace_id})")
    print(environment)
    print("Select Local; imported bearer auth defaults to the operator Keychain token.")
    print("For captain or Discord routes, point bearerToken at the matching token variable.")
    print("Safe first sends: Public liveness, Operator presence snapshot, List paired devices, Live play session.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
