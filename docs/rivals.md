# Spider-Man through Rivals Agent

Rivals is an external game extension. Its Clankie-facing bridge (the `rivals`
tool, the shared play lease and exact-stop recovery) lives in the
[Rivals Agent repository](https://github.com/Volpestyle/rivals-agent) under
`clankie-extension/`, whose README covers setup, operation and verification.
Clankie's core keeps no Rivals code ([ADR 0175](adr/0175-rivals-agent-is-a-gameplay-skill.md),
[VUH-2419](https://linear.app/vuhlp/issue/VUH-2419)).

**The bridge is disabled.** [VUH-1325](https://linear.app/vuhlp/issue/VUH-1325)
tracks re-enabling it; installing the extension does not authorize a sitting.

Re-enabling needs no change here. Install it from a pinned Rivals Agent commit
([outside extensions](cli.md#outside-extensions), ADR 0338):

```sh
clankie extensions add https://github.com/Volpestyle/rivals-agent.git \
  --commit cdf6aa740a1c84f3d8a912726894fcabcd7b2145 --path clankie-extension \
  --id rivals --entry src/index.ts --grant all url=http://127.0.0.1:4330
clankie restart
```

`--id` and `--entry` stand in for the manifest Rivals does not ship yet; once its
`clankie-extension/clankie-extension.json` lands, they are not needed. A local
checkout works the same way: `clankie extensions add
~/dev/rivals-agent/clankie-extension --id rivals --entry src/index.ts --grant all
url=...`. An install made earlier with `clankie games extensions add` moves to
`installedExtensions` at the next start.

Then store the session server's token in the broker as `rivals-agent` (`/auth`,
**Add / update API key**, **Other…**). `clankie extensions` lists `rivals` as
`running` once it has loaded, and `clankie extensions off rivals` keeps it off
from the next start. The [module contract](../packages/extension/README.md#outside-extensions)
describes what Clankie gives one.
