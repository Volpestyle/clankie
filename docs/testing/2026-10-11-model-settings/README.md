# VUH-2110: named model settings in TUI and CLI

Tracks: https://linear.app/vuhlp/issue/VUH-2110

The CLI’s existing JSON model status now includes a plain `display` summary from the shared settings read. The TUI presents that same summary and funding/rate-unavailable hints before its eligible model chooser. Automatic mapped routing is read-only. Selecting the prior eligible provider/model through the existing API restores a preference.

## Verification

- Focused model CLI and TUI provider-command consumers: 37 tests passed.
- TUI TypeScript source and affected test programs: passed.
- Real device/CLI HTTP integration in the sibling app: passed selection, rejection of an unsupported choice, cross-client reads and restoration over the real model adapter and routes.
- Live read-only `node apps/tui/bin/clankie.ts model status` through heavy: exit 0. Its actual shared settings display names GPT-6.1 Sol / OpenAI Codex, own-provider funding and mapped conversation/Discord/gameplay models. No live preference was changed. Retained display transcript follows.

## Limits

Credit rates and included eligibility are not invented. TUI verification is focused consumer execution and the live CLI read, not a screenshot of a deployed TUI. No provider generation, eval, account change or release was performed. App/native and dashboard proof lives in the sibling repositories’ same dated evidence folder.

```text
2026-10-11 live read-only proof
Command: clankie heavy -- node apps/tui/bin/clankie.ts model status
Exit: 0
Actual shared-API display:
GPT-6.1 Sol · OpenAI Codex · Your own provider
Credit rates are unavailable. Input, output and cached usage rates cannot be compared yet.
Clankie routes each turn automatically. Your choice applies to new turns.
Your conversations: GPT-6.1 Sol · OpenAI Codex
Discord chat: GPT-6.1 Sol · OpenAI Codex
Discord tasks: GPT-6.1 Sol · OpenAI Codex
Gameplay: GPT-6.1 Sol · OpenAI Codex
No live model preference was changed.
```
