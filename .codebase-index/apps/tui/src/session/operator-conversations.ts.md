# apps/tui/src/session/operator-conversations.ts

Authenticated client and durable per-surface state for the service-owned operator conversation contract. It validates server responses, securely persists selected conversation and opaque cursors, restores unread events, submits revision-fenced messages with Herdr seat context, and tails accepted runs without cancelling them when observation detaches.
