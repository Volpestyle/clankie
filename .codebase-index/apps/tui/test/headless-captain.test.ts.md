# apps/tui/test/headless-captain.test.ts

`clankie health|status|restart|down` end to end
through `runHeadlessCaptainCommand`: real ephemeral
HTTP servers as the service probe target, fake
spawn/kill/process-table seams, file credential
stores in temp XDG state dirs. Asserts the JSON
document shape, exit codes, operator-credential
consistency reporting, and service outcome lists.
