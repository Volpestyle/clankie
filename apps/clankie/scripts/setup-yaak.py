#!/usr/bin/env python3
"""Create (or replace) a local Yaak workspace for the clankie service on :4310.

Tokens are not copied. Yaak reads them from the macOS Keychain the same way the
TUI does (service `bot.clankie.credentials`). Requires the `yaak` CLI.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys

WORKSPACE_NAME = "Clankie"
KEYCHAIN = "bot.clankie.credentials"


def yaak(*args: str) -> str:
    result = subprocess.run(["yaak", *args], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def created_id(output: str, kind: str) -> str:
    match = re.search(rf"Created {kind}: (\S+)", output)
    if match is None:
        raise RuntimeError(f"could not parse {kind} id from: {output}")
    return match.group(1)


def token_var(name: str) -> str:
    return f"${{[ {name} ]}}"


def cred_template(account: str) -> str:
    return f"${{[ keychain(service='{KEYCHAIN}', account='{account}') ]}}"


def token_template(cred_var: str) -> str:
    return f"${{[ json.jsonpath(input='${{[ {cred_var} ]}}', query='$.key') ]}}"


def bearer(token_name: str) -> dict:
    return {"authenticationType": "bearer", "authentication": {"token": token_var(token_name), "prefix": "Bearer"}}


def json_body(payload: object) -> dict:
    return {
        "bodyType": "application/json",
        "body": {"text": json.dumps(payload, indent=2)},
        "headers": [{"name": "Content-Type", "value": "application/json", "enabled": True}],
    }


def path_param(name: str, value: str) -> dict:
    return {"name": name if name.startswith(":") else f":{name}", "value": value, "enabled": True}


def query_param(name: str, value: str) -> dict:
    return {"name": name, "value": value, "enabled": True}


def main() -> int:
    if subprocess.run(["which", "yaak"], capture_output=True).returncode != 0:
        print("yaak CLI is not on PATH. Install with: npm install -g --allow-scripts=@yaakapp/cli @yaakapp/cli", file=sys.stderr)
        return 1

    for line in yaak("workspace", "list").splitlines():
        if " - " not in line:
            continue
        workspace_id, name = line.split(" - ", 1)
        if name == WORKSPACE_NAME:
            print(f"replacing existing workspace {workspace_id}")
            yaak("workspace", "delete", workspace_id, "--yes")

    workspace_id = created_id(
        yaak(
            "workspace",
            "create",
            "--json",
            json.dumps(
                {
                    "name": WORKSPACE_NAME,
                    "description": "Local apps/clankie service. Importable catalog: apps/clankie/openapi.yaml",
                }
            ),
        ),
        "workspace",
    )
    print(f"workspace {workspace_id}")

    variables = [
        {"name": "baseUrl", "value": "http://127.0.0.1:4310", "enabled": True},
        {"name": "operatorCred", "value": cred_template("clankie_operator"), "enabled": True},
        {"name": "operatorToken", "value": token_template("operatorCred"), "enabled": True},
        {"name": "captainCred", "value": cred_template("clankie_captain"), "enabled": True},
        {"name": "captainToken", "value": token_template("captainCred"), "enabled": True},
        {"name": "discordTextCred", "value": cred_template("clankie_discord_bridge"), "enabled": True},
        {"name": "discordTextToken", "value": token_template("discordTextCred"), "enabled": True},
        {"name": "discordVoiceCred", "value": cred_template("clankie_discord_voice_bridge"), "enabled": True},
        {"name": "discordVoiceToken", "value": token_template("discordVoiceCred"), "enabled": True},
        {"name": "runnerCred", "value": cred_template("clankie_runner"), "enabled": True},
        {"name": "runnerToken", "value": token_template("runnerCred"), "enabled": True},
        {"name": "deviceToken", "value": "", "enabled": True},
        {"name": "guildId", "value": "123456789012345678", "enabled": True},
        {"name": "userId", "value": "123456789012345680", "enabled": True},
        {"name": "channelId", "value": "123456789012345679", "enabled": True},
        {"name": "conversationId", "value": "global-default", "enabled": True},
        {"name": "sessionId", "value": "", "enabled": True},
        {"name": "deviceId", "value": "", "enabled": True},
    ]
    environment_id = created_id(
        yaak(
            "environment",
            "create",
            "--json",
            json.dumps(
                {
                    "workspaceId": workspace_id,
                    "name": "Local",
                    "color": "#5B8DEF",
                    "public": True,
                    "variables": variables,
                }
            ),
        ),
        "environment",
    )
    print(f"environment {environment_id}")

    folders: dict[str, str] = {}
    folder_specs = [
        ("Health", None, 100, "Public probe. No auth."),
        ("Operator", "operatorToken", 200, "TUI operator bearer from Keychain clankie_operator."),
        ("Captain", "captainToken", 300, "Console captain bearer. Dispatch + lanes."),
        ("Discord", "discordTextToken", 400, "Official-bot text bridge. Discord-lane routes."),
        ("Embodiment", "operatorToken", 500, "Play session. Mix of operator/captain/runner — check the request."),
        ("Browser & media", "operatorToken", 600, "Operator can call; approval-gated browser tools need this folder's bearer."),
        ("Pairing & devices", "operatorToken", 700, "Offer is operator; redeem/complete are unauthenticated; self is device."),
    ]
    for name, token, sort, description in folder_specs:
        payload: dict = {
            "workspaceId": workspace_id,
            "name": name,
            "description": description,
            "sortPriority": sort,
        }
        if token is not None:
            payload.update(bearer(token))
        folder_id = created_id(yaak("folder", "create", "--json", json.dumps(payload)), "folder")
        folders[name] = folder_id
        print(f"folder {name} {folder_id}")

    base = "${[ baseUrl ]}"
    requests: list[dict] = [
        {
            "folder": "Health",
            "name": "Health",
            "method": "GET",
            "url": f"{base}/health",
            "description": "Public liveness. Safe to spam.",
            "authenticationType": "none",
            "sortPriority": 10,
        },
        {
            "folder": "Operator",
            "name": "Presence status",
            "method": "GET",
            "url": f"{base}/v1/discord/presence-status",
            "description": "Phase and counts. What `clankie status` reads.",
            "sortPriority": 10,
        },
        {
            "folder": "Operator",
            "name": "List devices",
            "method": "GET",
            "url": f"{base}/v1/devices",
            "sortPriority": 20,
        },
        {
            "folder": "Operator",
            "name": "Export Discord person",
            "method": "GET",
            "url": f"{base}/v1/memory/discord-people/:guildId/:userId/export",
            "urlParameters": [path_param("guildId", "${[ guildId ]}"), path_param("userId", "${[ userId ]}")],
            "sortPriority": 30,
        },
        {
            "folder": "Operator",
            "name": "Delete Discord person",
            "method": "DELETE",
            "url": f"{base}/v1/memory/discord-people/:guildId/:userId",
            "urlParameters": [path_param("guildId", "${[ guildId ]}"), path_param("userId", "${[ userId ]}")],
            "description": "Destructive. Fill guildId/userId first.",
            "sortPriority": 40,
        },
        {
            "folder": "Operator",
            "name": "Record user-session opt-in",
            "method": "POST",
            "url": f"{base}/v1/discord/user-session/opt-in",
            "description": "Writes a durable ToS acceptance. Do not fire casually.",
            **json_body(
                {
                    "schemaVersion": 1,
                    "characterId": "clankie",
                    "acknowledgement": "I accept Discord user-session transport risk on my account.",
                    "guildIds": ["${[ guildId ]}"],
                    "channelIds": ["${[ channelId ]}"],
                    "dmPolicy": "deny",
                }
            ),
            "sortPriority": 50,
        },
        {
            "folder": "Operator",
            "name": "Revoke user-session opt-in",
            "method": "DELETE",
            "url": f"{base}/v1/discord/user-session/opt-in",
            "sortPriority": 60,
        },
        {
            "folder": "Operator",
            "name": "Revoke device",
            "method": "POST",
            "url": f"{base}/v1/devices/:id/revoke",
            "urlParameters": [path_param("id", "${[ deviceId ]}")],
            "description": "Destructive. Paste a deviceId from List devices.",
            "sortPriority": 70,
        },
        {
            "folder": "Captain",
            "name": "List conversations",
            "method": "POST",
            "url": f"{base}/operator/v1/dispatch",
            "description": "Safe read of the operator conversation registry.",
            **json_body({"op": "list", "schemaVersion": 1}),
            "sortPriority": 10,
        },
        {
            "folder": "Captain",
            "name": "Create conversation",
            "method": "POST",
            "url": f"{base}/operator/v1/dispatch",
            **json_body(
                {
                    "op": "create",
                    "schemaVersion": 1,
                    "scope": {"kind": "global"},
                    "title": "Yaak probe",
                }
            ),
            "sortPriority": 20,
        },
        {
            "folder": "Captain",
            "name": "Get conversation",
            "method": "POST",
            "url": f"{base}/operator/v1/dispatch",
            **json_body({"op": "get", "schemaVersion": 1, "conversationId": "${[ conversationId ]}"}),
            "sortPriority": 30,
        },
        {
            "folder": "Captain",
            "name": "Send message",
            "method": "POST",
            "url": f"{base}/operator/v1/dispatch",
            "description": "Starts a real captain turn. Fill conversationId from Create/List first.",
            **json_body(
                {
                    "op": "send",
                    "schemaVersion": 1,
                    "turn": {
                        "schemaVersion": 1,
                        "kind": "message",
                        "conversationId": "${[ conversationId ]}",
                        "surfaceClientId": "yaak",
                        "expectedRevision": 0,
                        "message": "ping from Yaak",
                    },
                }
            ),
            "sortPriority": 40,
        },
        {
            "folder": "Captain",
            "name": "Replay conversation",
            "method": "POST",
            "url": f"{base}/operator/v1/dispatch",
            **json_body(
                {
                    "op": "replay",
                    "schemaVersion": 1,
                    "replay": {
                        "schemaVersion": 1,
                        "conversationId": "${[ conversationId ]}",
                        "surfaceClientId": "yaak",
                        "limit": 50,
                    },
                }
            ),
            "sortPriority": 50,
        },
        {
            "folder": "Captain",
            "name": "List lanes",
            "method": "GET",
            "url": f"{base}/captain/v1/lanes",
            "sortPriority": 60,
        },
        {
            "folder": "Captain",
            "name": "Recall episodes",
            "method": "GET",
            "url": f"{base}/v1/memory/captain-episodes",
            "urlParameters": [query_param("lane", "operator")],
            "sortPriority": 70,
        },
        {
            "folder": "Captain",
            "name": "Record episode",
            "method": "POST",
            "url": f"{base}/v1/memory/captain-episodes",
            **json_body(
                {
                    "schemaVersion": 1,
                    "episodeId": "yaak-ep-1",
                    "lane": "operator",
                    "targetId": "self",
                    "summary": "Tried the HTTP API from Yaak.",
                    "visibility": "operator_private",
                    "provenance": {
                        "characterId": "clankie",
                        "sessionId": "captain",
                        "selfAuthored": True,
                        "rawTranscript": False,
                    },
                    "occurredAt": "2026-08-15T20:00:00.000Z",
                }
            ),
            "sortPriority": 80,
        },
        {
            "folder": "Captain",
            "name": "Get body possession",
            "method": "GET",
            "url": f"{base}/v1/embodiment/possession",
            "sortPriority": 90,
        },
        {
            "folder": "Discord",
            "name": "Readiness",
            "method": "GET",
            "url": f"{base}/v1/discord/readiness",
            "sortPriority": 10,
        },
        {
            "folder": "Discord",
            "name": "Presence sessions",
            "method": "GET",
            "url": f"{base}/v1/discord/presence-sessions",
            "sortPriority": 20,
        },
        {
            "folder": "Discord",
            "name": "Voice history",
            "method": "GET",
            "url": f"{base}/v1/discord/voice-history",
            "urlParameters": [query_param("limit", "5")],
            "sortPriority": 30,
        },
        {
            "folder": "Discord",
            "name": "Get user-session opt-in",
            "method": "GET",
            "url": f"{base}/v1/discord/user-session/opt-in",
            "sortPriority": 40,
        },
        {
            "folder": "Discord",
            "name": "Voice briefing",
            "method": "POST",
            "url": f"{base}/v1/discord/voice-briefing",
            "description": "Needs the voice-bridge bearer, not the text one. Switch auth to discordVoiceToken.",
            "authenticationType": "bearer",
            "authentication": {"token": token_var("discordVoiceToken"), "prefix": "Bearer"},
            **json_body(
                {
                    "schemaVersion": 1,
                    "guildId": "${[ guildId ]}",
                    "channelId": "${[ channelId ]}",
                    "consentedUserIds": ["${[ userId ]}"],
                }
            ),
            "sortPriority": 50,
        },
        {
            "folder": "Discord",
            "name": "Presence action (typing)",
            "method": "POST",
            "url": f"{base}/v1/discord/presence-actions",
            "description": "Needs live-claim headers from a current presence session.",
            "headers": [
                {"name": "Content-Type", "value": "application/json", "enabled": True},
                {"name": "x-clankie-discord-presence-session", "value": "replace-me", "enabled": True},
                {"name": "x-clankie-discord-presence-phase", "value": "present", "enabled": True},
                {"name": "x-clankie-discord-presence-revision", "value": "1", "enabled": True},
            ],
            "bodyType": "application/json",
            "body": {
                "text": json.dumps(
                    {
                        "schemaVersion": 1,
                        "idempotencyKey": "yaak-typing-1",
                        "action": "discord.presence.typing_start",
                        "identity": {
                            "presenceSessionId": "replace-me",
                            "correlationId": "yaak-1",
                            "profileHash": "unversioned",
                            "characterId": "clankie",
                            "credentialRef": "discord_bot",
                            "transportKind": "bot",
                        },
                        "payload": {"kind": "typing_start", "channelId": "${[ channelId ]}"},
                    },
                    indent=2,
                )
            },
            "sortPriority": 60,
        },
        {
            "folder": "Discord",
            "name": "Channel turn",
            "method": "POST",
            "url": f"{base}/v1/captain/channel-turns",
            "description": "Submits a real Discord-shaped captain turn. Needs a live presence session id.",
            **json_body(
                {
                    "schemaVersion": 1,
                    "deliveryId": "yaak-delivery-1",
                    "identity": {
                        "presenceSessionId": "replace-me",
                        "correlationId": "yaak-1",
                        "profileHash": "unversioned",
                        "characterId": "clankie",
                        "credentialRef": "discord_bot",
                        "transportKind": "bot",
                    },
                    "trigger": {
                        "kind": "message",
                        "id": "1",
                        "channelId": "${[ channelId ]}",
                        "actorId": "${[ userId ]}",
                        "body": "hello from Yaak",
                    },
                }
            ),
            "sortPriority": 70,
        },
        {
            "folder": "Discord",
            "name": "Recall Discord person",
            "method": "GET",
            "url": f"{base}/v1/memory/discord-people/:guildId/:userId",
            "urlParameters": [
                path_param("guildId", "${[ guildId ]}"),
                path_param("userId", "${[ userId ]}"),
                query_param("query", "name"),
            ],
            "sortPriority": 80,
        },
        {
            "folder": "Embodiment",
            "name": "Live session",
            "method": "GET",
            "url": f"{base}/v1/embodiment/sessions/live",
            "sortPriority": 10,
        },
        {
            "folder": "Embodiment",
            "name": "Live activity",
            "method": "GET",
            "url": f"{base}/v1/embodiment/sessions/live/activity",
            "sortPriority": 20,
        },
        {
            "folder": "Embodiment",
            "name": "Get session",
            "method": "GET",
            "url": f"{base}/v1/embodiment/sessions/:id",
            "urlParameters": [path_param("id", "${[ sessionId ]}")],
            "authenticationType": "bearer",
            "authentication": {"token": token_var("captainToken"), "prefix": "Bearer"},
            "sortPriority": 30,
        },
        {
            "folder": "Embodiment",
            "name": "Start play (FireRed)",
            "method": "POST",
            "url": f"{base}/v1/embodiment/intents",
            "description": "Captain-auth. Starts a real play session if the body is free.",
            "authenticationType": "bearer",
            "authentication": {"token": token_var("captainToken"), "prefix": "Bearer"},
            **json_body(
                {
                    "kind": "start",
                    "schemaVersion": 1,
                    "intentId": "yaak-start-1",
                    "originLane": "operator",
                    "requestedBy": "local-operator",
                    "requestedAt": "2026-08-15T20:00:00.000Z",
                    "environmentId": "pokemon-firered",
                    "budget": {},
                }
            ),
            "sortPriority": 40,
        },
        {
            "folder": "Embodiment",
            "name": "Stop live session",
            "method": "POST",
            "url": f"{base}/v1/embodiment/sessions/live/stop",
            "description": "Operator kill-switch. Ordinary stop intent, not a kill.",
            "sortPriority": 50,
        },
        {
            "folder": "Embodiment",
            "name": "Claim work (runner)",
            "method": "POST",
            "url": f"{base}/v1/embodiment/claims",
            "authenticationType": "bearer",
            "authentication": {"token": token_var("runnerToken"), "prefix": "Bearer"},
            **json_body(
                {
                    "schemaVersion": 1,
                    "claimId": "yaak-claim-1",
                    "runnerId": "local",
                    "environmentIds": ["pokemon-firered", "pokemon-emerald"],
                }
            ),
            "sortPriority": 60,
        },
        {
            "folder": "Browser & media",
            "name": "Browser tools",
            "method": "GET",
            "url": f"{base}/v1/browser/tools",
            "sortPriority": 10,
        },
        {
            "folder": "Browser & media",
            "name": "Browser call",
            "method": "POST",
            "url": f"{base}/v1/browser/call",
            **json_body({"schemaVersion": 1, "tool": "browser_snapshot", "arguments": {}}),
            "sortPriority": 20,
        },
        {
            "folder": "Browser & media",
            "name": "Generate image",
            "method": "POST",
            "url": f"{base}/v1/media/images",
            "description": "Spends the configured image model. Prompt only; provider comes from settings.",
            **json_body(
                {
                    "schemaVersion": 1,
                    "prompt": "a small robot sitting at a terminal",
                    "aspectRatio": "1:1",
                }
            ),
            "sortPriority": 30,
        },
        {
            "folder": "Browser & media",
            "name": "Generate video",
            "method": "POST",
            "url": f"{base}/v1/media/videos",
            "description": "Starts a real render job if video is configured.",
            **json_body({"schemaVersion": 1, "prompt": "a small robot waving", "durationSeconds": 6}),
            "sortPriority": 40,
        },
        {
            "folder": "Pairing & devices",
            "name": "Mint pairing offer",
            "method": "POST",
            "url": f"{base}/v1/pairing/offer",
            "description": "One-time secret in the response. Do not commit it.",
            "sortPriority": 10,
        },
        {
            "folder": "Pairing & devices",
            "name": "Redeem offer",
            "method": "POST",
            "url": f"{base}/v1/pairing/redeem",
            "description": "Unauthenticated. The code or offer secret is the capability.",
            "authenticationType": "none",
            **json_body({"code": "123-456", "device": {"name": "Yaak", "platform": "macos"}}),
            "sortPriority": 20,
        },
        {
            "folder": "Pairing & devices",
            "name": "Complete pairing",
            "method": "POST",
            "url": f"{base}/v1/pairing/complete",
            "authenticationType": "none",
            **json_body(
                {
                    "completionToken": "replace-me",
                    "acceptedGrants": {
                        "chat": True,
                        "steer": True,
                        "terminalObserve": True,
                        "terminalControl": False,
                    },
                }
            ),
            "sortPriority": 30,
        },
        {
            "folder": "Pairing & devices",
            "name": "Device self",
            "method": "GET",
            "url": f"{base}/v1/devices/self",
            "authenticationType": "bearer",
            "authentication": {"token": token_var("deviceToken"), "prefix": "Bearer"},
            "sortPriority": 40,
        },
        {
            "folder": "Pairing & devices",
            "name": "Refresh device session",
            "method": "POST",
            "url": f"{base}/v1/devices/self/session/refresh",
            "authenticationType": "bearer",
            "authentication": {"token": token_var("deviceToken"), "prefix": "Bearer"},
            "sortPriority": 50,
        },
    ]

    for spec in requests:
        folder = spec.pop("folder")
        payload = {"workspaceId": workspace_id, "folderId": folders[folder], **spec}
        request_id = created_id(yaak("request", "create", "--json", json.dumps(payload)), "request")
        print(f"request {spec['name']} {request_id}")

    print()
    print(f"Yaak workspace: {WORKSPACE_NAME} ({workspace_id})")
    print(f"Environment:    Local ({environment_id})")
    print("Open Yaak and pick the Clankie workspace. Select the Local environment.")
    print("Safe first sends: Health, Presence status, List conversations, List lanes, Live session.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
