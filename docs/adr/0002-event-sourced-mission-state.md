# ADR 0002: Event-sourced mission state

Status: accepted.

Typed semantic events are the audit and synchronization backbone. Relational projections may be rebuilt from them. Raw terminal streams and provider transcripts are diagnostic attachments, not authoritative state. Every event includes mission, correlation, and doctrine identity.
