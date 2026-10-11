# VUH-2129: concurrent conversation browsers

Tracks: https://linear.app/vuhlp/issue/VUH-2129

Real local Chrome proof through `callConversationBrowser`, the production
conversation authority/router entrypoint, and the Browser Use Pi host. Two
host-bound conversation identities (`console`, `discord-room`) share one private
profile authenticated to a local HTTP fixture. This exercises browser execution,
not Discord message delivery or production accounts. No model/eval runs, mocked
browser, or live service restart were used.

## Observed result

- Both conversations reached delayed pages concurrently: server maximum active
  requests **2**, elapsed **1,219 ms** for two 1,200 ms navigations. Different
  Chrome target IDs; each returned its own page text.
- Two calls in one conversation produced server maximum active requests **1**.
- Both conversations saw the fixture's signed-in identity, with separate
  JavaScript variables. `isolated: true` saw logged-out state.
- Closing the console left the room's page and login usable. After idle cleanup,
  a fresh room retained persistent login state; no browser body claim existed.
- Closing Chrome through root CDP, including a workspace-created extra tab,
  recovered through the sole lifecycle owner. A later conversation browsed with
  the persisted login. Browser effects were not replayed.

`proof.json` retains requests, timestamps, tool results, target IDs and the final
passed assertions. `proof-driver.ts` is the exact driver (restore it to
`.local/browser-proof.ts` to rerun with
`clankie heavy -- pnpm --filter @clankie/clankie exec tsx ../../.local/browser-proof.ts`).
It creates and cleans its own profile and HTTP server; idle is shortened to 8s.

## Checks

- Final focused run: **8 files, 55 tests passed**, including browser authority,
  Pi/CLI consumers, HTTP/body routing, legacy claim migration, Minecraft service,
  and conversation identity. Full command/output: `focused-tests.log`.
- Body recovery, room mouth and request-pump consumers: **4 files, 48 tests passed**
  during iteration, including the browser host; unchanged lease inputs remain
  covered by that run.
- Service package typecheck passed (source and all 12 test partitions). Final
  source-only check passed after browser cleanup/recovery changes. Logs:
  `package-typecheck.log`, `source-typecheck.log`.
- Formatter ran on every touched file. Integration supplies the landing gate.

Based on fetched `origin/main` at `4ffbc7eb3cfb684258643e47afc67e5f3ab4dce8`.
`source-hashes.json` identifies the inspected source tree. Raw evidence lives in
the evidence store; only this README and its receipt are committed.

## Failure retained and correction

Earlier captures retain failed persistence checks. The first used a session-only
fixture cookie; subsequent persistent-cookie runs exposed Chrome shutdown before
its profile flush finished. Shutdown now requests `Browser.close`, waits up to
5s for the exact endpoint's browser process to exit, then lets the SDK reap it.
Cleanup also verifies remaining targets before closing them, and retires crashed
workers after stopping the lifecycle owner, so already-lost tabs cannot block
recovery. Final proof passed all assertions.

No open implementation decision. Live Discord delivery and existing production
logins were not part of this local proof.

## Evidence file

[Evidence bundle](bundle.json) contains the exact named JSON, driver and log
files described above, plus all three retained failed runs. Smaller text files
are bundled together for the evidence store's 16 KiB upload threshold.
