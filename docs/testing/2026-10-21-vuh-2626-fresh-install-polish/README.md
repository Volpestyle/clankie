# VUH-2626: fresh-install polish

Same runs as VUH-2624 (`docs/testing/2026-10-21-vuh-2624-launch-folder`): the
published v0.4.9 archive (before) and `pnpm release:build` of this change (after),
each installed into a scratch HOME with a file credential store, its own ports
and Herdr off, launched in a private pty and walked through first-run `/setup`
with this Mac's Ollama (8 models, one of them `nomic-embed-text`).

## 1. Embedding model preselected

Ollama's `/api/show` lists each model's `capabilities`. A model that only embeds
(`["embedding"]`, no `completion`) cannot chat, so it is no longer declared.

| v0.4.9                                          | After                                   |
| ----------------------------------------------- | --------------------------------------- |
| 8 models, `nomic-embed-text:latest` preselected | 7 models, `qwen3.6:27b-mlx` preselected |

![before](clankie://evidence/sha256/4660f08548234764efb0dc9eb56ceacc131fe33965025c95b03a4b9be3af0b79)
![after](clankie://evidence/sha256/df5d9adb3bcb4f099a41a4119cdffe4b423ef080066fad2cb550d0af422f46d0)

## 2. Restart notice, then a 500

Setup restarts the service itself after a new endpoint, so the "Restart the
service (`clankie restart`)" line is left out there. `/provider` keeps it.

The 500 came from the console's parked live tail reaching the old service while
it shut down. In this run the error was the shutdown's own
`SeatLinkInterruptedError`; in the original report it was `Persona store is
closed`. The service now answers any conversation request that arrives after
shutdown begins with `503 service_restarting`. The console's tail retries that
the same way it retries a dropped connection.

![before](clankie://evidence/sha256/d4e997142982a20d0a65d1e78e166b948a0632f93cb89d6b35fe5af000a2ab66)
![after](clankie://evidence/sha256/617a6509f53a49990fcb42f672a6e41691be2f99fa7e851fc1445bf8d698053d)

The same race, run directly (`tailprobe.py`: park a tail, then `clankie restart
clankie`):

```
v0.4.9 (before): tail answer after 2.7 s: (500, Internal Server Error)
fixed build (after): tail answer after 2.6 s: (503, {"error":"service_restarting","message":"Clankie is restarting"})
```

After that extra restart, the console still showed no "Live conversation
unavailable".

## 3. Discord bridge on a fresh install

With no Discord application set up, the launcher no longer starts the bridge,
and status says so.

| v0.4.9                                                                                                                                    | After                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Bridge started and exited: "A brokered discord_bot API credential and DISCORD_APPLICATION_ID are required." (`before-discord-bridge.log`) | Not started; no bridge log                       |
| `clankie status`: see note                                                                                                                | `discord-bridge healthy · not set up — /discord` |

Note: in the before run, `clankie status` showed the bridge as "started outside
the launcher" rather than `unreachable`. It matched another Discord bridge
process already running on this Mac. On a clean machine it reports `unreachable`,
as in the original report.

The launcher reads `discord.applicationId` from settings, like the active body.
The console reads it again before it restarts anything, so a bot set up with
`/discord` in the same console is still started.

## 4. Version in log lines

Already fixed by VUH-2393 (`085ca7441`, first released in v0.4.7). Both runs log
`"version":"0.4.9"` on every line (`log-versions.txt`).

## Not covered

The 503 mapping covers the conversation dispatch only. Other routes that reach
a closing store during shutdown can still answer 500. Nothing in clankie-app
handles `service_restarting` yet, so the phone sees a 503 instead of a 500 during
a restart; how it then recovers was not tested.
