# Durable Pi room turns (VUH-2574)

Prototype recommendation: a local step journal around the existing Pi coding-agent
session, limited to one explicitly selected text-room lane. Native seats are out of
scope. This is a prototype, not a claim that every lane survives restarts.

## Comparison

| Option             | Fit with this checkout                                                                                                                                                                                                                                                                                                               | Self-hosted storage                                                                                                                                                                            | Cost / conclusion                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi Durable         | `@earendil-works/pi-durable` 1.0.0 shares pi-ai with our pinned `pi-coding-agent` 1.0.0, but replaces AgentSession with Harness, tasks, submissions and a registry. Its JSONL store is **not** the coding-agent SessionManager tree; existing resource loaders, hooks, compaction and transcript readers require adapters/migration. | Built-in SQLite and JSONL; memory is disposable. No Vercel dependency. One writer per storage.                                                                                                 | Best candidate for a later harness migration, but too large a compatibility change for a one-lane prototype.                                                                                                    |
| durable-harness    | The inspected `pi` adapter uses pi-agent-core 1.0.4 and reconstructs an Agent from model steps, rather than wrapping our coding-agent AgentSession. `pi-durable` is a Storage/queue adapter for Pi Durable, not a coding-session upgrade. Experimental 0.0.x.                                                                        | Workflow World: local files or self-hosted Postgres (also other World implementations). No managed Vercel requirement; gateway and Vercel Sandbox defaults are optional choices we must avoid. | Adds queue, fencing and stream infrastructure useful for distributed workers. It does not remove our session migration or delivery-reconciliation work. Excess machinery for a single persistent local service. |
| Local step journal | Keep pi-coding-agent/pi-ai 1.0.0, resource loader, authorization, tools, native JSONL tree and existing room delivery receipts. Save the session file/leaf at admission; after process death branch there and replay committed model/tool results.                                                                                   | Private files under the existing Clankie state root; sync durable writes before effects. No new network dependency. Single private service owner.                                              | Chosen for the bounded prototype. We own admission, replay validation, corruption handling and recovery. Do not expand it into a second general harness without revisiting Pi Durable.                          |

All approaches must distinguish an effect that completed from an intent whose
outcome was never recorded. None can atomically commit a Discord/Linear mutation
and a local journal record. `never` means **do not automatically execute that
interrupted call again**, not that the first effect definitely failed. A model
must inspect its receipt before deciding what to do next. Completed calls always
return their stored result, regardless of replay policy.

## Tool replay policy

Use a small exact allowlist; unknown and mixed-operation tools default to `never`.
Do not infer safety from a tool's name containing `get`, its schema, or model text.
Existing permission and audience checks still apply after restart.

| Tool / operation                                                                                                    | Interrupted replay                                                  | Reason                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`, `memory` with `action: search`, `get_self_state`, `agent_sessions`, `agent_session_read`, `mcp_tool_search` | safe                                                                | Repeatable observations; a fresh result may differ.                                                                                                        |
| Connected Linear get/list/search reads                                                                              | safe only after an explicit adapter audit; prototype defaults never | Some generic transports combine reads and writes; classify the exact operation, not the wrapper.                                                           |
| Discord `send_text_update`, Discord actions (send/edit/delete/react), final reply publication                       | never                                                               | An accepted send can lose its acknowledgment. Final reply uses the existing stable delivery key and receipt/reconciliation path, not a generic tool retry. |
| `message_seat`, `hire_agent`, `readopt_seat`, `huddle`, `settle_hire_receipt`, worker reports                       | never                                                               | Native delivery or hiring may already have happened; consult original receipt.                                                                             |
| Linear create/update/comment/delete and generic `mcp_tool_call` / connected tools                                   | never                                                               | External mutations; uncertain calls must be read back by receipt/record.                                                                                   |
| `memory` with `action: write`, `edit`, or `forget`                                                                  | never                                                               | Append, revision and deletion can already have committed. Only the exact memory search operation is safe.                                                  |
| `bash`, `write`, `edit`, joined-machine shell, browser actions/code, gameplay actions                               | never                                                               | Arbitrary effects or non-idempotent state transitions. No automatic shell replay.                                                                          |
| Timers, watches, settings, runtime updates, connections, file publication, questions, house-hunting mixed adapter   | never                                                               | Scheduling, outreach, process changes or mixed effects; need operation-specific reconciliation before promotion.                                           |

## Reference review

- [Vercel post](https://vercel.com/blog/making-every-harness-durable): intent/outcome log plus queue backstop, replay safe/never, self-hosted World. Read from the site's HTML after the web reader failed.
- [durable-harness source at fb056a3](https://github.com/vercel-labs/durable-harness/tree/fb056a3c08549fdad9b87ed8358a27e2097ded11): inspected `packages/harness-pi`, `packages/pi-world`, and the public `pi` adapter. Revision recorded with the prototype evidence.
- [Pi Durable 1.0.0 source](https://github.com/earendil-works/pi/tree/v1.0.0/packages/durable): Harness/Storage/registry contract and safe/never semantics; separate from coding-agent's session tree.
- [Alejandro AO tutorial](https://x.com/_alejandroao/status/2112112346462089276): read the video's English auto-captions fetched through X's public syndication/HLS subtitle URLs. Chapters: 1:48 checkpoints/crash recovery; 8:38 harness vs app; 13:46 architecture/storage; 19:30 six setup steps; 23:11 local Qwen/llama.cpp and restart. The tutorial emphasizes that the application owns its gateways/conversation identity, Durable is a building block, and its JSONL differs from coding-agent sessions. Its SQLite restart demo illustrates recovery, not exactly-once external effects.

The prototype must kill only its private service, exercise the public channel-turn
HTTP route with real Pi and a real model dependency, persist an external tool
effect, recover without another input, and observe one final public HTTP reply result through a
stable delivery ID. The lead approved this boundary because no Discord destination
is authorized; the actual Discord-mouth hop remains unproven. Scripted provider responses are useful boundary checks but
are not evidence for the requested real-model E2E.
