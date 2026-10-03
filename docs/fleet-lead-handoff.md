# Fleet lead handoff

Status: retired by [ADR 0213](adr/0213-clankie-retires-swarm.md).

The former coordinator-transfer runbook no longer applies. Clankie reaches
remote agents through native hires and the per-fleet link, documented in the
[CLI reference](cli.md#runtime-setup). Another project's lead retains its fleet
and authority; Clankie sends it context through a supported native channel.
Work and handoff evidence stay in the project's existing tracker or files.

Independent Swarm installations remain their owner's concern. Clankie neither
embeds a coordinator nor migrates their state.
