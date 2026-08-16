# docs/adr/0082-clankie-holds-the-browser.md

Browser reach joins the captain tool bank from the
live `agent-browser` MCP catalog. The Clankie
service hosts the full-action stdio server against
its own persistent profile; if unavailable, one
truthful `browser_unavailable` tool replaces the
catalog.

Read for the safety split from ADR 0095's system
tools. The persistent profile is
his (not the operator's) and is why `eval`,
`set_credentials`, and `get_cdp_url` are
approval-class; the registry is a closed list
(undeclared tools never project); risk classes
must match the live `tools/list` names. Enabled
by default; doctrine still decides what he may
call.
