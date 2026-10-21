# VUH-2623: local-model context window on the first turn

Captured on 2026-10-21 on a scratch service (`scripts/scratch-stack.mjs`, private
HOME, state and credentials) running Ollama 0.30.10's installed `qwen3-vl:8b`
through a logging proxy. Both runs sent the same first message: "Hi Clankie.
Hire your first agent to look around this folder and tell me what it finds."
Herdr was disabled, so the hire failed and Clankie answered after several tool calls.

## Cause

Clankie's first request is 31,995 prompt tokens before any tool runs
(`first-request-breakdown.json`):

- 8,419 tokens: the system prompt (35,430 characters).
- 23,545 tokens: 103 tool schemas (119,582 characters; Minecraft's 23 tools
  alone are 20,641 characters).

Ollama's `/v1/models` reports no context length, so `/setup` declared every
model at the 32,768 fallback. That left no room. Pi also clamps each request's
`max_completion_tokens` to `contextWindow - estimate - 4096`, so every request
went out with `max_completion_tokens: 1`. Ollama ignores that field, but a
runtime that honours it would stop after one token.

## Before and after

|                                    | Before (5ee97f873)           | After                                  |
| ---------------------------------- | ---------------------------- | -------------------------------------- |
| Declared context for `qwen3-vl:8b` | 32,768                       | 262,144 (Ollama `/api/show`)           |
| First request prompt tokens        | 31,995                       | 31,996                                 |
| `max_completion_tokens` sent       | 1 on all 7 requests          | 8,192 on all 9 requests                |
| Context at end of turn             | 41,127 of 32,768 (over 100%) | 37,624 of 262,144 (14% used, 86% left) |

Files per run: `ollama-requests.jsonl` (each request body and Ollama's reported
usage), `context-events.jsonl` (the console footer's context events) and the
declared `clankie.json`.

## Not covered

The size of the fixed prompt is unchanged. A model or runtime whose real window
is below about 40k tokens still cannot hold Clankie's first turn. Ollama's
runtime context (`OLLAMA_CONTEXT_LENGTH`, or its memory-based default) can be
smaller than the native window `/api/show` reports. On this Mac, `/api/ps` showed
`qwen3-vl:8b` loaded at 262,144. A machine with less memory was not tested.
