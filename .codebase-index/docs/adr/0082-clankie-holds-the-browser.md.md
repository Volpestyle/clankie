# docs/adr/0082-clankie-holds-the-browser.md

Web reach joins the one tool bank: `web_fetch` /
`web_search` return as framework tools, and
agent-browser becomes Clankie's own browser —
hosted as a stdio MCP server by the body-owning
process, reached through mediated routes, full
action set, one risk class per tool.

Read for the safety split: what was worth keeping
was "he cannot change the tree he is judged
against", not "no tools" — reading a web page
never threatened that. The persistent profile is
his (not the operator's) and is why `eval`,
`set_credentials`, and `get_cdp_url` are
approval-class; the registry is a closed list
(undeclared tools never project); risk classes
must match the live `tools/list` names. Enabled
by default; doctrine profile still decides what
he may call. Later amended by ADR 0086 (shell).
