import { runSeatChannel } from "../../../../integrations/claude-plugin/worker/bin/seat-channel.mjs";

// The real shipped stdio bridge, with a shorter owned-test startup deadline.
runSeatChannel({ paneId: "w1:p1", parentArgv: "codex app-server", requestTimeoutMs: 4_000 });
