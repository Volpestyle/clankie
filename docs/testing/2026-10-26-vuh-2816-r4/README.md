# VUH-2816 r4: bounded repairs after the single failed landing gate

The one GLOBAL-authorized root gate on approved source
`edaebbaa5ef6a987547f25d903b7757a87bda8b5` failed in `swallowed-rejections`,
exit1. Its log/JSON/driver remain byte-identical, pinned in this capture and
attached to [VUH-2816](https://linear.app/vuhlp/issue/VUH-2816) Resources as
`c77df8d2-59e6-4e7c-acec-29e3bea5a4fd`. No retry, revalidation or push followed.
The [r3 source proof](../2026-10-26-vuh-2816-r3/README.md) and approval apply only
to that earlier exact patch. This repair needs normal fresh review and another
GLOBAL GO before any new root gate/push. GLOBAL retains whole-issue closure.

## Traces and repairs

| Flagged catch                            | Reason and smallest repair                                                                                                                                                                                 | Consumer proof                                                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seat-routes.ts:166`, request JSON       | Malformed JSON must become schema400, never a binding. Reuse the already-imported canonical `readJson(context.req.raw)` used elsewhere in the routes.                                                      | Real HTTP malformed PUT returns `invalid_seat_binding`400; registry stays empty and no effects reach the downstream bank. Existing valid/native registration cases still pass. |
| `seat-binding.ts:94`, refusal body JSON  | The body only adds diagnostic detail; HTTP failure status is already reported even when JSON is unreadable. A single scoped rationale matches existing `update.ts` convention.                             | Real HTTP503 with malformed body still emits the refusal/status diagnostic. No blanket suppression or authority change.                                                        |
| `seat-binding.ts:128`, withdrawal DELETE | Silently dropping withdrawal hides cleanup failure. Warn on HTTP refusal/missing credential or transport failure, using only safe static text/status; cleanup still resolves so the harness exit survives. | Real HTTP503 and socket disconnect both produce a warning without printing nonce/bearer/body or rejecting cleanup. Red2fail8pass, green10pass.                                 |

## Verification

All checks governed by `clankie heavy`; no full root gate rerun:

- Swallowed-rejection focused preflight against `ffd2bafc471d3168da92a7ccff4d4b6610af1f4f`: red reproduces all3 locations; green reports none.
- Changed consumers:3files21tests pass (seat binding routes9, native lifecycle2, MCP/registration10). Both real native cases executed, not skipped.
- Launcher consumers:5files58tests pass (seat-command, OpenCode, harness commands, nonce confinement and Codex plugin).
- Changed-file typecheck and scoped lint/format pass.

Registry/MCP admission code and launcher nonce configuration are unchanged from
r3. Its exact registry SHA-256
`d3711065612be71e960f1f54aea182bf7e304f1211f9b09380ec59d4af353d92` and nonce
mutation proof remain valid; no need to repeat unchanged inputs. Source hashes,
commands and all new red/green logs are retained in the capture. Capture metadata
may name parentedaebbaa5 because publication precedes committing this repair.

Source review submission is held until GLOBAL confirms the fresh Aster reviewer
setting. A new root gate requires a new GLOBAL GO after approval. No consumer
assertion, authority/nonce/ancestry guard or gate was weakened. Native wrapper,
Prime and installed/original real-operator acceptance remain OPEN. No real
harness/service/inbox/broker/queue, credential/settings/account, rollout or eval
effects were performed.

Inspected archive: [exact failed gate, source hashes and focused red/green consumer proof](clankie://evidence/sha256/d4e89cdb83823b9ff81b6970d515eed3ae0c53ac95342cdd884e576fea41bef3).
