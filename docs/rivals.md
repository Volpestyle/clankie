# Spider-Man through Rivals Agent

Rivals is an external game extension. Its Clankie-facing bridge (the `rivals`
tool, the shared play lease and exact-stop recovery) lives in the
[Rivals Agent repository](https://github.com/Volpestyle/rivals-agent) under
`clankie-extension/`, whose README covers setup, operation and verification.
Clankie's core keeps no Rivals code ([ADR 0175](adr/0175-rivals-agent-is-a-gameplay-skill.md),
[VUH-2419](https://linear.app/vuhlp/issue/VUH-2419)).

**The bridge is disabled.** [VUH-1325](https://linear.app/vuhlp/issue/VUH-1325)
tracks re-enabling it; installing the extension does not authorize a sitting.

Re-enabling needs no change here. From a Rivals Agent checkout on Clankie's machine:

```sh
cd ~/dev/rivals-agent/clankie-extension && pnpm install
clankie games extensions add ~/dev/rivals-agent/clankie-extension/src/index.ts url=http://127.0.0.1:4330
clankie restart
```

Then store the session server's token in the broker as `rivals-agent` (`/auth`,
**Add / update API key**, **Other…**). `clankie games extensions` lists `rivals`
once it has loaded. The [CLI reference](cli.md#games-extensions) describes
installing and removing extensions, and the
[module contract](../packages/game-extension/README.md#external-extensions) what
Clankie gives one.
