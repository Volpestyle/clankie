# ADR 0006: Provider-native structured adapters before terminal scraping

Status: accepted.

Use Codex App Server, Claude Agent SDK, and Pi RPC/SDK for machine control and semantic events. PTY is a fallback and human interface. Provider APIs are wrapped behind `WorkerAdapter` so their session/event changes do not leak into the mission protocol.
