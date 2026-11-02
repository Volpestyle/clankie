// Stands in for the Codex TUI a desktop-app terminal execs in its place: it takes the view's
// arguments (`--remote <endpoint> ...`) and stays up until it is told to end.
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60_000);
