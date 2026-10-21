# VUH-2647: send only usable tools, and respect Ollama's served context

Captured on 2026-10-21 on scratch services (`scripts/scratch-stack.mjs`, private
HOME, state and credentials) against Ollama 0.30.10 on this Mac, through the same
logging proxy as [VUH-2623](../vuh-2623-local-context-20261021/README.md).

## Tool trim

The same first message on `qwen3-vl:8b` on a fresh install, before and after
(`tool-trim/first-request-before-after.json`):

|                      | Before (43041e765) | After  |
| -------------------- | ------------------ | ------ |
| First-request prompt | 31,996             | 27,916 |
| Tools sent           | 103                | 70     |
| Tool schema chars    | 119,582            | 94,240 |
| System prompt chars  | 35,429             | 35,415 |

The 33 withheld tools are listed with their sizes in that file:

- 14 Minecraft play and administration tools, held until a server profile exists.
  The nine setup tools stay, so Clankie can still set up a world with its owner.
- 14 Discord body tools, held outside Discord rooms until a bot or user-session
  credential exists.
- 4 mailbox tools, held until a mailbox is connected.
- `linear_wake`, held while the tracker is the built-in fallback.

Each group returns on the next run after its service is set up; nothing restarts.

## Served context

Two temporary aliases of `qwen3-vl:8b` set `PARAMETER num_ctx` to 8192 and 65536. `/api/show` reports 262,144 for both, and Clankie declared both at 262,144.
Both aliases were deleted afterwards.

- **Before:** replaying Clankie's 31,996-token first request to the 8k alias
  returned HTTP 200 with `prompt_tokens: 8191` and `finish_reason: length`. Ollama
  silently dropped about three quarters of the prompt
  (`runtime-context/before-ctx8k-replay.json`).
- **After, 8k:** with the alias not loaded, Clankie loaded it, read 8,192 from
  `/api/ps` and failed the turn in 3 s, sending no chat request: "serves 8,192
  tokens of context, but Clankie's instructions and tools alone are about 29,039
  tokens …" (`runtime-context/conversation-events.jsonl`).
- **After, 64k:** the window narrowed from 262,144 to 65,536. The 26,541-token
  request went whole and the turn completed (`runtime-context/ctx64k-ollama-requests.jsonl`).

## Not covered

- The ~8.4k-token system prompt and the tools of connected or always-on services
  are unchanged. The largest of those are `hire_agent` (9k chars) and
  `propose_project_create` (6.9k).
- Neither `desktop` nor `generate_image`/`generate_video` is gated. The desktop
  pet has no presence signal, and the media tools refuse with the setup command.
- The fit check estimates four characters a token. For qwen3 that overcounts by
  about 10–20%.
- A low-memory Mac whose default `num_ctx` is small was simulated with a
  Modelfile, not tested on that hardware.
