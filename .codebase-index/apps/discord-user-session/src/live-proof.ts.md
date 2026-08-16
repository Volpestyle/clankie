# apps/discord-user-session/src/live-proof.ts

Evaluates live Discord evidence for user-session screen-share watching. `readUserSessionReceipts()` parses the receipt log and `evaluateStreamWatchLiveProof()` requires a watch plus a newer decoded still belonging to the same stream/user; discovery alone is insufficient.
